// io_uring 崩溃恢复规划器(纯本地模拟,不触碰真实内核 ring)。
//
// 输入:提交记录(SQ 侧)、完成事件(CQ 侧)、ring 重启点。
// 输出:可确认 / 可重试 / 未知 / 必须隔离 的操作分类,以及重建 ring 的顺序。

export const OpType = Object.freeze({
  WRITE: 'write',
  CANCEL: 'cancel',
});

// 取消请求的结果码(模拟内核语义)
export const CancelResult = Object.freeze({
  CANCELLED: 0, // 目标尚未执行,已被取消
  ALREADY_DONE: -1, // 目标已完成或正在执行,取消太晚(-EALREADY)
  NOT_FOUND: -2, // 未找到目标(-ENOENT),目标可能早已完成
});

export const Verdict = Object.freeze({
  CONFIRMABLE: 'confirmable', // 可确认:结果已知
  RETRYABLE: 'retryable', // 可重试:确定未生效或部分生效
  UNKNOWN: 'unknown', // 未知:不能假设未执行,需人工/落盘核对
  ISOLATED: 'isolated', // 必须隔离:user_data 冲突或持久化状态不可判定
});

function makeRecord(submission, verdict, reason, extra = {}) {
  return {
    seq: submission.seq,
    userData: submission.userData,
    type: submission.type,
    verdict,
    reason,
    ...extra,
  };
}

/**
 * 规划恢复。
 *
 * @param {object} input
 * @param {Array<object>} input.submissions 提交记录,按 seq 升序或乱序均可。
 *   write: { seq, userData, type:'write', offset, length, durable }
 *   cancel:{ seq, userData, type:'cancel', targetUserData, cancelResult }
 * @param {Array<object>} input.completions CQ 中尚未消费的完成事件:
 *   { userData, result } result>=0 为已写字节数,result<0 为错误码。
 * @param {number} input.restartPoint ring 重启点:seq <= restartPoint 的
 *   请求在进程被杀前已进入 SQ(可能已执行,也可能没有);seq > restartPoint
 *   的请求确定从未提交。
 */
export function planRecovery({ submissions = [], completions = [], restartPoint = 0 }) {
  const completionByUserData = new Map();
  for (const c of completions) {
    if (!completionByUserData.has(c.userData)) {
      completionByUserData.set(c.userData, c);
    }
  }

  // 同一 user_data 不得被不同操作复用:一旦发生,内核返回的完成事件
  // 将无法归属,涉及的所有操作都必须隔离。
  const submissionsByUserData = new Map();
  for (const s of submissions) {
    const list = submissionsByUserData.get(s.userData) ?? [];
    list.push(s);
    submissionsByUserData.set(s.userData, list);
  }
  const duplicatedUserData = new Set(
    [...submissionsByUserData.entries()]
      .filter(([, list]) => list.length > 1)
      .map(([userData]) => userData),
  );

  // 先解析取消请求,得到每个目标 user_data 的取消结论。
  const cancelVerdicts = new Map(); // targetUserData -> { cancelled, lateCancel, ambiguous }
  const cancelRecords = [];
  for (const s of submissions) {
    if (s.type !== OpType.CANCEL) continue;
    if (duplicatedUserData.has(s.userData)) continue; // 自身已隔离,后面统一处理
    const targetDone = completionByUserData.has(s.targetUserData);
    const prev = cancelVerdicts.get(s.targetUserData) ?? {
      cancelled: false,
      lateCancel: false,
      ambiguous: false,
    };
    if (s.cancelResult === CancelResult.CANCELLED && !targetDone) {
      prev.cancelled = true;
      cancelRecords.push(
        makeRecord(s, Verdict.CONFIRMABLE, '取消成功:目标在执行前被拦截', {
          targetUserData: s.targetUserData,
        }),
      );
    } else if (s.cancelResult === CancelResult.ALREADY_DONE || targetDone) {
      // 取消晚到:目标已经完成(或已在执行),取消无效但不造成歧义。
      prev.lateCancel = true;
      cancelRecords.push(
        makeRecord(s, Verdict.CONFIRMABLE, '取消晚到:目标已完成,取消未生效', {
          targetUserData: s.targetUserData,
        }),
      );
    } else {
      // NOT_FOUND 且 CQ 无事件:目标可能早已完成且事件被消费,
      // 也可能仍在飞。不能据 CQ 缺失断定未执行。
      prev.ambiguous = true;
      cancelRecords.push(
        makeRecord(s, Verdict.UNKNOWN, '取消结果不明确:目标完成事件缺失,无法判定', {
          targetUserData: s.targetUserData,
        }),
      );
    }
    cancelVerdicts.set(s.targetUserData, prev);
  }

  const confirmable = [];
  const retryable = [];
  const unknown = [];
  const isolated = [];

  for (const s of submissions) {
    if (duplicatedUserData.has(s.userData)) {
      isolated.push(
        makeRecord(s, Verdict.ISOLATED, 'user_data 被多个操作复用,完成事件无法归属'),
      );
      continue;
    }
    if (s.type === OpType.CANCEL) continue; // 已在上面处理

    const completion = completionByUserData.get(s.userData);
    if (completion) {
      if (completion.result < 0) {
        retryable.push(
          makeRecord(s, Verdict.RETRYABLE, `请求已失败(错误码 ${completion.result}),可整体重试`),
        );
      } else if (completion.result < s.length) {
        // 部分写入:只重试剩余区间,偏移量前进 result 字节。
        retryable.push(
          makeRecord(s, Verdict.RETRYABLE, `部分写入 ${completion.result}/${s.length} 字节,重试剩余部分`, {
            resumeOffset: s.offset + completion.result,
            resumeLength: s.length - completion.result,
          }),
        );
      } else {
        confirmable.push(makeRecord(s, Verdict.CONFIRMABLE, '完成事件确认全部写入'));
      }
      continue;
    }

    const cancel = cancelVerdicts.get(s.userData);
    if (cancel?.cancelled) {
      retryable.push(makeRecord(s, Verdict.RETRYABLE, '已确认在执行前被取消,可安全重试'));
      continue;
    }
    if (s.seq > restartPoint) {
      retryable.push(makeRecord(s, Verdict.RETRYABLE, 'seq 晚于重启点,确定从未提交'));
      continue;
    }

    // CQ 缺少事件不等于未执行:请求可能已落盘但事件随进程丢失。
    if (cancel?.ambiguous || s.durable) {
      // 带持久化标记或取消结论不明的写操作:落盘状态不可判定,
      // 盲目重试可能造成重复写或破坏 fsync 语义,必须隔离核对。
      isolated.push(
        makeRecord(
          s,
          Verdict.ISOLATED,
          cancel?.ambiguous
            ? '取消结果不明且完成事件缺失,落盘状态不可判定'
            : '持久化写操作完成事件缺失,须先核对落盘状态',
        ),
      );
    } else {
      unknown.push(
        makeRecord(s, Verdict.UNKNOWN, '完成事件缺失,不能认定未执行,需核对后再决定'),
      );
    }
  }

  for (const record of cancelRecords) {
    if (record.verdict === Verdict.CONFIRMABLE) confirmable.push(record);
    else unknown.push(record);
  }

  const bySeq = (a, b) => a.seq - b.seq;
  confirmable.sort(bySeq);
  retryable.sort(bySeq);
  unknown.sort(bySeq);
  isolated.sort(bySeq);

  // 重建 ring 的顺序:先隔离不可判定的操作,再确认已知结果,
  // 然后按原始 seq 顺序以全新 user_data 重发可重试请求,最后恢复新提交。
  const rebuildOrder = [
    {
      step: 1,
      action: 'isolate',
      detail: '隔离未知与冲突操作,核对落盘状态前不得重发',
      userData: [...isolated, ...unknown].sort(bySeq).map((r) => r.userData),
    },
    {
      step: 2,
      action: 'confirm',
      detail: '登记可确认操作的结果(含取消结论),不占用新 ring 资源',
      userData: confirmable.map((r) => r.userData),
    },
    {
      step: 3,
      action: 'retry',
      detail: '按 seq 升序重发可重试操作,必须分配全新 user_data',
      userData: retryable.map((r) => r.userData),
    },
    {
      step: 4,
      action: 'resume',
      detail: `从 seq ${restartPoint + 1} 起恢复正常提交`,
      userData: [],
    },
  ];

  return { confirmable, retryable, unknown, isolated, rebuildOrder };
}
