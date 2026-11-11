/**
 * watch-pause.test.mjs — 窗口上的 ⏸/▶（issue #56 第 3 条）。
 *
 * 语义是"**只停采集，窗留着**"：时钟冻住、不叫醒模型、不念词；按 ▶ 从当前进度
 * 接着看，暂停那段**不补**。和 `✕` 必须分开 —— 那是"不看了"（停采集 + 落挂断），
 * 按一次就得重新调工具才回来。
 *
 * 这里只验边界（暂停后一拍里什么都不做、老动作不重放、恢复会重锚），不验像素。
 */
process.env.DSH_WATCH_REQUIRE_LINES = '0';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 换片那条路会往 cache 目录推一条 control 事件 —— 别写进本机真实的 ~/.dsh
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-pause-'));

import { loopStatus, startWatchLoop, stopWatchLoop } from '../src/watch-loop.js';

const ctxStub = { sessionController: { prompt: async () => {} } };
// 用真墙钟：`estimate()` 内部按 `Date.now()` 算外推，虚拟时间会让 pos 多飘 60 秒
const T0 = Date.now();

/**
 * 手动发条的循环：`fire()` 跑一拍。
 * `readActions` 从 `state.actions` 读 —— 想模拟"窗口按了按钮"就往里 push 一条。
 */
function harness(actions = []) {
  const state = { wakes: 0, actions: [...actions], t: T0, pos: 10, videoPaused: false };
  const ticker = (o) => {
    state.fire = o.tick;
    return { everyMs: o.everyMs, dispose() { state.fire = null; } };
  };
  const r = startWatchLoop({
    ctx: ctxStub,
    sessionId: 's-pause',
    input: 'pause.mp4',
    segment: 60,
    ramp: [],
    cursor: 10,
    // 探针只在给了调试端口时才读浏览器（这条是"不默认读 9222"的规矩，harness 要跟着它）
    browserPort: 9222,
    deps: {
      ticker,
      now: () => state.t,
      readActions: () => state.actions,
      windowAlive: () => true,
      // 浏览器里那支片子：位置由 state.pos 控制（暂停期间它照样在走，模拟"人还在看"）
      readBrowser: async () => ({
        pos: state.pos, dur: 3600, paused: state.videoPaused, source: 'cdp',
      }),
      readBridge: async () => null,
      chatWatcher: () => null,
      loadLatency: async () => ({}),
      wake: async () => { state.wakes += 1; return { ok: true }; },
      wakeChat: async () => { state.wakes += 1; return { ok: true }; },
    },
  });
  assert.equal(r.ok, true);
  return { state, r };
}

test('窗口按 ⏸ → 这一场停住，但循环还活着（窗留着）', async () => {
  const { state } = harness();
  await state.fire();                       // 第一次读只记水位
  assert.equal(loopStatus().paused, false);

  state.t = T0 + 4000;
  state.actions.push({ type: 'pause', at: state.t });
  await state.fire();

  const st = loopStatus();
  assert.equal(st.paused, true, 'status 要报得出来，否则模型以为人看完了');
  assert.equal(st.active, true, '暂停不是关窗：循环必须还在（否则 ▶ 也没人接）');
  assert.equal(state.wakes, 0, '暂停期间不许叫醒模型');

  // 再跑几拍也不许自己恢复
  for (let i = 0; i < 3; i += 1) {
    state.t += 2000;
    await state.fire();
  }
  assert.equal(loopStatus().paused, true);
  assert.equal(state.wakes, 0);
  stopWatchLoop('cleanup');
});

test('文件里残留的老 pause 不会被重放（一开窗就停住是最糟的状态）', async () => {
  const { state } = harness([
    { type: 'pause', at: T0 - 86_400_000 },         // 一天前按过的
    { type: 'resume', at: T0 - 86_300_000 },
  ]);
  await state.fire();
  assert.equal(loopStatus().paused, false, '历史动作只记水位、不执行');

  // 记了水位之后，新的动作才生效
  state.actions.push({ type: 'pause', at: T0 + 1000 });
  state.t = T0 + 2000;
  await state.fire();
  assert.equal(loopStatus().paused, true);
  stopWatchLoop('cleanup');
});

test('按 ▶ 恢复：丢掉旧锚点重新读真值（暂停那段不补，也不当成拖进度条）', async () => {
  const { state } = harness();
  await state.fire();

  state.t = T0 + 2000;
  state.actions.push({ type: 'pause', at: state.t });
  await state.fire();
  assert.equal(loopStatus().paused, true);

  // 暂停了 10 分钟：真实进度一直在走（这是关键 —— 旧锚点外推出来的位置是假的）
  state.t = T0 + 600_000;
  state.pos = 610;
  state.actions.push({ type: 'resume', at: state.t });
  await state.fire();

  const st = loopStatus();
  assert.equal(st.paused, false);
  assert.ok(Math.abs(st.pos - 610) < 1, `恢复后要重新读到真实位置，实际 ${st.pos}`);
  assert.equal(state.wakes, 0, '暂停 10 分钟不是"拖进度条"，不许拿大跳去叫醒模型');
  stopWatchLoop('cleanup');
});

test('同一支片子重调工具不解除暂停；换片才算新一场（恢复在看）', async () => {
  const { state } = harness();
  await state.fire();
  state.t = T0 + 2000;
  state.actions.push({ type: 'pause', at: state.t });
  await state.fire();
  assert.equal(loopStatus().paused, true);

  // 模型又调了一次 watch_together（同一支片子、同一张批次表）→ 走 samePlan 那条路：
  // 人按的是 ⏸，"再调一次工具"不等于"我要继续看"。
  const again = startWatchLoop({
    ctx: ctxStub, sessionId: 's-pause', input: 'pause.mp4', segment: 60, ramp: [], cursor: 999,
  });
  assert.equal(again.resumed, true, '同一支片子应该走"接着跑"而不是重开');
  assert.equal(loopStatus().paused, true, '重调工具不许偷偷把暂停解掉');
  assert.ok(loopStatus().pos < 100, '冻结的钟也不许被 cursor 推走');

  // 换片 = 新一场：默认"在看"（窗口那边靠一条 control 事件跟着变回来）
  startWatchLoop({ ctx: ctxStub, sessionId: 's-pause', input: 'other.mp4', segment: 60, ramp: [] });
  assert.equal(loopStatus().paused, false);
  stopWatchLoop('cleanup');
});
