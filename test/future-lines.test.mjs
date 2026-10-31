/**
 * future-lines.test.mjs — 交付点不该把**还没到点**的台词提前消费掉。
 *
 * 循环在段末前 lead 秒会走"该说话了"分支。这条分支原先直接 consumeLine() 取队列
 * 第一条，哪怕它的 at 还在当前进度之后：模型被提前叫醒、说了一句早到的词，
 * 到真正到点时那一句已经不在队列里，用户再也听不到它。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readSlot, saveLines } from '../src/watch-lines.js';
import { loopStatus, startWatchLoop, stopWatchLoop } from '../src/watch-loop.js';

test('交付点只消费已经到点的台词，未来的台词留在槽里', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'future-lines-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    const input = 'future.mp4';
    await saveLines(input, [
      { from: 0, at: 50, text: '未来第一句' },
      { from: 0, at: 55, text: '未来第二句' },
    ]);

    let tick = null;
    const wakes = [];
    const r = startWatchLoop({
      ctx: {}, sessionId: 's-future', input,
      segment: 60, ramp: [], cursor: 46, browserPort: 1,
      wake: true,
      deps: {
        ticker: ({ tick: t }) => { tick = t; return { dispose() {} }; },
        now: () => Date.now(),
        readBrowser: async () => ({ pos: 46, dur: 600, paused: false, url: 'file:///future.mp4' }),
        loadLatency: async () => ({ samples: 1 }),
        wake: async (_ctx, o) => { wakes.push(o); return { ok: true }; },
      },
    });
    assert.equal(r.ok, true);
    await tick();

    assert.equal(wakes.length, 1, '段末交付点应该叫醒一次');
    assert.doesNotMatch(wakes[0].text, /未来第一句|未来第二句/,
      '未来台词不能在 at 之前被塞进叫醒文案');
    assert.deepEqual((await readSlot(input, 0)).map((x) => x.text), ['未来第一句', '未来第二句'],
      '两句都还在，等 at 到了再念');
  } finally {
    stopWatchLoop('test');
    delete process.env.DSH_VIDEO_CACHE_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});
