/**
 * material.test.mjs — **素材两半**：图 + 字幕。
 *
 * 用户的规则（paraphrased）：「你当然是看图和字幕之后才输出台词，否则我还做啥 storyboard。
 * 等这两个返回了再写台词；后续我可能把字幕和图分开返回，你先留好余量。」
 *
 * 所以工具层要能回答三个问题：
 *   1. 这一次交付，我把哪一半交出去了？（图 / 字幕 / 两半）
 *   2. 这一段的素材齐了吗？缺哪一半？
 *   3. 下一条该调什么？（`transcript: true` 取字幕，或再交付一次取图）
 *
 * 记住口径：这里只说"我交出去过什么"，不假装能验证"模型有没有看"。
 */

process.env.DSH_WATCH_BRIDGE = '0';
process.env.DSH_WATCH_REQUIRE_LINES = '0';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { markMaterial, materialNote, materialState } from '../src/watch-material.js';
import { runWatchPass } from '../src/watch-run.js';

const deps = (manifest) => ({
  cache: new Map(),
  saveImage: async ({ data }) => data,
  runStoryboard: async () => ({ sheets: [{ png: Buffer.from('x'), cells: [] }] }),
  formatManifest: () => manifest,
  probe: async () => ({ ok: true, sessions: [] }),
  browserPort: 1,
  readBrowser: async () => ({ pos: 106, dur: 600, paused: false, url: 'file:///a.mp4' }),
});
const ARGS = { input: 'a.mp4', cursor: 106, segment: 120, lead: 15 };

test('状态机：只有图 → missing=transcript；两半都有 → ready', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mat-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    assert.deepEqual(await materialState('m.mp4', 60), { image: null, transcript: null, ready: false, missing: 'image' });

    const onlyImage = await markMaterial('m.mp4', 60, 'image');
    assert.equal(onlyImage.ready, false);
    assert.equal(onlyImage.missing, 'transcript');
    assert.match(materialNote(onlyImage), /先取字幕/);

    const both = await markMaterial('m.mp4', 60, 'transcript');
    assert.equal(both.ready, true);
    assert.equal(both.missing, null);
    assert.match(materialNote(both), /现在写台词/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('状态机：只有字幕 → missing=image，提示去取图', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mat2-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    const onlySubs = await markMaterial('m.mp4', 120, 'transcript');
    assert.equal(onlySubs.missing, 'image');
    assert.match(materialNote(onlySubs), /先取图/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('交付带图 + 清单里有逐格转写 → 两半都被记上（素材齐）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mat3-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    const manifest = 'cell 1 (r1c1) = 00:00.00-00:15.00\n    "这一句是转写"\n';
    const r = await runWatchPass({ ...ARGS }, deps(manifest));
    assert.equal(r.speaking, true);
    assert.match(r.text, /\[素材\] 图 ✔ 字幕 ✔/);
    const st = await materialState('a.mp4', 0);
    assert.equal(st.ready, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('交付带图但清单里没有转写（transcript:off / 静音片）→ 只记图，提示去取字幕', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mat4-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    const r = await runWatchPass({ ...ARGS }, deps('cell 1 (r1c1) = 00:00.00-00:15.00\n'));
    assert.equal(r.speaking, true);
    assert.match(r.text, /图 ✔ 字幕 ✘/);
    const st = await materialState('a.mp4', 0);
    assert.equal(st.image > 0, true);
    assert.equal(st.transcript, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
