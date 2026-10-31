/**
 * lines-timing.test.mjs — 台词**只在该念的时候念**。
 *
 * 用户投诉的原话：「代码不是让你只有到达时间区域内的台词才输出吗，
 * 你一次性输出三条干什么，还是过去那么久的」。
 *
 * 以前的 bug 在 `watch-run` 的交付分支：它把这一段所有台词一次性
 * `appendSpoken` 写进文本流，语音适配器照着顺序全念 —— 三条一起冒出来，
 * `at` 早已过去的也当场补念，和画面对不上。
 *
 * 现在的口径：
 *   · 交付**不写**文本流，只报"还剩几句、最早几点念"；
 *   · `at` 早于 cursor-6s 的：从稿子里摘掉（`pruneSlot`），并说明为什么丢；
 *   · 真正开口由钟按位置逐句 consumeLine + appendSpoken（那条路已经有迟到作废）。
 */

process.env.DSH_WATCH_BRIDGE = '0';
process.env.DSH_WATCH_REQUIRE_LINES = '0';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runWatchPass } from '../src/watch-run.js';
import { dueLine, readSlot, saveLines } from '../src/watch-lines.js';
import { loadWatch, sessionKey } from '../src/watch-state.js';
import { onSpeech } from '../src/voice.js';
import { loopStatus, startWatchLoop, stopWatchLoop } from '../src/watch-loop.js';

const deps = () => ({
  cache: new Map(),
  saveImage: async ({ data }) => data,
  runStoryboard: async () => ({ sheets: [{ png: Buffer.from('x'), cells: [] }] }),
  formatManifest: () => 'cell 1\n    "转写"\n',
  probe: async () => ({ ok: true, sessions: [] }),
  browserPort: 1,
  readBrowser: async () => ({ pos: 106, dur: 600, paused: false, url: 'file:///a.mp4' }),
});
const ARGS = { input: 'timing.mp4', cursor: 106, segment: 120, lead: 15 };

test('交付不再把整段台词一次性写进流：三条只留一条"最早几点念"的说明', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'timing-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  const heard = [];
  const off = onSpeech((e) => heard.push(e.text));
  try {
    await saveLines('timing.mp4', [
      { from: 0, at: 100, text: '第一句（还没到）' },
      { from: 0, at: 115, text: '第二句（还没到）' },
      { from: 0, at: 130, text: '第三句（还没到）' },
    ]);
    const r = await runWatchPass({ ...ARGS }, deps());
    assert.equal(r.speaking, true);
    assert.match(r.text, /已写好 3 句，最早 01:40 念/, '只报"最早几点念"');
    assert.equal(heard.length, 0, '交付这一下不该往声音里塞任何一句');
  } finally {
    try { off?.(); } catch { /* ignore */ }
    await rm(dir, { recursive: true, force: true });
  }
});

test('at 已经过去的台词：丢掉 + 清出稿子 + 说明原因（不许当场补念）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'timing2-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  const heard = [];
  const off = onSpeech((e) => heard.push(e.text));
  try {
    await saveLines('timing2.mp4', [
      { from: 0, at: 63, text: '早就过去了的一句' },
      { from: 0, at: 100, text: '还来得及的一句' },
    ]);
    const r = await runWatchPass({ ...ARGS, input: 'timing2.mp4' }, deps());
    assert.equal(r.speaking, true);
    assert.match(r.text, /丢弃 1 句/, '要说清楚丢了几句');
    assert.match(r.text, /还没播到/, '要教模型挑未来的时间点');
    assert.equal(heard.length, 0, '过去的那句不许当场念');

    const slot = await readSlot('timing2.mp4', 0);
    assert.deepEqual(slot.map((x) => x.text), ['还来得及的一句'], '过去的那句要从稿子里摘掉');
  } finally {
    try { off?.(); } catch { /* ignore */ }
    await rm(dir, { recursive: true, force: true });
  }
});

test('全部台词都过期时：一句不念、稿子清空，但交付照样算完成', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'timing3-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    await saveLines('timing3.mp4', [{ from: 0, at: 10, text: '全过期' }]);
    const r = await runWatchPass({ ...ARGS, input: 'timing3.mp4' }, deps());
    assert.equal(r.speaking, true);
    assert.equal(r.complete, true, '有台词就算交付完成（只是不念）');
    assert.match(r.text, /丢弃 1 句/);
    assert.deepEqual(await readSlot('timing3.mp4', 0), [], '稿子要清空');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * 2026-10-31 晚实报的另一半：「吐字太快，台词挤到一起，只有上一句念完才到下一句，
 * 话太密导致语音越来越滞后」。
 *
 * 声音引擎是**串行**的（一句念完才轮到下一句）。核心按 `at` 发得再准，只要发得比念得快，
 * 排进链里的句子就会越来越多，声音离画面越来越远。所以：上一句还在说的时候这一拍不发；
 * 拖过迟到宽限的那句直接作废 —— 宁可少说一句，也不要越说越晚。
 */
test('声音还没念完就不发下一句（话太密会把语音越拖越远）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'timing5-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  delete process.env.DSH_WATCH_BRIDGE;
  const heard = [];
  const off = onSpeech((e) => { if (e.state === 'due') heard.push(e.text); }, { voice: true });
  let tick = null;
  let clock = Date.now() + 2_000_000;
  let pos = 123;                      // 第一句 at=120，按字数后延约 2.1 秒，123 秒正好开口
  try {
    const long = '这一句挺长的所以要念将近四秒钟才念得完';   // 21 字 ≈ 4.55 秒
    await saveLines('dense.mp4', [
      { from: 120, at: 120, text: long },
      { from: 120, at: 121, text: '紧跟着的第二句' },
    ]);
    // 位置走扩展上报那条路（循环里的探针只认它和 CDP，不认测试注入的 readBrowser）
    const beat = (p) => writeFileSync(join(dir, 'position.json'), JSON.stringify({
      pos: p, dur: 600, paused: false, title: 'dense', url: 'file:///a.mp4', at: clock,
    }), 'utf8');

    const r = startWatchLoop({
      ctx: {}, sessionId: 's-dense', input: 'dense.mp4', segment: 60, ramp: [], cursor: 120,
      deps: {
        ticker: ({ tick: t }) => { tick = t; return { dispose() {} }; },
        now: () => clock,
        wake: async () => ({ ok: true }),
        probeEveryMs: 0,
        readBrowser: async () => null,
        loadLatency: async () => ({ ms: 0, samples: 0 }),
      },
    });
    assert.equal(r.ok, true);

    for (let i = 0; i < 8; i += 1) {
      beat(pos);
      await tick();
      clock += 1000;
      pos += 1;
    }

    assert.deepEqual(heard, [long], `引擎念的时候不许再塞下一句（实得 ${JSON.stringify(heard)}）`);
    assert.deepEqual(await readSlot('dense.mp4', 120), [], '追不上画面的那句要作废，不许攒着连珠炮');
  } finally {
    stopWatchLoop('test');
    process.env.DSH_WATCH_BRIDGE = '0';
    try { off?.(); } catch { /* ignore */ }
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * 2026-10-31 晚实报的另一半：「时间点都比视频早了」。
 *
 * 位置 15 秒才真读一次，中间全靠按时钟外推。用户一暂停（或播放器卡住），
 * 钟还会继续往前走最多 15 秒 —— 这段时间里"到点"的台词会**提前**被念出来，
 * 而外推是不受任何迟到宽限约束的（宽限只管晚，不管早）。
 *
 * 现在：位置来源是扩展时，**每一拍都校一次上报文件**（一个小 JSON，不是 CDP）。
 */
test('视频卡住不动：钟不许按时钟外推，把后面的台词提前吐出来', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'timing4-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  delete process.env.DSH_WATCH_BRIDGE;
  const heard = [];
  const off = onSpeech((e) => { if (e.state === 'due') heard.push(e.text); });
  let tick = null;
  let clock = Date.now() + 1_000_000;   // 假时钟：每拍 +2 秒
  try {
    // 扩展上报：位置一直停在 120（视频卡住 / 缓冲），但没报 paused
    const beat = () => writeFileSync(join(dir, 'position.json'), JSON.stringify({
      pos: 120, dur: 600, paused: false, title: 'stuck', url: 'file:///a.mp4', at: clock,
    }), 'utf8');
    beat();
    await saveLines('stuck.mp4', [{ from: 120, at: 126, text: '这句在 02:06' }]);

    const r = startWatchLoop({
      ctx: {}, sessionId: 's-stuck', input: 'stuck.mp4', segment: 60, ramp: [], cursor: 120,
      deps: {
        ticker: ({ tick: t }) => { tick = t; return { dispose() {} }; },
        now: () => clock,
        wake: async () => ({ ok: true }),
        readBrowser: async () => null,       // 只走扩展这条通道
        loadLatency: async () => ({ ms: 0, samples: 0 }),
      },
    });
    assert.equal(r.ok, true);

    // 30 拍 × 2 秒 = 60 秒墙钟；按外推早就该到 180 秒了
    for (let i = 0; i < 30; i += 1) {
      clock += 2000;
      beat();
      await tick();
    }
    assert.equal(loopStatus().pos, 120, '位置该停在扩展报的 120，而不是外推到 180');
    assert.deepEqual(heard, [], '位置没动就不许念 — 提前吐出来就是"台词比画面早"');
  } finally {
    stopWatchLoop('test');
    process.env.DSH_WATCH_BRIDGE = '0';    // 还原：这个文件默认关掉扩展通道，别污染后面的用例
    try { off?.(); } catch { /* ignore */ }
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * 钟每 2 秒拍一次，每一拍都要过一遍 `dueLine`。以前它用一个**跨段共享**的 `dirty`：
 * 一段 pin 过之后，后面每一段都会被重写一遍 —— 等于每 2 秒写一次 watch.json，而内容没变。
 */
test('dueLine 只重写真改过的那一段，不顺手把别的段写一遍', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dirty-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    // 段 60 的裸台词会被 pinTimes 钉死（= 这一段改过）；段 61 不动，也不该被重写
    await saveLines('dirty.mp4', [{ from: 60, text: '没写 at 的这一句' }]);
    await saveLines('dirty.mp4', [{ from: 61, at: 61, text: '下一段的一句' }]);
    const sk = sessionKey('dirty.mp4');
    await new Promise((r) => setTimeout(r, 10));            // 让两次 savedAt 的毫秒数分得开
    const before = (await loadWatch())[sk].lines['61'].savedAt;

    await dueLine('dirty.mp4', 62, { size: 120, sizeOf: () => 120 });

    const after = (await loadWatch())[sk].lines['61'].savedAt;
    assert.equal(after, before, '第二段没有改动，就不该被重写');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
