import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendChat, readChat } from '../src/chat-store.js';
import { readBridge } from '../src/position-bridge.js';
import { startChatServer } from '../src/chat-server.js';

const tempEnv = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chat-server-'));
  return { dir, env: { DSH_VIDEO_CACHE_DIR: dir } };
};

async function withServer(fn) {
  const { dir, env } = await tempEnv();
  const srv = await startChatServer({ port: 0, env });
  const port = srv.server.address().port;
  try {
    await fn({ env, port });
  } finally {
    await srv.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('chat server: 只接受扩展/本机页面的跨域来源', async () => {
  await withServer(async ({ env, port }) => {
    const base = 'http://127.0.0.1:' + port;
    const evil = await fetch(base + '/api/say', {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'text/plain' },
      body: JSON.stringify({ text: '注入' }),
    });
    assert.equal(evil.status, 403);
    assert.equal(readChat(env).length, 0, '被拒的跨域请求不能写进聊天流');

    const spoof = await fetch(base + '/api/position', {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ pos: 99 }),
    });
    assert.equal(spoof.status, 403);
    assert.equal(await readBridge({ env }), null, '被拒的跨域请求不能伪造位置');

    const ext = await fetch(base + '/api/say', {
      method: 'POST',
      headers: { origin: 'chrome-extension://abc123', 'content-type': 'application/json' },
      body: JSON.stringify({ text: '扩展说的' }),
    });
    assert.equal(ext.status, 200);
    assert.equal(ext.headers.get('access-control-allow-origin'), 'chrome-extension://abc123');
    assert.equal((await ext.json()).ok, true);
    assert.equal(readChat(env).at(-1).text, '扩展说的');

    const local = await fetch(base + '/api/say', {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:' + port, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '页面说的' }),
    });
    assert.equal(local.status, 200);
  });
});

test('chat server: 文件被清短后，页面游标要能收到 reset', async () => {
  await withServer(async ({ env, port }) => {
    appendChat('user', '一', {}, env);
    appendChat('user', '二', {}, env);
    const base = 'http://127.0.0.1:' + port;
    const stale = await fetch(base + '/api/messages?since=99').then(r => r.json());
    assert.equal(stale.reset, true);
    assert.equal(stale.total, 2);
    assert.deepEqual(stale.msgs.map(m => m.text), ['一', '二']);

    const normal = await fetch(base + '/api/messages?since=1').then(r => r.json());
    assert.equal(normal.reset, undefined);
    assert.equal(normal.msgs.length, 1);
    assert.equal(normal.msgs[0].text, '二');
  });
});
