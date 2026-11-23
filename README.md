# io-uring-completion-recovery-planner

恢复 io_uring 提交队列、完成队列和取消事件。

> **重要说明:本项目所有 ring 状态(SQ、CQ、取消结果、重启点)均为本地模拟。**
> 代码不创建、不读写任何真实的内核 io_uring 实例,仅根据输入的提交记录与
> 完成事件做纯函数式的恢复规划,用于演练进程被强制终止后的恢复决策。

## 背景

进程使用 io_uring 提交大量异步写入后被强制终止时:

- SQ 中部分请求已经提交,可能已执行也可能未执行;
- CQ 中部分完成事件尚未消费,随进程一并丢失;
- 取消请求与普通写请求交错出现,取消结果各不相同。

**不能因 CQ 中缺少事件就认定请求未执行**——事件可能只是没被消费。
**同一 `user_data` 也不能被不同操作复用**——否则完成事件无法归属。

## 输入

`planRecovery({ submissions, completions, restartPoint })`(见 `src/recovery.js`):

- `submissions`:提交记录,含提交序号 `seq`、`userData`、请求类型
  (`write` / `cancel`)、文件偏移 `offset`、长度 `length`、持久化标记
  `durable`;取消请求另含 `targetUserData` 与 `cancelResult`
  (`0` 取消成功 / `-1` 取消晚到 / `-2` 目标未找到)。
- `completions`:CQ 中尚未消费的完成事件 `{ userData, result }`,
  `result >= 0` 为已写字节数,负值为错误码。
- `restartPoint`:ring 重启点。`seq <= restartPoint` 的请求在进程被杀前
  已进入 SQ;`seq > restartPoint` 的请求确定从未提交。

## 输出

- `confirmable`:可确认——完成事件证实全部写入,或取消结论明确。
- `retryable`:可重试——确定未提交、确定被取消、已失败,或部分写入
  (只重试剩余区间,`resumeOffset` / `resumeLength` 已换算)。
- `unknown`:未知——完成事件缺失,不能认定未执行,需核对落盘状态后再决定。
- `isolated`:必须隔离——`user_data` 被复用导致事件无法归属,或带持久化
  标记 / 取消结论不明的写操作落盘状态不可判定,盲目重试可能重复写。
- `rebuildOrder`:重建 ring 的顺序——
  1. `isolate`:隔离未知与冲突操作,核对前不得重发;
  2. `confirm`:登记可确认结果,不占新 ring 资源;
  3. `retry`:按 `seq` 升序重发,必须分配**全新** `user_data`;
  4. `resume`:从 `restartPoint + 1` 起恢复正常提交。

## 测试

```sh
node --test
```

覆盖:完成事件丢失、取消晚到、取消成功、取消结果不明、重复 `user_data`、
部分写入、失败完成事件、重建顺序与交错混合场景。
