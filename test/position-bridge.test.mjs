/**
 * position-bridge.test.mjs — 浏览器扩展上报位置的这条通道。
 *
 * 守住三件事：
 *   ① 坏数据不进来（位置不是数字就直接扔）
 *   ② 太旧的当作没有（浏览器关了、扩展停用了，不能让陪看拿着陈旧位置说话）
 *   ③ 服务端真的收得到、读得回（转一圈，含"落盘之后另一个进程能读到"）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BRIDGE_FILE, bridgeEnabled, bridgePath, normalizeBridgeSample, readBridge, writeBridge,
} from '../src/position-bridge.js';
import { startChatServer } from '../src/chat-server.js';

const tempEnv = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-'));
  return { dir, env: { DSH_VIDEO_CACHE_DIR: dir } };
};

test('规范化：位置必须是有效数字，否则整条丢弃', () => {
  assert.equal(normalizeBridgeSample({ pos: 'abc' }, 1000), null);
  assert.equal(normalizeBridgeSample({ pos: -1 }, 1000), null);
  assert.equal(normalizeBridgeSample({}, 1000), null);
  const ok = normalizeBridgeSample({ pos: '12.5', dur: '600', title: 'x' }, 1000);
  assert.equal(ok.pos, 12.5);
  assert.equal(ok.dur, 600);
  assert.equal(ok.at, 1000, '时刻用服务端收到的时刻，不信上报方的时钟');
});

test('存进去再读出来：数值和标题都在', async () => {
  const { dir, env } = await tempEnv();
  try {
    await writeBridge(
      { pos: 42.5, dur: 600, title: '某片', url: 'https://x/y', paused: false },
      { env, now: 10_000 },
    );
    const got = await readBridge({ env, now: 12_000 });
    assert.equal(got.pos, 42.5);
    assert.equal(got.dur, 600);
    assert.equal(got.title, '某片');
    assert.equal(got.ageMs, 2000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('太旧就当没有（扩展停了 / 浏览器关了）', async () => {
  const { dir, env } = await tempEnv();
  try {
    await writeBridge({ pos: 10, dur: 100 }, { env, now: 1000 });
    assert.ok(await readBridge({ env, now: 1000 + 5000 }), '正好 5 秒还算新鲜（边界含）');
    assert.equal(await readBridge({ env, now: 1000 + 5001 }), null, '超过 5 秒就不认了');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('坏文件不炸：读到半截 JSON 就当作没有', async () => {
  const { dir, env } = await tempEnv();
  try {
    await writeFile(join(dir, BRIDGE_FILE), '{"pos": 1', 'utf8');
    assert.equal(await readBridge({ env }), null);
    assert.ok(bridgePath(env).endsWith(BRIDGE_FILE));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('DSH_WATCH_BRIDGE=0 可以整条关掉（测试/排障用）', async () => {
  const { dir, env } = await tempEnv();
  try {
    await writeBridge({ pos: 10 }, { env, now: 1000 });
    const off = { ...env, DSH_WATCH_BRIDGE: '0' };
    assert.equal(bridgeEnabled(off), false);
    assert.equal(await readBridge({ env: off, now: 1000 }), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('HTTP 转一圈：扩展 POST 一个位置，另一个进程能读回来', async () => {
  const { dir, env } = await tempEnv();
  const srv = await startChatServer({ port: 0, env });
  const port = srv.server.address().port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/position`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pos: 77.5, dur: 900, title: 't', paused: true }),
    });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, pos: 77.5 });

    // 落盘了 —— 这正是 CLI（另一个进程）能读到的原因
    const disk = await readBridge({ env });
    assert.equal(disk.pos, 77.5);
    assert.equal(disk.paused, true);

    const g = await fetch(`http://127.0.0.1:${port}/api/position`).then((x) => x.json());
    assert.equal(g.pos, 77.5);
  } finally {
    await srv.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('HTTP：坏数据返回 400，不污染已有的位置', async () => {
  const { dir, env } = await tempEnv();
  const srv = await startChatServer({ port: 0, env });
  const port = srv.server.address().port;
  try {
    await fetch(`http://127.0.0.1:${port}/api/position`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pos: 30 }),
    });
    const bad = await fetch(`http://127.0.0.1:${port}/api/position`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pos: 'nope' }),
    });
    assert.equal(bad.status, 400);
    const still = await readBridge({ env });
    assert.equal(still.pos, 30, '坏请求不该把上一次的好位置冲掉');
  } finally {
    await srv.close();
    await rm(dir, { recursive: true, force: true });
  }
});
