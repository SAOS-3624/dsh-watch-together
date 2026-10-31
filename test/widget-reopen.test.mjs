/**
 * widget-reopen.test.mjs — **关窗不许偷偷重开**。
 *
 * 用户投诉的原话：「我刚才关了悬浮窗又自己弹出来了」。
 * 上一版为了"每次开始陪看都保证有入口"，在每次调用开头都无条件开窗，
 * 于是用户关掉窗口 → 下一次调用立刻把窗口顶回来，等于撤销了他的动作。
 *
 * 现在的规则：
 *   新开一场（start: true）           → 窗口不在就开
 *   同一场中途再调（start: false）    → 窗口不在 = 用户关的：停钟、返回"已中止"、**不重开**
 *
 * 这里只测判定与文案，不去 spawn 真进程：`openFloatingWindow` 的 pid 判活
 * 已经在 widget-guard.test.mjs 里用注入的 windowAlive 覆盖过。
 */

process.env.DSH_WATCH_BRIDGE = '0';
process.env.DSH_WATCH_REQUIRE_LINES = '0';

import test from 'node:test';
import assert from 'node:assert/strict';

import { createInputSurface } from '../src/input-surface.js';
import { loopStatus, startWatchLoop, stopWatchLoop } from '../src/watch-loop.js';

const ctxStub = { sessionController: { prompt: async () => {} } };

function fakeLoop(input = 'w.mp4') {
  stopWatchLoop('init');
  startWatchLoop({
    ctx: ctxStub, sessionId: 's-reopen', input,
    segments: [{ from: 0, to: 120 }], browserPort: 1, segment: 120, ramp: [], depth: 2,
    deps: {
      now: () => Date.now(),
      ticker: () => ({ dispose() {} }),
      readBrowser: async () => ({ pos: 10, dur: 600, paused: false, title: input }),
      probeEveryMs: 0,
      loadLatency: async () => null,
    },
    log: () => {},
  });
  assert.equal(loopStatus().active, true);
}

test('同一场中途：窗口被关了 → 停钟、报告已中止，不再开窗', async () => {
  process.env.DSH_WATCH_NO_WIDGET = '1';
  process.env.DSH_WATCH_NO_CHAT = '1';        // 让"窗口不存在"是必然而不是期望
  try {
    fakeLoop('w2.mp4');
    const surface = createInputSurface();
    const r = await surface({ start: false });

    assert.equal(r.windowOpen, false);
    assert.equal(r.closedByUser, true, '要明确标记"是用户关的"');
    assert.match(r.note, /悬浮窗已被关掉/);
    assert.match(r.note, /不再挂着、也不重开/);
    assert.equal(loopStatus().active, false, '钟要被停掉');
    assert.equal(loopStatus().reason, 'widget-closed');
  } finally {
    delete process.env.DSH_WATCH_NO_WIDGET;
    delete process.env.DSH_WATCH_NO_CHAT;
    stopWatchLoop('cleanup');
  }
});

test('新开一场：即使窗口不在也不该判成"用户关窗"（会去尝试开窗）', async () => {
  process.env.DSH_WATCH_NO_WIDGET = '1';        // 开窗被禁 → 走"没开起来"那条分支
  process.env.DSH_WATCH_NO_CHAT = '1';          // 别起聊天服务：它一 listen，进程就退不出去
  try {
    stopWatchLoop('init');
    const surface = createInputSurface();
    const r = await surface({ start: true });
    // 关键：不是 closedByUser 那条分支，而是"没开起来 + 兜底"
    assert.equal(r.closedByUser, undefined, '新开一场不该被判成用户关窗');
    assert.equal(r.windowOpen, false);
    assert.match(r.note, /悬浮窗没开起来/);
  } finally {
    delete process.env.DSH_WATCH_NO_WIDGET;
    delete process.env.DSH_WATCH_NO_CHAT;
  }
});
