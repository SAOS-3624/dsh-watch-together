/**
 * observability.test.mjs — `statusOnly` 里那三块诊断信息（issue #4 的第一项）。
 *
 * 用户的报障是"后面越来越慢 / 它突然不说话了"。只看 `pos + reason` 查不出卡在哪一环：
 * 是位置读不到、段没建出来、台词队列空了，还是 TTS 排到天边？
 * 所以这里钉住三块**只报事实、不下结论**的字段：
 *
 *   segment { index, from, to, delivered, total }   我在第几段、整片一共几段
 *   speech  { lastLateSec, busyUntil, queued }      上一句晚了几秒、引擎忙到什么时候、还欠几句
 *   build   { inflight, cached, lastMs }            正在建哪段、缓存几段、上次建了多久
 */
process.env.DSH_WATCH_BRIDGE = '0';
process.env.DSH_WATCH_REQUIRE_LINES = '0';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loopStatus, startWatchLoop, stopWatchLoop } from '../src/watch-loop.js';
import { runWatchAction } from '../src/watch-actions.js';
import { dueLine, saveLines } from '../src/watch.js';

async function withCache(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'obs-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try { return await fn(dir); } finally {
    delete process.env.DSH_VIDEO_CACHE_DIR;
    await rm(dir, { recursive: true, force: true });
  }
}

function boot({ cursor = 130, cache = new Map() } = {}) {
  stopWatchLoop('init');
  let tick = null;
  const r = startWatchLoop({
    ctx: { sessionController: { prompt: async () => {} } },
    sessionId: 's-obs', input: 'o.mp4',
    segments: [], segment: 120, ramp: [], depth: 3,
    cursor, browserPort: 1, cache,
    deps: {
      now: () => Date.now(),
      ticker: ({ tick: t }) => { tick = t; return { dispose() {} }; },
      readBrowser: async () => ({ pos: cursor, dur: 600, paused: false, title: 'o.mp4' }),
      probeEveryMs: 0,
      loadLatency: async () => null,
    },
    log: () => {},
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  // 一拍：片长（loop.dur）只有读过浏览器才知道，`segment.total` 靠它
  return { r, tick: () => tick?.() };
}

test('segment：第几段、起止、已交付、整片共几段', async () => {
  await withCache(async () => {
    const { tick } = boot({ cursor: 130 });   // 120–240 是第 2 段（index 1）
    await tick();
    const st = loopStatus();
    assert.ok(st.segment, '应该报当前段');
    assert.equal(st.segment.index, 1);
    assert.equal(st.segment.from, 120);
    assert.equal(st.segment.to, 240);
    // 位置 130 已经过了第 1 段的交付点（120-15），所以它会被判成"该说话了"；
    // delivered 报的是**这一场里真正说过话的段数**，和 `spoken` 必须一致
    assert.equal(st.segment.delivered, st.spoken, 'delivered 就是 spoken 的长度');
    assert.ok(st.segment.delivered <= 1, `实得 ${st.segment.delivered}`);
    // 片长 600 / 段长 120 = 5 段
    assert.equal(st.segment.total, 5, `实得 ${st.segment.total}`);
    stopWatchLoop('cleanup');
  });
});

test('build：缓存里几段、上一段建了多久、正在建哪段', async () => {
  await withCache(async () => {
    const cache = new Map([['o.mp4|0', { png: Buffer.from('x') }], ['o.mp4|120', { png: Buffer.from('y') }]]);
    const { tick } = boot({ cursor: 10, cache });
    await tick();
    const st = loopStatus();
    assert.equal(st.build.cached, 2, '缓存条数要如实报');
    assert.equal(st.build.inflight, null, '刚起循环时没有在建的段');
    assert.equal(st.build.lastMs, null, '还没建过就是 null（不是 0）');
    stopWatchLoop('cleanup2');
  });
});

test('speech：上一句迟到多少秒由 dueLine 的 meta 给出来', async () => {
  await withCache(async () => {
    await saveLines('o.mp4', [{ from: 0, at: 30, text: '该在三十秒说的一句' }]);
    // 位置已经到 34 → 迟到 ≈ 34 - (30 + 语速补偿)
    const hit = await dueLine('o.mp4', 34, { size: 120, sizeOf: () => 120, meta: true });
    assert.ok(hit && hit.text, '应该取到那句');
    assert.equal(hit.at, 30);
    assert.ok(hit.late > 0 && hit.late < 6, `迟到秒数要在合理区间，实得 ${hit.late}`);
    // 老口径不能变：不传 meta 还是纯字符串（watch-modes 的 nextLine 靠它）
    const plain = await dueLine('o.mp4', 40, { size: 120, sizeOf: () => 120 });
    assert.equal(plain, null, '这句已经被取走了');
  });
});

test('statusOnly：台词队列深度靠读盘补上（queued 不是 0 而是真数）', async () => {
  await withCache(async () => {
    const { tick } = boot({ cursor: 10 });
    await tick();
    await saveLines('o.mp4', [
      { from: 0, at: 20, text: '第一句' },
      { from: 0, at: 40, text: '第二句' },
      { from: 120, at: 130, text: '下一段一句' },
    ]);
    const r = await runWatchAction({ statusOnly: true }, { ctx: null, sessionId: 's-obs', browserPort: 1 });
    const st = JSON.parse(r.text);
    assert.equal(st.speech.queued, 3, `应该数到 3 句，实得 ${st.speech.queued}`);
    assert.equal(st.speech.segmentsWithLines, 2, '两段有词');
    assert.ok('lastLateSec' in st.speech, '字段要在（没说过时是 null）');
    assert.equal(st.speech.lastLateSec, null);
    assert.ok(st.segment && st.build, '三块都要在');
    stopWatchLoop('cleanup3');
  });
});
