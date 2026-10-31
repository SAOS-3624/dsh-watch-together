/**
 * widget-guard.test.mjs — **关窗即收工**。
 *
 * 用户的原话：「一旦悬浮被关闭，就让陪看模式自动关闭」。
 * 理由很硬：悬浮窗是唯一的插话入口，窗口关掉以后陪看只剩"我自言自语"，
 * 继续挂着只会占着会话；而"我把窗口关了"本身就是最准的"我看完了"。
 *
 * 两个入口都要管：
 *   1. 后台钟（watch-loop）：每一拍先看 pid 还在不在，不在就 stopWatchLoop('widget-closed')
 *   2. 阻塞等待（watch-run）：等的时候窗口没了就立刻返回 [stopped]，不许挂到封顶
 *
 * 反过来也要保证：**没开过窗不许误停**（windowGuard/expectWindow 为 false 时，
 * 窗口死活与陪看无关 —— 有人就是不用悬浮窗，直接调工具）。
 */

// 这些用例注入自己的读数，不该读到本机真实的播放位置
process.env.DSH_WATCH_BRIDGE = '0';
process.env.DSH_WATCH_REQUIRE_LINES = '0';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loopStatus, startWatchLoop, stopWatchLoop } from '../src/watch-loop.js';
import { runWatchPass } from '../src/watch-run.js';
import { takeHangupNote } from '../src/watch-state.js';

const ctxStub = { sessionController: { prompt: async () => {} } };

function bootSim({ windowAlive, windowGuard = true }) {
  let tick = null;
  const wake = [];
  const r = startWatchLoop({
    ctx: ctxStub, sessionId: 's-widget', input: 'w.mp4', segments: [{ from: 0, to: 120 }],
    browserPort: 1, segment: 120, ramp: [], depth: 2, windowGuard,
    wake: true,
    deps: {
      now: () => Date.now(),
      ticker: ({ tick: t }) => { tick = t; return { dispose() {} }; },
      readBrowser: async () => ({ pos: 10, dur: 600, paused: false, title: 'w.mp4' }),
      probeEveryMs: 0,
      loadLatency: async () => null,
      windowAlive,
      wake: async (_c, o) => { wake.push(o.text); return { ok: true }; },
    },
    log: () => {},
  });
  return { r, tick: () => tick(), wake };
}

test('钟：窗口被关掉 → 自动停表，并留一条能看懂的说明', async () => {
  const prevHome = process.env.DSH_HOME;
  const home = await mkdtemp(join(tmpdir(), 'wg-note-'));
  process.env.DSH_HOME = home;
  stopWatchLoop('init');
  try {
    let alive = true;
    const { r, tick, wake } = bootSim({ windowAlive: () => alive });
    assert.equal(r.ok, true);

    await tick();
    assert.equal(loopStatus().active, true, '窗口还开着，钟要照常走');

    alive = false;                    // 用户把窗口关了
    await tick();

    assert.equal(loopStatus().active, false, '窗口关了就该停表');
    assert.equal(loopStatus().reason, 'widget-closed', 'reason 要能一眼看出是被关窗停的');
    // **不投会话消息**（会显示成输入框的排队消息），改成待领的说明
    assert.equal(wake.length, 0, `关窗不该往会话里投消息，实得 ${wake.length} 条`);
    const note = await takeHangupNote('w.mp4');
    assert.match(note, /悬浮窗被关掉/, '要留下一条能看懂的说明');
  } finally {
    stopWatchLoop('cleanup');
    if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    await rm(home, { recursive: true, force: true }).catch(() => {});
  }
});

test('钟：没开窗（windowGuard=false）时窗口死活都不影响陪看', async () => {
  stopWatchLoop('init2');
  const { r, tick } = bootSim({ windowAlive: () => false, windowGuard: false });
  assert.equal(r.ok, true);

  await tick();
  assert.equal(loopStatus().active, true, '没开过窗就不该被"窗口不存在"停掉');
  stopWatchLoop('cleanup2');
});

test('阻塞等待：等的时候窗口没了 → 立刻返回 [stopped]，不挂到封顶', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wg-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    let alive = true;
    setTimeout(() => { alive = false; }, 300);      // 半秒后"用户关窗"
    const t0 = Date.now();
    const r = await runWatchPass(
      { input: 'w.mp4', wait: true, maxWaitSec: 30, segment: 120, lead: 15 },
      {
        cache: new Map(),
        saveImage: async ({ data }) => data,
        runStoryboard: async () => ({ sheets: [{ png: Buffer.from('x'), cells: [] }] }),
        formatManifest: () => 'm',
        probe: async () => ({ ok: true, sessions: [] }),
        browserPort: 1,
        readBrowser: async () => ({ pos: 20, dur: 600, paused: false, url: 'file:///w.mp4' }),
        expectWindow: true,
        windowAlive: () => alive,
      },
    );
    const sec = (Date.now() - t0) / 1000;
    assert.equal(r.stopped, true, '窗口没了就该 stopped');
    assert.match(r.text, /\[stopped\].*悬浮窗被关掉/s);
    assert.ok(sec < 10, `不该挂到封顶，实得 ${sec}s`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('阻塞等待：没开窗（expectWindow=false）就照常等，不受窗口死活影响', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wg2-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    let pos = 100;
    const tick = setInterval(() => { pos += 3; }, 200);
    const r = await runWatchPass(
      { input: 'w.mp4', wait: true, maxWaitSec: 20, segment: 120, lead: 15 },
      {
        cache: new Map(),
        saveImage: async ({ data }) => data,
        runStoryboard: async () => ({ sheets: [{ png: Buffer.from('x'), cells: [] }] }),
        formatManifest: () => 'm',
        probe: async () => ({ ok: true, sessions: [] }),
        browserPort: 1,
        readBrowser: async () => ({ pos, dur: 600, paused: false, url: 'file:///w.mp4' }),
        expectWindow: false,
        windowAlive: () => false,        // 窗口"不在"也不该影响
      },
    );
    clearInterval(tick);
    assert.equal(r.speaking, true, '到点照常交付');
    assert.notEqual(r.stopped, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
