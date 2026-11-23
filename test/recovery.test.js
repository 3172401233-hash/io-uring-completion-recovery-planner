import test from 'node:test';
import assert from 'node:assert/strict';
import { planRecovery, CancelResult, Verdict } from '../src/recovery.js';

const write = (seq, userData, extra = {}) => ({
  seq,
  userData,
  type: 'write',
  offset: seq * 4096,
  length: 4096,
  durable: false,
  ...extra,
});

const cancel = (seq, userData, targetUserData, cancelResult) => ({
  seq,
  userData,
  type: 'cancel',
  targetUserData,
  cancelResult,
});

test('完成事件确认全部写入:可确认', () => {
  const plan = planRecovery({
    submissions: [write(1, 'a')],
    completions: [{ userData: 'a', result: 4096 }],
    restartPoint: 1,
  });
  assert.equal(plan.confirmable.length, 1);
  assert.equal(plan.confirmable[0].userData, 'a');
  assert.equal(plan.retryable.length, 0);
});

test('完成事件丢失:不能认定未执行,普通写进入未知列表', () => {
  const plan = planRecovery({
    submissions: [write(1, 'lost')],
    completions: [],
    restartPoint: 1, // 已进 SQ 但进程被杀,CQ 事件随进程丢失
  });
  assert.equal(plan.unknown.length, 1);
  assert.equal(plan.unknown[0].userData, 'lost');
  assert.equal(plan.retryable.length, 0, '缺少完成事件不得直接重试');
});

test('完成事件丢失且带持久化标记:必须隔离', () => {
  const plan = planRecovery({
    submissions: [write(1, 'durable-write', { durable: true })],
    completions: [],
    restartPoint: 1,
  });
  assert.equal(plan.isolated.length, 1);
  assert.equal(plan.isolated[0].userData, 'durable-write');
});

test('seq 晚于重启点:确定从未提交,可安全重试', () => {
  const plan = planRecovery({
    submissions: [write(5, 'never-sent')],
    completions: [],
    restartPoint: 3,
  });
  assert.equal(plan.retryable.length, 1);
  assert.equal(plan.retryable[0].userData, 'never-sent');
});

test('取消晚到:目标已完成,取消无效,目标可确认', () => {
  const plan = planRecovery({
    submissions: [write(1, 'w'), cancel(2, 'c', 'w', CancelResult.ALREADY_DONE)],
    completions: [{ userData: 'w', result: 4096 }],
    restartPoint: 2,
  });
  const confirmed = plan.confirmable.map((r) => r.userData);
  assert.deepEqual(confirmed, ['w', 'c']);
  assert.equal(plan.unknown.length, 0);
});

test('取消成功且目标无完成事件:目标可重试', () => {
  const plan = planRecovery({
    submissions: [write(1, 'w'), cancel(2, 'c', 'w', CancelResult.CANCELLED)],
    completions: [],
    restartPoint: 2,
  });
  assert.equal(plan.retryable.length, 1);
  assert.equal(plan.retryable[0].userData, 'w');
  assert.equal(plan.confirmable[0].userData, 'c');
});

test('取消结果不明(NOT_FOUND)且完成事件缺失:取消进未知,目标写若持久化则隔离', () => {
  const plan = planRecovery({
    submissions: [
      write(1, 'w', { durable: true }),
      cancel(2, 'c', 'w', CancelResult.NOT_FOUND),
    ],
    completions: [],
    restartPoint: 2,
  });
  assert.equal(plan.unknown.length, 1);
  assert.equal(plan.unknown[0].userData, 'c');
  assert.equal(plan.isolated.length, 1);
  assert.equal(plan.isolated[0].userData, 'w');
});

test('重复 user_data:涉及的所有操作必须隔离,不得复用', () => {
  const plan = planRecovery({
    submissions: [write(1, 'dup'), write(2, 'dup', { offset: 8192 })],
    completions: [{ userData: 'dup', result: 4096 }],
    restartPoint: 2,
  });
  assert.equal(plan.isolated.length, 2);
  assert.deepEqual(plan.isolated.map((r) => r.seq), [1, 2]);
  assert.equal(plan.confirmable.length, 0, '完成事件无法归属,不得确认');
});

test('部分写入:只重试剩余区间,偏移量前进已写字节数', () => {
  const plan = planRecovery({
    submissions: [write(1, 'partial', { offset: 0, length: 4096 })],
    completions: [{ userData: 'partial', result: 1024 }],
    restartPoint: 1,
  });
  assert.equal(plan.retryable.length, 1);
  const retry = plan.retryable[0];
  assert.equal(retry.resumeOffset, 1024);
  assert.equal(retry.resumeLength, 3072);
});

test('失败完成事件(负结果):可整体重试', () => {
  const plan = planRecovery({
    submissions: [write(1, 'failed')],
    completions: [{ userData: 'failed', result: -5 }],
    restartPoint: 1,
  });
  assert.equal(plan.retryable.length, 1);
  assert.equal(plan.retryable[0].verdict, Verdict.RETRYABLE);
});

test('重建顺序:隔离 -> 确认 -> 按 seq 重试 -> 恢复提交', () => {
  const plan = planRecovery({
    submissions: [
      write(1, 'ok'),
      write(2, 'lost', { durable: true }),
      write(3, 'gone'),
      write(9, 'fresh'),
    ],
    completions: [{ userData: 'ok', result: 4096 }],
    restartPoint: 3,
  });
  assert.deepEqual(plan.rebuildOrder.map((s) => s.action), [
    'isolate',
    'confirm',
    'retry',
    'resume',
  ]);
  const [isolate, confirm, retry, resume] = plan.rebuildOrder;
  assert.deepEqual(isolate.userData, ['lost', 'gone']); // 隔离在前,未知随后
  assert.deepEqual(confirm.userData, ['ok']);
  assert.deepEqual(retry.userData, ['fresh']);
  assert.match(resume.detail, /seq 4/);
});

test('交错场景:确认/重试/未知/隔离同时存在且互不串扰', () => {
  const plan = planRecovery({
    submissions: [
      write(1, 'done'),
      write(2, 'half', { offset: 0, length: 8192 }),
      write(3, 'missing'),
      write(4, 'cancelled-write'),
      cancel(5, 'cancel-ok', 'cancelled-write', CancelResult.CANCELLED),
      write(6, 'dup'),
      write(7, 'dup'),
    ],
    completions: [
      { userData: 'done', result: 4096 },
      { userData: 'half', result: 2048 },
    ],
    restartPoint: 7,
  });
  assert.deepEqual(plan.confirmable.map((r) => r.userData), ['done', 'cancel-ok']);
  assert.deepEqual(plan.retryable.map((r) => r.userData), ['half', 'cancelled-write']);
  assert.deepEqual(plan.unknown.map((r) => r.userData), ['missing']);
  assert.deepEqual(plan.isolated.map((r) => r.seq), [6, 7]);
});
