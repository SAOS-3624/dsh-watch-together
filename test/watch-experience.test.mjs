/**
 * watch-experience.test.mjs — 三个"用户能感觉到"的口径：
 *
 *   ① 延迟标定只认**交付**那一次。还没到点的调用（几十毫秒、不建图）不是样本 ——
 *      它一旦被算进 EWMA，平均值就被拉到接近 0，正式交付的 8~12 秒反而被淹没。
 *   ② 标定出来的提前量必须**真的用上**：后台钟在 `shouldSpeak` 里加了，阻塞等待这条主路
 *      以前没加，于是同一台机器上钟提前说、工具调用卡在段末，台词整体慢半拍。
 *   ③ 交付回的 `speech` 只报**还没念的**。以前是整份稿子，连刚被 prune 掉的过期句也在里面。
 */

process.env.DSH_WATCH_BRIDGE = '0';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runWatchPass } from '../src/watch-run.js';
import { loadLatency } from '../src/latency.js';
import { saveLines } from '../src/watch-lines.js';
import { readChat } from '../src/chat-store.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const deps = (pos = 106, extra = {}) => ({
  cache: new Map(),
  saveImage: async ({ data }) => data,
  runStoryboard: async () => ({ sheets: [{ png: Buffer.from('x'), cells: [] }] }),
  formatManifest: () => 'cell 1\n    "转写"\n',
  probe: async () => ({ ok: true, sessions: [] }),
  browserPort: 1,
  readBrowser: async () => ({ pos, dur: 600, paused: false, url: 'file:///a.mp4' }),
  ...extra,
});

test('延迟标定只认交付：还没到点的那次调用不写样本', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lat-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    // 让这一次调用真的慢（>200 ms，否则连 recordLatency 的下限都过不了，测不出差别）
    const slow = deps(50, { readBrowser: async () => { await sleep(260); return { pos: 50, dur: 600, url: 'file:///a.mp4' }; } });
    const r = await runWatchPass({ input: 'a.mp4', segment: 120, lead: 15 }, slow);
    assert.equal(r.speaking, false, '50 秒还没到交付点');
    assert.equal(existsSync(join(dir, 'latency.json')), false, '没交付就不该记标定样本');

    // 真交付那一次才记（这一条同时保证上面的断言不是因为"根本不记录"而成立的）
    // 建图给 260 ms —— recordLatency 有 200 ms 下限，纯粹的假建图会被它当噪声丢掉
    const slowBuild = deps(106, {
      runStoryboard: async () => {
        await sleep(260);
        return { sheets: [{ png: Buffer.from('x'), cells: [] }] };
      },
    });
    await runWatchPass({ input: 'a.mp4', cursor: 106, segment: 120, lead: 15 }, slowBuild);
    const st = await loadLatency();
    assert.ok(st.samples >= 1, `交付应该记样本，实得 ${JSON.stringify(st)}`);
  } finally {
    delete process.env.DSH_VIDEO_CACHE_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});

test('标定出的提前量要用在阻塞/交付判定上（不然标了也白标）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ahead-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    // 这台机器实测 6 秒：段末 120 - lead 15 - 6 = 99 秒就该动手
    writeFileSync(join(dir, 'latency.json'), JSON.stringify({ ms: 6000, samples: 5, at: Date.now() }), 'utf8');
    const r = await runWatchPass({ input: 'a.mp4', cursor: 100, segment: 120, lead: 15 }, deps(100));
    assert.equal(r.speaking, true, '100 秒时已经该开始交付了（标定 6 秒）');
  } finally {
    delete process.env.DSH_VIDEO_CACHE_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});

test('交付回的 speech 只含还没念的那几句', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'speech-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    await saveLines('a.mp4', [
      { from: 0, at: 60, text: '早就过去了' },     // 比 cursor-6 早 → 被 prune
      { from: 0, at: 110, text: '还没到' },
    ]);
    const r = await runWatchPass({ input: 'a.mp4', cursor: 106, segment: 120, lead: 15 }, deps());
    assert.deepEqual(r.speech.map((s) => s.text), ['还没到'], '过期的那句不该还挂在 speech 里');
  } finally {
    delete process.env.DSH_VIDEO_CACHE_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * 建图期间的黑洞：第一次要下载 + 建分镜，20~90 秒，而工具调用期间一句话都说不了。
 * 以前这段时间悬浮窗里**一个字都没有**，用户只能猜"它是不是卡了"。
 */
test('建图慢的时候，悬浮窗里要有一句"正在取这一段"', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'slowbuild-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  process.env.DSH_WATCH_SLOW_BUILD_MS = '30';
  try {
    const slow = deps(106, {
      runStoryboard: async () => {
        await sleep(200);
        return { sheets: [{ png: Buffer.from('x'), cells: [] }] };
      },
    });
    await runWatchPass({ input: 'a.mp4', cursor: 106, segment: 120, lead: 15 }, slow);

    const msgs = readChat();
    const note = msgs.find((m) => m.role === 'meta' && /正在取/.test(String(m.text)));
    assert.ok(note, `应写一条进度到统一流，实得 ${JSON.stringify(msgs.map((m) => m.role))}`);
    assert.match(String(note.text), /00:00–02:00/, '要写清是哪一段');
    assert.ok(!note.say, '这是给眼睛看的，不该念出来');
  } finally {
    delete process.env.DSH_VIDEO_CACHE_DIR;
    delete process.env.DSH_WATCH_SLOW_BUILD_MS;
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * 片尾：最后一段永远等不到"段末前 lead 秒"。
 * 片子 07:10 就播完了，而交付点是 10:00-15s = 09:45；位置停在片尾不再前进，
 * 这一段就永远交不出去 —— 用户看完，一句话也没有。
 */
test('播到片尾（或拖到片尾）时，最后一段要放行', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tail-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    const r = await runWatchPass(
      { input: 'a.mp4', cursor: 430, segment: 300, lead: 15 },
      deps(430, {
        readBrowser: async () => ({ pos: 430, dur: 430, paused: true, url: 'file:///a.mp4' }),
        // 时长只有浏览器知道：这里给一个 watching 状态，否则 dur 缺失、片尾判不出来
        probeBrowserState: async () => ({ state: 'watching', port: 1, pos: 430, dur: 430, paused: true }),
      }),
    );
    assert.equal(r.speaking, true, `片尾该交付（段 300–600、位置 430、剩余 170s）`);
    assert.equal(r.segment, 300);
  } finally {
    delete process.env.DSH_VIDEO_CACHE_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});
