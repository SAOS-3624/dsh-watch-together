/**
 * interrupt.test.mjs — 慢事在跑的时候，能不能听见用户在聊天框说话。
 *
 * 锁两件事：
 *   ① 插话能**立刻**打断等待（不用等慢事跑完）
 *   ② 插话**不掐掉**慢事 —— 它继续跑完、结果还在（否则下次还得重跑一遍）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { raceChat, sleepWithChat } from '../src/interrupt.js';
import { appendChat, makeChatWatcher } from '../src/chat.js';

const tempEnv = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'intr-'));
  return { dir, env: { DSH_VIDEO_CACHE_DIR: dir } };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('没插话：等慢事跑完，正常拿到结果', async () => {
  const r = await raceChat(sleep(60).then(() => 'done'), { watcher: () => null, everyMs: 20 });
  assert.equal(r.kind, 'done');
  assert.equal(r.value, 'done');
});

test('插话：立刻返回，不等慢事', async () => {
  const { dir, env } = await tempEnv();
  try {
    const watcher = makeChatWatcher(env);
    const slow = sleep(2000).then(() => 'built');
    setTimeout(() => appendChat('user', '你还在吗', {}, env), 60);

    const t0 = Date.now();
    const r = await raceChat(slow, { watcher, everyMs: 20 });
    assert.ok(Date.now() - t0 < 1000, `不该等满 2 秒，实得 ${Date.now() - t0}ms`);
    assert.equal(r.kind, 'interrupted');
    assert.equal(r.text, '你还在吗');

    // **关键**：慢事没被掐掉 —— 等它跑完应该还是拿到结果
    assert.equal(await r.pending, 'built');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('共享 watcher：模型思考时说的话不会被丢（两次等待之间的缝隙）', async () => {
  const { dir, env } = await tempEnv();
  try {
    // 第一次等待：什么都没等到
    const w = makeChatWatcher(env);
    const first = await raceChat(sleep(50).then(() => null), { watcher: w, everyMs: 20 });
    assert.equal(first.kind, 'done');

    // "模型在思考"这段时间用户说话了
    appendChat('user', '等一下我先倒杯水', {}, env);

    // 第二次等待（复用同一个 watcher）应该能看见
    const second = await raceChat(sleep(2000).then(() => null), { watcher: w, everyMs: 20 });
    assert.equal(second.kind, 'interrupted');
    assert.equal(second.text, '等一下我先倒杯水');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('sleepWithChat：睡一半被叫醒就返回那句话，睡满就返回 null', async () => {
  const { dir, env } = await tempEnv();
  try {
    const w = makeChatWatcher(env);
    assert.equal(await sleepWithChat(60, { watcher: w, everyMs: 20 }), null, '没人说话就睡满');

    setTimeout(() => appendChat('user', '喂', {}, env), 40);
    const hit = await sleepWithChat(3000, { watcher: w, everyMs: 20 });
    assert.equal(hit?.text, '喂');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
