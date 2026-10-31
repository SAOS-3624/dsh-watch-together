/**
 * interject-build.test.mjs — 建图期间也能插话（端到端）。
 *
 * 这是"一直想当然以为接好了"的那条路：`raceChat` 有单测（test/interrupt.test.mjs），
 * 但 `runWatchPass` 里 `built.kind === 'interrupted'` 那个分支从来没被跑过 ——
 * 万一哪次改动把 raceChat 摘掉、或者 watcher 换成新建的实例，单测照样全绿。
 *
 * 两件事一起验：
 *   1. 建图 1.2 秒，0.2 秒时用户说话 → 工具**立刻**返回那句话（不等图）
 *   2. 图**继续在后台建完**并落进缓存 —— 用户回完再调一次就是命中，不会重跑
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendChat } from '../src/chat-store.js';
import { chatWatcherShared } from '../src/interrupt.js';
import { runWatchPass } from '../src/watch-run.js';
import { sessionKey } from '../src/watch.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('建图期间插话：立刻回那句，图在后台建完并落缓存', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'interject-build-'));
  const env = { ...process.env, DSH_VIDEO_CACHE_DIR: dir };
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    // 基线：watcher 以"此刻已有几条"为起点，之后写进去的才算插话
    chatWatcherShared(env);

    let buildFinishedAt = 0;
    const cache = new Map();
    const t0 = Date.now();

    // 0.2 s 时用户说了一句话 —— 此时建图还没结束
    const talk = setTimeout(() => appendChat('user', '这里在说什么？', {}, env), 200);

    const r = await runWatchPass({ input: 'a.mp4', cursor: 10, segment: 120 }, {
      cache,
      saveImage: async () => Buffer.from('x'),
      // 建图故意慢：1.2 s（轮询 500 ms 一拍，够撞上）
      runStoryboard: async () => {
        await sleep(1200);
        buildFinishedAt = Date.now();
        return { sheets: [{ png: Buffer.from('png'), cells: [] }] };
      },
      formatManifest: () => 'MANIFEST',
      readBrowser: async () => ({ pos: 10, dur: 900, paused: false, url: 'file:///a.mp4' }),
    });
    clearTimeout(talk);

    const elapsed = Date.now() - t0;
    assert.equal(r.building, true, '应该报"图还在后台建"');
    assert.equal(r.chat?.text, '这里在说什么？', '要把用户那句话原样带回去');
    assert.equal(r.images.length, 0, '图还没建完，不该有图');
    assert.ok(elapsed < 1100, `应该在建完之前就返回，实际 ${elapsed}ms`);
    assert.match(r.text, /先回这一句/);

    // 图没有被掐掉：再等一会儿，它得自己建完并落进缓存
    await sleep(1200);
    assert.ok(buildFinishedAt > 0, '建图任务不该被取消');
    const key = `${sessionKey('a.mp4')}|0`;
    assert.ok(cache.get(key)?.png, '建完的段要落进缓存，下次调用直接命中');
    assert.equal(cache.get(key)?.manifest, 'MANIFEST');
  } finally {
    delete process.env.DSH_VIDEO_CACHE_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});
