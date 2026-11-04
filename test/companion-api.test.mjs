/**
 * companion-api.test.mjs — 声音适配器能问核心的两个问题：`upcoming()` / `position()`。
 *
 * 这两个方法是**只读**的（issue #4 定的边界）：核心不做合成、不缓存音频。
 * 所以这里守的也是三件事：
 *   ① 位置不知道时必须说不知道（`pos: null`），不能给个 0 让适配器算错差值；
 *   ② `upcoming()` 只看未来窗口，不消费、不改槽位；
 *   ③ 停表之后不能还留着上一支片子的位置。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clearPlayhead, readPlayhead, setPlayhead } from '../src/playhead.js';
import { MAX_HORIZON_SEC, position, upcoming } from '../src/companion-api.js';
import { makeAnchor } from '../src/position.js';
import { saveLines } from '../src/watch-lines.js';
import { loadVoiceAdapter } from '../src/voice-adapter.js';
import { startWatchLoop, stopWatchLoop } from '../src/watch-loop.js';

const withCache = async (fn) => {
  const dir = await mkdtemp(join(tmpdir(), 'companion-'));
  const old = process.env.DSH_VIDEO_CACHE_DIR;
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (old === undefined) delete process.env.DSH_VIDEO_CACHE_DIR;
    else process.env.DSH_VIDEO_CACHE_DIR = old;
    await rm(dir, { recursive: true, force: true });
  }
};

test('没在陪看时：字段齐全、pos 是 null 而不是 0', () => {
  clearPlayhead();
  assert.deepEqual(position(), { pos: null, dur: null, confidence: 'unknown', staleMs: null });
  assert.deepEqual(readPlayhead().active, false);
});

test('刚读到的位置算 fresh，时长原样带出来', () => {
  const now = Date.now();
  setPlayhead({ input: 'a.mp4', dur: 600, anchor: makeAnchor({ pos: 120, dur: 600, status: 'playing', updated: now }, now) });
  const p = position();
  assert.equal(p.pos, 120);
  assert.equal(p.dur, 600);
  assert.equal(p.confidence, 'fresh');
  assert.ok(p.staleMs >= 0);
  clearPlayhead();
});

test('读数旧了但在外推上限内：按时钟往前推，标 extrapolated', () => {
  const now = Date.now();
  // 30 秒前读的 100 秒 → 现在应该推成 130（FRESH_MS 5s < 30s ≤ 60s 上限）
  setPlayhead({ input: 'a.mp4', dur: 600, anchor: makeAnchor({ pos: 100, dur: 600, status: 'playing', updated: now - 30_000 }, now) });
  const p = position();
  assert.equal(p.confidence, 'extrapolated');
  assert.equal(p.pos, 130);
  assert.ok(p.staleMs >= 30_000);
  clearPlayhead();
});

/**
 * 推太久就是"不知道"。这里给数字（哪怕钳到上限）比给 null 更危险：
 * 适配器会算出"我合成的音频比当前位置晚了三百秒"然后把它默默丢掉 ——
 * 表现是"有时候就是不出声"，而且完全没有报错。
 */
test('超过外推上限：confidence=unknown 且 pos=null', () => {
  const now = Date.now();
  setPlayhead({ input: 'a.mp4', dur: 600, anchor: makeAnchor({ pos: 100, dur: 600, status: 'playing', updated: now - 300_000 }, now) });
  const p = position();
  assert.equal(p.confidence, 'unknown');
  assert.equal(p.pos, null);
  assert.ok(p.staleMs >= 300_000);
  clearPlayhead();
});

test('暂停时位置不会自己走：永远算 fresh，不按时钟外推', () => {
  const now = Date.now();
  setPlayhead({ input: 'a.mp4', dur: 600, anchor: makeAnchor({ pos: 88, dur: 600, status: 'paused', updated: now - 120_000 }, now) });
  const p = position();
  assert.equal(p.confidence, 'fresh');
  assert.equal(p.pos, 88);
  clearPlayhead();
});

test('没有在跟的片子时 upcoming() 是空数组（不是抛错）', async () => {
  clearPlayhead();
  assert.deepEqual(await upcoming(), []);
});

test('upcoming() 只给未来窗口内的句子，按 at 升序，带 segment', async () => {
  await withCache(async () => {
    await saveLines('c.mp4', [
      { from: 120, at: 100, text: '已经过去的' },
      { from: 120, at: 205, text: '马上要念的' },
      { from: 240, at: 210, text: '稍微远一点' },
      { from: 240, at: 400, text: '很久以后' },
    ]);
    const now = Date.now();
    setPlayhead({ input: 'c.mp4', dur: 600, anchor: makeAnchor({ pos: 200, dur: 600, status: 'playing', updated: now }, now) });

    const rows = await upcoming({ horizonSec: 20 });
    assert.deepEqual(rows, [
      { at: 205, text: '马上要念的', segment: 120 },
      { at: 210, text: '稍微远一点', segment: 240 },
    ]);

    // 纯读：再问一次结果一样（若顺手消费了，第二次就会少一句）
    assert.deepEqual(await upcoming({ horizonSec: 20 }), rows);
    clearPlayhead();
  });
});

test('horizonSec 有上下界：离谱的值不会把整份台词拉出来', async () => {
  await withCache(async () => {
    const many = Array.from({ length: MAX_HORIZON_SEC + 40 }, (_, i) => ({ from: 0, at: 101 + i, text: `第${i}句` }));
    await saveLines('h.mp4', many);
    const now = Date.now();
    setPlayhead({ input: 'h.mp4', dur: 900, anchor: makeAnchor({ pos: 100, dur: 900, status: 'playing', updated: now }, now) });

    const wide = await upcoming({ horizonSec: 9999 });
    assert.equal(wide.length, MAX_HORIZON_SEC, '窗口最多看 120 秒');
    // 负数 / NaN 不该变成"整个文件"或"空窗口"
    assert.ok((await upcoming({ horizonSec: -50 })).length >= 1);
    assert.equal((await upcoming({ horizonSec: 'nonsense' })).length, 20, '非法值退回默认 20 秒');
    clearPlayhead();
  });
});

test('位置不知道时 upcoming() 给空数组（宁可不预取，也别排错顺序）', async () => {
  await withCache(async () => {
    await saveLines('u.mp4', [{ from: 0, at: 30, text: '一句' }]);
    const now = Date.now();
    // 三百秒没读到位置 → unknown → pos 为 null
    setPlayhead({ input: 'u.mp4', dur: 600, anchor: makeAnchor({ pos: 10, dur: 600, status: 'playing', updated: now - 300_000 }, now) });
    assert.deepEqual(await upcoming(), []);
    clearPlayhead();
  });
});

test('循环在跑时 position()/upcoming() 跟着锚点走；停表后清空', async () => {
  await withCache(async () => {
    await saveLines('loop.mp4', [
      { from: 120, at: 205, text: '窗口内的' },
      { from: 240, at: 300, text: '窗口外的' },
    ]);

    let tick = null;
    stopWatchLoop('test');
    startWatchLoop({
      ctx: {}, sessionId: 'companion', input: 'loop.mp4', segment: 120, ramp: [], cursor: 200,
      deps: {
        ticker: ({ tick: t }) => { tick = t; return { dispose() {} }; },
        now: () => Date.now(),
        wake: async () => ({ ok: true }),
        readBrowser: async () => ({ pos: 200, dur: 600, paused: false, url: 'file:///loop.mp4' }),
        loadLatency: async () => ({ samples: 5 }),
      },
    });

    await tick();
    const p = position();
    assert.equal(p.pos, 200);
    assert.equal(p.confidence, 'fresh');
    assert.deepEqual((await upcoming({ horizonSec: 20 })).map((x) => x.text), ['窗口内的']);

    stopWatchLoop('test');
    assert.deepEqual(position(), { pos: null, dur: null, confidence: 'unknown', staleMs: null });
    assert.deepEqual(await upcoming(), []);
  });
});

/**
 * 适配器只能通过 `attach(api)` 拿到这两个方法 —— 这就是 issue #4 里承诺的接口。
 * 少传一个，第三方适配器读 `api.upcoming` 就是 undefined，而且**不会报错**，
 * 只表现为"预取一直不来 / seek 之后还在念旧话"。所以这里锁死"传进去了且能调"。
 */
test('attach(api) 里能拿到 upcoming / position', async () => {
  await withCache(async (dir) => {
    const probe = join(dir, 'probe-adapter.mjs');
    await writeFile(probe, [
      'export function attach(api) {',
      '  globalThis.__seen = {',
      '    hasUpcoming: typeof api.upcoming ===',
      '      "function", hasPosition: typeof api.position === "function",',
      '  };',
      '  return () => {};',
      '}',
    ].join('\n'), 'utf8');

    await loadVoiceAdapter(probe);
    assert.deepEqual(globalThis.__seen, { hasUpcoming: true, hasPosition: true });
    delete globalThis.__seen;
  });
});
