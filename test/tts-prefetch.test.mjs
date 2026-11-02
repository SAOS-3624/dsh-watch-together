/**
 * tts-prefetch.test.mjs — 台词写好后要提前广播 `scheduled`，让声音适配器先合成。
 *
 * 这是首声延迟的关键：适配器如果只收到 `due`，合成只能在到点之后开始，
 * edge-tts CLI 冷启动 + 网络往返就是 0.6~2 秒。`scheduled` 不改变播放时机。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { __resetSpeech, onSpeech } from '../src/voice.js';
import { saveLines } from '../src/watch-lines.js';
import { startWatchLoop, stopWatchLoop } from '../src/watch-loop.js';

import { createSim } from './helpers/sim.mjs';

test('写入未来台词后，循环广播一次 scheduled；不到点不发 due', async () => {
  __resetSpeech();
  const dir = await mkdtemp(join(tmpdir(), 'tts-prefetch-'));
  const old = process.env.DSH_VIDEO_CACHE_DIR;
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    const events = [];
    const off = onSpeech((e) => events.push(e), { voice: true });
    await saveLines('a.mp4', [{ from: 120, at: 210, text: '未来的一句' }]);

    let tick = null;
    startWatchLoop({
      ctx: {}, sessionId: 'tts-prefetch', input: 'a.mp4', segment: 120, ramp: [], cursor: 200,
      deps: {
        ticker: ({ tick: t }) => { tick = t; return { dispose() {} }; },
        now: () => Date.now(),
        wake: async () => ({ ok: true }),
        readBrowser: async () => ({ pos: 200, dur: 600, paused: false, url: 'file:///a.mp4' }),
        loadLatency: async () => ({ samples: 5 }),
      },
    });

    await tick();
    const scheduled = events.filter((e) => e.state === 'scheduled');
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].at, 210);
    assert.equal(scheduled[0].text, '未来的一句');
    assert.equal(scheduled[0].input, 'a.mp4');
    assert.equal(scheduled[0].segment, 120);
    assert.equal(events.filter((e) => e.state === 'due').length, 0, '没到点不能发 due');

    // 同一句在下一拍不能再报一次
    await tick();
    assert.equal(events.filter((e) => e.state === 'scheduled').length, 1);

    stopWatchLoop('test');
    off();
  } finally {
    stopWatchLoop('test');
    if (old === undefined) delete process.env.DSH_VIDEO_CACHE_DIR;
    else process.env.DSH_VIDEO_CACHE_DIR = old;
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * `dueLine` 是**跨段**挑"at 最小且已到点"的那句，所以到点时选中的句子可能属于上一段
 * （拖进度条跨过边界后最典型）。预合成的缓存 key 带 `segment`，`scheduled` 报的是这句
 * 自己的段 —— `due` 若报"当前段"，两边就对不上，缓存白做、首声又晚回 0.6~2 秒。
 */
test('跨段边界：due 的 segment 要跟这句自己的段，不能报当前段', async () => {
  __resetSpeech();
  const dir = await mkdtemp(join(tmpdir(), 'tts-prefetch-cross-'));
  const old = process.env.DSH_VIDEO_CACHE_DIR;
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    // 第 54 秒把进度从 55 拖到 61：跨过 60 秒的段边界，但 58 秒那句还没迟到作废
    const sim = createSim({ duration: 900, playingFrom: 0, seeks: [{ at: 54, to: 61 }] });
    const events = [];
    const off = onSpeech((e) => events.push(e), { voice: true });
    await saveLines('b.mp4', [
      { from: 0, at: 50, text: '旧段甲' },
      { from: 0, at: 58, text: '旧段乙' },
    ]);

    startWatchLoop({
      ctx: {}, sessionId: 'tts-prefetch-cross', input: 'b.mp4', browserPort: 9333,
      segment: 60, ramp: [], cursor: 0,
      deps: { ...sim.deps, probeEveryMs: 1000 },
      log: () => {},
    });

    await sim.runTo(70);

    const key = (e) => `${e.input ?? ''}|${e.segment ?? ''}|${e.text ?? ''}`;
    const scheduled = new Map(events.filter((e) => e.state === 'scheduled').map((e) => [key(e), e]));
    const due = events.filter((e) => e.state === 'due');
    assert.ok(due.length > 0, '被拖动跳过的句子仍会念（3 秒宽限内）');
    for (const e of due) {
      assert.equal(e.segment, 0, `「${e.text}」是 0 段的词，segment 不该报成当前段`);
      assert.ok(scheduled.has(key(e)), `「${e.text}」应命中预合成缓存`);
    }

    stopWatchLoop('test');
    off();
  } finally {
    stopWatchLoop('test');
    if (old === undefined) delete process.env.DSH_VIDEO_CACHE_DIR;
    else process.env.DSH_VIDEO_CACHE_DIR = old;
    await rm(dir, { recursive: true, force: true });
  }
});
