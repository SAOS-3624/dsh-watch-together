/**
 * asr-cues.test.mjs — 没有 CC 字幕时，`at` 的时间码从哪来。
 *
 * 用户实报（2026-10-31）：「台词比视频提前了有点多，字幕时间码没对上还是什么」。
 *
 * 真实原因不是时间码错了，而是**这支片子根本没有 CC 字幕**（B 站 `no-subs`）：
 * 以前 `loadCues` 直接回 no-subs，写台词的人只能拿分镜的格子时间（45 秒一格）当 `at`，
 * 于是台词比画面早冒出来几十秒。
 *
 * 现在 `loadCues` 会退到 ASR，用 ASR 自己的句子时间（0.1 秒级）当时间码。
 * 这里不去连真的 ASR 服务 —— 只锁住"什么时候会去试"和"失败时怎么报"。
 */

process.env.DSH_WATCH_BRIDGE = '0';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadCues } from '../src/lines-util.js';

test('本地文件没有音轨字幕时，报 local-file-needs-sidecar（不假装有字幕）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asr-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    const r = await loadCues('a.mp4');
    assert.equal(r.ok, false);
    assert.equal(r.source, 'none');
    assert.equal(r.reason, 'local-file-needs-sidecar');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('没有缓存也没有媒体副本时，ASR 兜底失败但给出 no-subs，不抛错', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asr2-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  process.env.DSH_VIDEO_MEDIA_DIR = join(dir, 'media-empty');
  try {
    // 用一个不存在的 B 站号：不会被缓存、也找不到本地媒体副本
    const r = await loadCues('https://www.bilibili.com/video/BV1zzzzzzzzzz/', { start: 60, end: 120 });
    assert.equal(r.ok, false);
    assert.equal(r.cues.length, 0);
    // `no-ytdlp`：这台机器没装 yt-dlp（CI 上就是这样）——连抓字幕这一步都到不了。
    // 断言的是"**给出一个具体原因**，不抛错"，不是"必须走到某一层"。
    assert.ok(['no-subs', 'no-media', 'asr-empty', 'no-ytdlp'].includes(r.reason), `意外原因：${r.reason}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('缓存里已有 asr 时间码时直接用，不再联网', async () => {  const dir = await mkdtemp(join(tmpdir(), 'asr3-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'subs-bili:bv1zzz0000000.json'), JSON.stringify({
      source: 'asr',
      cues: [{ from: 100.4, to: 103.2, text: '这一句是真的有时间的' }],
    }), 'utf8');
    const r = await loadCues('https://www.bilibili.com/video/BV1zzz0000000/');
    assert.equal(r.ok, true);
    assert.equal(r.source, 'cache');
    assert.equal(r.cues[0].from, 100.4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ 没声音的四种原因 */

/**
 * 用户实报（2026-11-01，B 站评论区）："能看视频，但是听不了 / 没有声音"。
 *
 * 三种根因在用户眼里长得一模一样，旧代码把它们全糊成 `asr-empty`
 * （= "这片子没人说话"，一个会误导人的结论）：
 *   没配 ASR / 装了但连不上 / 这份副本没音轨。
 * 药方完全不同，所以必须分开报。
 */
test('有本地副本但没配 ASR：报 no-key，不说成"没人说话"', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asr4-'));
  const media = join(dir, 'media');
  const sub = join(media, 'bv1zzz0000000');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, 'video.mp4'), Buffer.alloc(4096));
  writeFileSync(join(sub, 'meta.json'), JSON.stringify({
    url: 'https://www.bilibili.com/video/BV1zzz0000000/',
  }));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  process.env.DSH_VIDEO_MEDIA_DIR = media;
  // 空 DSH_HOME = 没有 asr.json；再把 env 挪开，确保走"默认云端 + 没 key"
  process.env.DSH_HOME = join(dir, 'home');
  const saved = { key: process.env.DSH_ASR_KEY, base: process.env.DSH_ASR_BASE_URL };
  delete process.env.DSH_ASR_KEY;
  delete process.env.DSH_ASR_BASE_URL;
  try {
    const r = await loadCues('https://www.bilibili.com/video/BV1zzz0000000/', { start: 0, end: 30 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-key', '没配 ASR 必须直接说没配，不能报 asr-empty');
  } finally {
    if (saved.key !== undefined) process.env.DSH_ASR_KEY = saved.key;
    if (saved.base !== undefined) process.env.DSH_ASR_BASE_URL = saved.base;
    await rm(dir, { recursive: true, force: true });
  }
});

test('媒体目录里只有别的片子时，不拿它的音轨当这支的台词', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asr5-'));
  const media = join(dir, 'media');
  const sub = join(media, 'bv1other00000');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, 'video.mp4'), Buffer.alloc(4096));
  writeFileSync(join(sub, 'meta.json'), JSON.stringify({
    url: 'https://www.bilibili.com/video/BV1other00000/',
  }));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  process.env.DSH_VIDEO_MEDIA_DIR = media;
  try {
    // 目录里**只有另一部片子**的副本。旧代码在拿不到 BV 号时会
    // `return video` 兜底 —— 于是拿别人的音轨转写，台词全错且一句都不报。
    // 这条锁的就是"匹配不上就说没有"。
    const r = await loadCues('https://www.bilibili.com/video/BV1zzz9999999/', { start: 0, end: 30 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-media', `不能借用别的片子的副本，实际：${r.reason}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
