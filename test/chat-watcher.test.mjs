/**
 * chat-watcher.test.mjs — 悬浮窗里的插话，一条都不能丢。
 *
 * 用户实报（2026-10-31 19:02）：「悬浮窗插话他突然不理我了」。现场是：
 * 用户在窗口里说了一句（`chat.jsonl` 里确实有），19:02:53 写下，
 * 19:03:00 和 19:03:16 台词还在照常念 —— 钟是活的，唯独这句没人接。
 *
 * 老实现按**条数**分页（`seen = readChat().length`）。chat.jsonl 一旦被就地清理或
 * 重写（清历史、重启窗口、手工清洗），行数会缩回去，`seen` 从此永远大于行数：
 * `all.length <= seen` 恒成立，watcher 就聋了，而且是一次性的、不会自愈。
 *
 * 现在按每条消息自带的墙钟时间 `at`（毫秒）分页 —— 时间戳单调递增，和行数无关。
 */

process.env.DSH_WATCH_BRIDGE = '0';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendChat, makeChatWatcher } from '../src/chat-store.js';

test('新插话会被报出来，且同一条只报一次', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chat-'));
  const env = { ...process.env, DSH_VIDEO_CACHE_DIR: dir };
  try {
    appendChat('line', '开场白', { t: 1 }, env);
    const poll = makeChatWatcher(env);
    assert.equal(poll(), null, '基线之前的消息不算插话');

    appendChat('user', '在吗', {}, env);
    const got = poll();
    assert.equal(got?.text, '在吗');
    assert.equal(poll(), null, '同一条不能报两次');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('**文件被清理后仍然能工作**（老实现会永久聋掉）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chat2-'));
  const env = { ...process.env, DSH_VIDEO_CACHE_DIR: dir };
  try {
    const { writeFileSync, readFileSync } = await import('node:fs');
    // 先灌 30 条，让老实现的 `seen` 涨到 30
    for (let i = 0; i < 30; i++) {
      appendChat('line', `台词 ${i}`, { t: i }, env);
    }
    const poll = makeChatWatcher(env);
    assert.equal(poll(), null);

    // 就地清理：只留下最后一条（行数从 30 缩回 1）
    const file = join(dir, 'chat.jsonl');
    const rows = readFileSync(file, 'utf8').trim().split('\n');
    writeFileSync(file, rows[rows.length - 1] + '\n', 'utf8');

    // 清理之后用户又说了一句
    appendChat('user', '清理之后我还能说话吗', {}, env);
    const got = poll();
    assert.equal(got?.text, '清理之后我还能说话吗', '清理过的聊天记录不能让 watcher 失聪');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('没写 at 的老消息不会被当成新插话（不重放历史）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chat3-'));
  const env = { ...process.env, DSH_VIDEO_CACHE_DIR: dir };
  try {
    const { writeFileSync } = await import('node:fs');
    const file = join(dir, 'chat.jsonl');
    writeFileSync(file, `${JSON.stringify({ role: 'user', text: '很老的一句' })}\n`, 'utf8');
    const poll = makeChatWatcher(env);
    assert.equal(poll(), null, '创建时把历史吃进基线');
    assert.equal(poll(), null, '没有 at 的老消息永远不报');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
