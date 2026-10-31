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
  BRIDGE_FILE, bridgeEnabled, bridgePath, normalizeBridgeSample, readBridge, readHello,
  writeBridge, writeHello,
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

/**
 * `Number(null) === 0`：没报时长 / 没报位置时，转成数字就成了"0 秒"。
 * 时长基线一旦被写成 0，下一次真实读数（600 秒）就会被判成"换片了"，陪看当场停表。
 */
test('空值不许变成 0：没报 dur 就是 null，没报 pos 就是没有位置', async () => {
  const { dir, env } = await tempEnv();
  try {
    const s = normalizeBridgeSample({ pos: 10, dur: null, title: null }, 1000);
    assert.equal(s.dur, null, '没报时长 → null，不是 0');
    assert.equal(s.title, null);

    await writeFile(join(dir, BRIDGE_FILE), JSON.stringify({ pos: 10, dur: null, at: 1000 }), 'utf8');
    const got = await readBridge({ env, now: 1000 });
    assert.equal(got.dur, null, '读回来也必须是 null');

    await writeFile(join(dir, BRIDGE_FILE), JSON.stringify({ pos: null, at: 1000 }), 'utf8');
    assert.equal(await readBridge({ env, now: 1000 }), null, 'pos 为空 = 没有位置，不能当成 0 秒');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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


// ---------------------------------------------------------------- 心跳

test('心跳：扩展打过招呼就留痕，没打过就是没有', async () => {
  const { dir, env } = await tempEnv();
  try {
    assert.equal(await readHello({ env }), null, '什么都没发生的时候必须是 null');
    await writeHello({ version: '0.1.0' }, { env, now: 5000 });
    const h = await readHello({ env, now: 8000 });
    assert.equal(h.version, '0.1.0');
    assert.equal(h.ageMs, 3000);
    // 心跳**没有**过期概念：它证明的是"曾经连通过"，几小时前也算数
    assert.ok(await readHello({ env, now: 5000 + 6 * 3600_000 }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('HTTP：扩展打招呼 → 能查到一个版本号，用来区分"没装"和"没视频"', async () => {
  const { dir, env } = await tempEnv();
  const srv = await startChatServer({ port: 0, env });
  const port = srv.server.address().port;
  try {
    const before = await fetch(`http://127.0.0.1:${port}/api/hello`).then((r) => r.json());
    assert.equal(before.ok, false);

    await fetch(`http://127.0.0.1:${port}/api/hello`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: '0.1.0' }),
    });

    const after = await fetch(`http://127.0.0.1:${port}/api/hello`).then((r) => r.json());
    assert.equal(after.ok, true);
    assert.equal(after.version, '0.1.0');
  } finally {
    await srv.close();
    await rm(dir, { recursive: true, force: true });
  }
});
