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
    assert.ok(['no-subs', 'no-media', 'asr-empty'].includes(r.reason), `意外原因：${r.reason}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('缓存里已有 asr 时间码时直接用，不再联网', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asr3-'));
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
