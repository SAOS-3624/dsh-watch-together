/**
 * watch-run-position.test.mjs — 工具层怎么对待"读到的位置"。
 *
 * 位置只有一个来源：浏览器调试端口里的 `video.currentTime`。
 * 所以工具层只有三种结局：
 *   ① 读到了          → 直接用（永远是"新鲜"的，因为读就是现在读的）
 *   ② 读不到          → **拒绝猜**，要求调用方传 cursor
 *   ③ 调用方给了 cursor → 以它为准，连读都不读
 *
 * > 这里以前还有两条分支（"读数 20 秒前 → 标推算"、"冻结 400 秒 → 承认读不到"），
 * > 那是 Windows 媒体控件（SMTC）的特性带来的。SMTC 已删除，这两条随之消失。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runWatchPass } from '../src/watch-run.js';

const makeDeps = ({ reading = null, closed = false } = {}) => ({
  cache: new Map(),
  saveImage: async () => Buffer.from('x'),
  // 分镜这里不用真跑：这些分支都在建段之前就返回了
  runStoryboard: async () => ({ sheets: [{ png: Buffer.from('x'), cells: [] }] }),
  formatManifest: () => 'manifest',
  readBrowser: async () => reading,
  probeBrowserState: async () => (closed
    ? { state: 'closed', port: 1 }
    : { state: 'watching', port: 1, pos: reading?.pos, dur: reading?.dur }),
  // 显式给端口，否则 readPositionOrNull 会直接返回 null；
  // 但读数由上面的 readBrowser 注入，不会真的去连本机浏览器。
  browserPort: 1,
  autoLaunch: false,
});

const PLAYING = {
  pos: 233, dur: 1087, title: 'x', url: 'https://www.bilibili.com/video/BV1abc', paused: false, ended: false,
};

test('读到位置：直接用，标 fresh', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wr1-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    const r = await runWatchPass({ input: 'a.mp4' }, makeDeps({ reading: PLAYING }));
    assert.equal(r.confidence, 'browser');
    assert.equal(r.status, 'playing');
    assert.ok(Math.abs(r.cursor - 233) < 0.5, `应等于 233，实得 ${r.cursor}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('读不到位置：拒绝猜，要求 cursor', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wr2-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    const r = await runWatchPass({ input: 'a.mp4' }, makeDeps({ reading: null, closed: true }));
    assert.equal(r.ok, false);
    assert.match(r.text, /cannot read your playback position/);
    assert.match(r.text, /browser: CLOSED/, '要说清是"浏览器不在"而不是"没有视频"');
    assert.match(r.text, /cursor/, '要给出路：让调用方传 cursor');
    assert.equal(r.images.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('显式 cursor 优先，连读都不读', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wr3-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    let read = 0;
    const deps = {
      ...makeDeps({ reading: PLAYING }),
      readBrowser: async () => { read += 1; return PLAYING; },
    };
    const r = await runWatchPass({ input: 'a.mp4', cursor: '12:30' }, deps);
    assert.equal(r.confidence, 'given');
    assert.equal(r.cursor, 750);
    assert.ok(r.ok, '给了 cursor 就该继续出段，而不是抱怨读不到');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('页面开着但没在播：也要求 cursor（不拿 0 当位置）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wr4-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    // pos = 0 且没有 playing：readBrowserPosition 会给 null（页面没起播）
    const r = await runWatchPass({ input: 'a.mp4' }, makeDeps({ reading: null }));
    assert.equal(r.ok, false);
    assert.match(r.text, /cannot read your playback position/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
