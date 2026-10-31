/**
 * session-key.test.mjs — 同一支片子必须是**一个**会话。
 *
 * 踩过的坑（实测，2026-10-31）：浏览器扩展上报的是带追踪参数的完整地址
 * （`…/BV1g3xN6hEuw/?trackid=…&spm_id_from=…&vd_source=…`），模型手里是干净的
 * `…/BV1g3xN6hEuw/`。键以前就是整条 URL，于是同一支片子被拆成两个会话：
 * 台词写在 A 键下，交付时查 B 键 —— 结果里挂着「这一段还没有台词」，
 * 而台词其实写了。这个坑从根上堵在这里。
 */

process.env.DSH_WATCH_BRIDGE = '0';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadWatch, migrateKeys, sessionKey, watchPath } from '../src/watch-state.js';

const DIRTY = 'https://www.bilibili.com/video/BV1g3xN6hEuw/?trackid=web_pegasus_0.router'
  + '&spm_id_from=333.1007.tianma.1-1-1.click&vd_source=61b74a678d72993ef8e50ee5778da06d';
const CLEAN = 'https://www.bilibili.com/video/BV1g3xN6hEuw/';

test('B 站的三种写法（带参数 / 干净 / 小写）是同一个会话', () => {
  const a = sessionKey(DIRTY);
  const b = sessionKey(CLEAN);
  const c = sessionKey('https://www.bilibili.com/video/bv1g3xn6heuw');
  assert.equal(a, b);
  assert.equal(a, c);
  assert.match(a, /^bili:bv1g3xn6heuw$/);
});

test('别的站：去掉 query/hash，保留 host + 路径', () => {
  assert.equal(sessionKey('https://Example.com/a/b/?x=1#frag'), 'example.com/a/b');
  assert.notEqual(sessionKey('https://example.com/a/b'), sessionKey('https://example.com/a/c'));
});

test('本地文件只看文件名：不同写法算同一支', () => {
  assert.equal(sessionKey('D:\\deepseek\\3-Life\\movie.mp4'), 'movie.mp4');
  assert.equal(sessionKey('D:/films/movie.mp4'), 'movie.mp4');
  assert.equal(sessionKey('movie.mp4'), 'movie.mp4');
});

test('空值不抛错', () => {
  assert.equal(sessionKey(''), 'unknown');
  assert.equal(sessionKey(null), 'unknown');
});

test('迁移：旧键（整条 URL）并到新键，字段不丢', () => {
  const state = {
    [DIRTY]: { lines: { 0: { queue: [{ text: '旧台词', at: 10 }] } }, material: { 0: { image: 1 } }, at: 5 },
    [CLEAN]: { lines: { 60: { queue: [{ text: '新台词', at: 70 }] } }, at: 9 },
  };
  const changed = migrateKeys(state);
  assert.equal(changed, true);
  const keys = Object.keys(state);
  assert.deepEqual(keys, ['bili:bv1g3xn6heuw'], `应只剩一个键，实得 ${JSON.stringify(keys)}`);
  const node = state['bili:bv1g3xn6heuw'];
  assert.equal(node.lines[0].queue[0].text, '旧台词', '旧键的 0 段要并进来');
  assert.equal(node.lines[60].queue[0].text, '新台词', '新键自己的 60 段要留着');
  assert.equal(node.material[0].image, 1, '素材账本也要并');
  assert.equal(node.at, 9, 'at 取较新的那个');
});

test('迁移是幂等的：已经规范过的键不会再动', () => {
  const state = { 'bili:bv1g3xn6heuw': { at: 1 } };
  assert.equal(migrateKeys(state), false);
  assert.deepEqual(Object.keys(state), ['bili:bv1g3xn6heuw']);
});

test('loadWatch 读到旧键会自动迁移并落盘', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sk-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(watchPath(), JSON.stringify({ [DIRTY]: { at: 7, spoken: { 0: 7 } } }), 'utf8');

    const st = await loadWatch();
    assert.deepEqual(Object.keys(st), ['bili:bv1g3xn6heuw'], '内存里已经是新键');
    // 落盘也迁移了 —— 否则每次读都要再迁一次
    const onDisk = JSON.parse(await readFile(watchPath(), 'utf8'));
    assert.deepEqual(Object.keys(onDisk), ['bili:bv1g3xn6heuw']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
