/**
 * hangup-guard.test.mjs — "别继续跑了"的两条硬约束（2026-10-31 第二轮实报）。
 *
 * 用户原话：
 *   「换片或者我都关浏览器了还在念台词」
 *   「关了悬浮窗 AI 还是会自动调出来，根本不会自动结束，还是继续在看」
 *   「把关悬浮窗这个信号当成插话一样告诉他不要继续跑了」
 *
 * 所以钉三件事：
 *   ① 位置不可信（读数停住、外推到底）→ **一句台词都不许再发**；
 *   ② 关窗 = 挂断：钟停表，并且**真的叫醒**模型（`wake:false` 不该把它一起关掉）；
 *   ③ 叫醒的话里必须写明"不要再调、不要再念"。
 */

process.env.DSH_WATCH_BRIDGE = '0';
process.env.DSH_WATCH_REQUIRE_LINES = '0';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loopStatus, startWatchLoop, stopWatchLoop } from '../src/watch-loop.js';
import { __resetSpeech, onSpeech } from '../src/voice.js';
import { markHungUp } from '../src/watch-state.js';
import { saveLines } from '../src/watch.js';
import { execute } from '../src/handler.js';
import { createSim } from './helpers/sim.mjs';

const ctxStub = { sessionController: { prompt: async () => {} } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withCache(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'hangup-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try { return await fn(dir); } finally {
    delete process.env.DSH_VIDEO_CACHE_DIR;
    await rm(dir, { recursive: true, force: true });
  }
}

/** 起一场陪看，把到点的台词记下来 */
async function runWithDeadSource({ deadFrom, at }) {
  __resetSpeech();
  const sim = createSim({ duration: 900, deadFrom });
  await saveLines('g.mp4', [{ from: 0, at, text: '这句不该被念出来' }]);
  const heard = [];
  const off = onSpeech((e) => { if (e.state === 'due') heard.push(e); });
  try {
    startWatchLoop({
      ctx: ctxStub, sessionId: 's-guard', input: 'g.mp4',
      segments: [{ from: 0, to: 120 }], browserPort: 1, segment: 120, ramp: [], depth: 2,
      // 探针 5 秒一次（默认 15 秒）：让"读数停住之后每一拍都在外推"这件事稳定复现
      deps: { ...sim.deps, probeEveryMs: 5000 },
      log: () => {},
    });
    await sim.runTo(60);
  } finally {
    off();
    stopWatchLoop('test');
  }
  return heard;
}

test('读数停住之后：位置只能外推，外推过期就一句台词都不发', async () => {
  await withCache(async () => {
    // 20 秒之后浏览器就读不到了；台词挂在 41 秒。
    // 不看新鲜度的话，钟会一直外推（44 秒时正好"推"过 41 秒）把它念出来。
    const heard = await runWithDeadSource({ deadFrom: 20, at: 41 });
    assert.equal(heard.length, 0, `位置不可信就不许念，实得 ${JSON.stringify(heard.map((e) => e.text))}`);
  });
});

test('同一份台词、源一直在：照常念（证明上一条不是因为别的原因没念）', async () => {
  await withCache(async () => {
    const heard = await runWithDeadSource({ deadFrom: null, at: 41 });
    assert.equal(heard.length, 1, `源还在的时候应该念出来，实得 ${heard.length}`);
  });
});

test('关窗 = 挂断：停表 + 真的叫醒，并写明"不要再调 / 不要再念"', async () => {
  stopWatchLoop('init');
  const wakes = [];
  let tick = null;
  const r = startWatchLoop({
    ctx: ctxStub, sessionId: 's-hang', input: 'h.mp4',
    segments: [{ from: 0, to: 120 }], browserPort: 1, segment: 120, ramp: [], depth: 2,
    // **显式 wake:false**：段末那种打扰关着，但"用户关窗"这条不能跟着哑掉
    wake: false,
    windowGuard: true,
    deps: {
      now: () => Date.now(),
      ticker: ({ tick: t }) => { tick = t; return { dispose() {} }; },
      readBrowser: async () => ({ pos: 10, dur: 600, paused: false, title: 'h.mp4' }),
      probeEveryMs: 0,
      loadLatency: async () => null,
      windowAlive: () => false,                     // 用户已经把窗口关了
      wake: async (_c, o) => { wakes.push(o.text); return { ok: true }; },
    },
    log: () => {},
  });
  assert.equal(r.ok, true);
  await tick();

  assert.equal(loopStatus().active, false, '关窗就该停表');
  assert.equal(loopStatus().reason, 'widget-closed');
  assert.equal(wakes.length, 1, `要叫醒一次（wake:false 不该连它一起关掉），实得 ${wakes.length}`);
  assert.match(wakes[0], /悬浮窗被关掉/);
  assert.match(wakes[0], /不要再调 watch_together/);
  assert.match(wakes[0], /不要再念台词/);
  assert.match(wakes[0], /say/, '要提醒它用 say 回一句，不然用户看不见');
  stopWatchLoop('cleanup');
  await sleep(0);
});

/**
 * 用户关窗之后模型再调工具：**这一轮什么都不该做**。
 *
 * 以前 `handler` 拿到 `surface.closedByUser` 只把它写进 note，然后照常建图、照常起钟 ——
 * 用户的观感就是"关了它还在看"。而且 `sameWatch` 只认 `args.input`，
 * 而模型几乎从不传 input，于是每次都当成"新开一场"，窗口又被顶回来。
 */
test('关窗之后模型再调：不建图、不起钟、不重开窗，只回一句 [hangup]', async () => {
  const prevHome = process.env.DSH_HOME;
  const home = await mkdtemp(join(tmpdir(), 'hangup-home-'));
  // **别把本机配的声音适配器挂进来**：这个用例只验判定，真挂上就可能出声
  process.env.DSH_HOME = home;
  process.env.DSH_WATCH_NO_WIDGET = '1';
  process.env.DSH_WATCH_NO_CHAT = '1';
  try {
    await withCache(async () => {
      stopWatchLoop('init');
      // 让循环记住"刚才在看哪支"，模型下一次调用不会带 input
      startWatchLoop({
        ctx: ctxStub, sessionId: 's-after', input: 'x.mp4',
        segments: [{ from: 0, to: 120 }], browserPort: 1, segment: 120, ramp: [], depth: 2,
        deps: {
          now: () => Date.now(),
          ticker: () => ({ dispose() {} }),
          readBrowser: async () => ({ pos: 10, dur: 600, paused: false, title: 'x.mp4' }),
          probeEveryMs: 0,
          loadLatency: async () => null,
        },
        log: () => {},
      });
      await markHungUp('x.mp4');          // 用户把窗口关了（钟那边落下的记录）
      stopWatchLoop('widget-closed');

      const r = await execute({ attachments: { saveImage: async () => 'img' } }, {}, {
        sessionId: 's-after', cache: new Map(),
      });
      assert.match(r.text, /\[hangup\]/);
      assert.match(r.text, /不要再调 watch_together/);
      assert.match(r.text, /不要再念台词/);
      assert.equal(r.images.length, 0, '关窗之后不该再交付任何图');
      assert.equal(loopStatus().active, false, '更不该悄悄把钟又起起来');
    });
  } finally {
    delete process.env.DSH_WATCH_NO_WIDGET;
    delete process.env.DSH_WATCH_NO_CHAT;
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    await rm(home, { recursive: true, force: true });
    stopWatchLoop('cleanup2');
  }
});
