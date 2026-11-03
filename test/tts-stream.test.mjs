/**
 * tts-stream.test.mjs — 常驻合成器那条 JSON 行协议的回归。
 *
 * 这里**不碰网络、不碰 ffplay**：用一个假 daemon（node 脚本冒充）验证
 * 「发请求 → first → done」「error → reject」「进程死 → 全部 reject」这三条。
 * 真引擎的行为（建连 700ms、首块 200ms）在 `examples/voice-edge-tts/stream/daemon.py`
 * 的注释里有实测数据，不适合放进单测。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pythonFor, startStream } from '../examples/voice-edge-tts/stream/client.mjs';

const FAKE = `
process.stdout.write(JSON.stringify({ ev: 'boot', voice: 'v', rate: '+0%' }) + '\\n');
process.stdout.write(JSON.stringify({ ev: 'ready' }) + '\\n');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const req = JSON.parse(line);
    if (req.op === 'stop') process.exit(0);
    if (req.text === 'boom') {
      process.stdout.write(JSON.stringify({ ev: 'error', id: req.id, reason: 'boom' }) + '\\n');
      continue;
    }
    if (req.op === 'prefetch') {
      setTimeout(() => process.stdout.write(JSON.stringify({ ev: 'done', id: req.id, ms: 5 }) + '\\n'), 5);
      continue;
    }
    setTimeout(() => process.stdout.write(JSON.stringify({ ev: 'first', id: req.id, ms: 7 }) + '\\n'), 5);
    setTimeout(() => process.stdout.write(JSON.stringify({ ev: 'done', id: req.id, ms: 9 }) + '\\n'), 10);
  }
});
`;

async function withFake(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'tts-stream-'));
  const script = join(dir, 'fake-daemon.mjs');
  await writeFile(script, FAKE, 'utf8');
  const s = startStream({ python: process.execPath, script, args: [script] });
  try {
    await fn(s);
  } finally {
    s.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

test('pythonFor：同目录的 python.exe 优先', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tts-py-'));
  const win = process.platform === 'win32';
  const name = win ? 'python.exe' : 'python3';
  await writeFile(join(dir, name), '', 'utf8');
  try {
    assert.equal(pythonFor(join(dir, win ? 'edge-tts.exe' : 'edge-tts')), join(dir, name));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('pythonFor：没有同目录 python 时返回 null（宁可退回老路，不瞎猜）', () => {
  assert.equal(pythonFor(null), null);
  assert.equal(pythonFor(join(tmpdir(), 'nowhere', 'edge-tts.exe')), null);
});

test('say：first 先到、done 后到，first 通过回调先报出去', async () => {
  await withFake(async (s) => {
    const order = [];
    const r = await s.say('一句话', { onFirst: (ms) => order.push(`first:${ms}`) });
    assert.deepEqual(r, { first: 7, done: 9 });
    assert.deepEqual(order, ['first:7']);
  });
});

test('prefetch 失败不 reject（预取本来就是"尽力而为"）', async () => {
  await withFake(async (s) => {
    const r = await s.prefetch('boom');
    assert.deepEqual(r, { failed: true });
  });
});

test('say 拿到 error 事件 → reject，并记住原因', async () => {
  await withFake(async (s) => {
    await assert.rejects(() => s.say('boom'), /boom/);
    assert.equal(s.lastError, 'boom');
    // 一句失败不该把整条通道打死：下一句照常
    const ok = await s.say('好的');
    assert.equal(ok.done, 9);
  });
});

test('daemon 退出后 alive=false，后续请求直接 reject（不挂在超时上）', async () => {
  await withFake(async (s) => {
    assert.equal(s.alive, true);
    s.stop();
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(s.alive, false);
    await assert.rejects(() => s.say('再说一句'), /daemon/);
  });
});
