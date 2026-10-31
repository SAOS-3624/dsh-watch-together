/**
 * window-hide.test.mjs — **藏起来 ≠ 关掉**（2026-11-01 用户提出）。
 *
 * 用户原话：「如果不出现队列消息，而且能有其他功能隐藏悬浮窗会更好」。
 *
 * 关窗在陪看里的语义是"我不看了"：停表 + 落挂断记录 + 不许自动重开。
 * 而他想要的"藏起来"只是**这次别挡着画面** —— 陪看继续，台词照念。
 * 两件事混成一个的话，用户每次嫌窗口碍事都得把整场陪看结束掉。
 *
 * 这里钉住三条：
 *   ① `window: 'hide'` 只写配置，**不碰钟、不落挂断**；
 *   ② 窗口没开着时明确回一句，不假装成功；
 *   ③ 藏过之后 `window: 'show'` 能放回来。
 */

process.env.DSH_WATCH_BRIDGE = '0';
process.env.DSH_WATCH_REQUIRE_LINES = '0';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loopStatus, startWatchLoop, stopWatchLoop } from '../src/watch-loop.js';
import { isHungUp } from '../src/watch-state.js';
import { openFloatingWindow } from '../src/floating-window.js';
import { runWatchAction } from '../src/watch-actions.js';

const ctxStub = { sessionController: { prompt: async () => {} } };

/** 造一个"窗口开着"的环境：pid 文件里写当前进程号，配置目录指到临时目录 */
async function withWindow(fn) {
  const prevHome = process.env.DSH_HOME;
  const prevPid = process.env.DSH_WATCH_WINDOW_PID;
  const prevCache = process.env.DSH_VIDEO_CACHE_DIR;
  const home = await mkdtemp(join(tmpdir(), 'win-hide-'));
  const cache = await mkdtemp(join(tmpdir(), 'win-hide-cache-'));
  process.env.DSH_HOME = home;
  // **watch.json 落在缓存目录里**：不隔离的话会读到别的用例刚落下的 hangup 记录
  process.env.DSH_VIDEO_CACHE_DIR = cache;
  try {
    // 让 stillRunning() 看到"窗口还在"：pid 文件 + 环境变量两种写法都认，先都备上
    process.env.DSH_WATCH_WINDOW_PID = String(process.pid);
    await writeFile(join(home, 'watch-window.pid'), String(process.pid), 'utf8');
    return await fn(home);
  } finally {
    stopWatchLoop('cleanup');
    if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    if (prevCache === undefined) delete process.env.DSH_VIDEO_CACHE_DIR;
    else process.env.DSH_VIDEO_CACHE_DIR = prevCache;
    if (prevPid === undefined) delete process.env.DSH_WATCH_WINDOW_PID;
    else process.env.DSH_WATCH_WINDOW_PID = prevPid;
    await rm(home, { recursive: true, force: true }).catch(() => {});
    await rm(cache, { recursive: true, force: true }).catch(() => {});
  }
}

test('window:hide 只写 hidden 标记 —— 不停钟、不落挂断', async () => {
  await withWindow(async (home) => {
    stopWatchLoop('init');
    startWatchLoop({
      ctx: ctxStub, sessionId: 's-hide', input: 'h.mp4',
      segments: [{ from: 0, to: 120 }], browserPort: 1, segment: 120, ramp: [], depth: 2,
      deps: {
        now: () => Date.now(),
        ticker: () => ({ dispose() {} }),
        readBrowser: async () => ({ pos: 10, dur: 600, paused: false, title: 'h.mp4' }),
        probeEveryMs: 0,
        loadLatency: async () => null,
      },
      log: () => {},
    });
    assert.equal(loopStatus().active, true);

    const r = await runWatchAction({ window: 'hide' }, { ctx: ctxStub, sessionId: 's-hide' });
    assert.match(String(r?.text ?? ''), /藏起来/, `要回一句人话，实得 ${r?.text}`);
    assert.equal(loopStatus().active, true, '藏窗口不该停钟');
    assert.equal(await isHungUp('h.mp4'), false, '藏窗口不是挂断');

    const cfg = JSON.parse(await readFile(join(home, 'watch-window.json'), 'utf8'));
    assert.equal(cfg.hidden, true, '窗口自己读这个键来 withdraw');

    // 放回来
    const back = await runWatchAction({ window: 'show' }, { ctx: ctxStub, sessionId: 's-hide' });
    assert.match(String(back?.text ?? ''), /放出来/);
    const cfg2 = JSON.parse(await readFile(join(home, 'watch-window.json'), 'utf8'));
    assert.equal(cfg2.hidden, false);
    assert.equal(loopStatus().active, true, '放回来也不该动钟');
  });
});

test('重开窗口时把 hidden 清掉 —— 不许带着隐身状态起来', async () => {
  const prevHome = process.env.DSH_HOME;
  const home = await mkdtemp(join(tmpdir(), 'win-hide-stale-'));
  process.env.DSH_HOME = home;
  try {
    // 上次是藏着退出的（进程被杀 / 用户关了机）
    await writeFile(join(home, 'watch-window.json'),
      JSON.stringify({ script: join(home, 'nope.py'), hidden: true }), 'utf8');
    // 不让它真 spawn：这一条只验"清标记发生在开窗之前"
    const prevNo = process.env.DSH_WATCH_NO_WIDGET;
    process.env.DSH_WATCH_NO_WIDGET = '1';
    try {
      const r = openFloatingWindow({ force: false });
      assert.equal(r?.ok, false, '关掉悬浮窗时不该真开');
    } finally {
      if (prevNo === undefined) delete process.env.DSH_WATCH_NO_WIDGET;
      else process.env.DSH_WATCH_NO_WIDGET = prevNo;
    }
    const cfg = JSON.parse(await readFile(join(home, 'watch-window.json'), 'utf8'));
    assert.equal(cfg.hidden, false, '重开前必须把 hidden 清掉，否则窗口直接隐身');
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    await rm(home, { recursive: true, force: true }).catch(() => {});
  }
});

test('窗口没开着时 window:hide 要明说，不许假装成功', async () => {
  const prevHome = process.env.DSH_HOME;
  const prevCache = process.env.DSH_VIDEO_CACHE_DIR;
  const home = await mkdtemp(join(tmpdir(), 'win-hide-off-'));
  const cache = await mkdtemp(join(tmpdir(), 'win-hide-off-cache-'));
  process.env.DSH_HOME = home;
  process.env.DSH_VIDEO_CACHE_DIR = cache;
  try {
    const r = await runWatchAction({ window: 'hide' }, { ctx: ctxStub, sessionId: 's-hide2' });
    assert.match(String(r?.text ?? ''), /没开着|没什么可藏/, `要回一句实话，实得 ${r?.text}`);
    let cfg = null;
    try { cfg = JSON.parse(await readFile(join(home, 'watch-window.json'), 'utf8')); } catch { /* 没写就是对的 */ }
    assert.equal(cfg?.hidden, undefined, '没窗口就不该写标记（否则下次开窗直接是隐身的）');
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    if (prevCache === undefined) delete process.env.DSH_VIDEO_CACHE_DIR;
    else process.env.DSH_VIDEO_CACHE_DIR = prevCache;
    await rm(home, { recursive: true, force: true }).catch(() => {});
    await rm(cache, { recursive: true, force: true }).catch(() => {});
  }
});
