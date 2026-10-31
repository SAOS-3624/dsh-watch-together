/**
 * delivery-gate.test.mjs — 交付门槛：**没有台词的交付不算完成**。
 *
 * 背景：整场陪看跑下来，模型一直只交图、一条台词都没写（用户的原话是
 * "为什么你的台词前面…"、"我没看到你任何和视频相关的你说的台词"）。
 * 现在把话说死在代码里 —— 这一段没有台词就：
 *   · 不写 `spoken`（等于"没说过"）
 *   · 不推进 `lastDelivered`（下一次调用还落回这一段）
 *   · 结果最前面顶一条 `[DELIVERY INCOMPLETE]`
 *
 * 这条用例验的就是这三件事，以及"写了台词之后立刻放行"。
 * 别的老用例验的是循环/等待/换片，用 `DSH_WATCH_REQUIRE_LINES=0` 把门槛关掉。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runWatchPass } from '../src/watch-run.js';
import { saveLines } from '../src/watch-lines.js';
import { loadWatch } from '../src/watch-state.js';

const deps = () => ({
  cache: new Map(),
  saveImage: async ({ data }) => data,
  runStoryboard: async () => ({ sheets: [{ png: Buffer.from('x'), cells: [] }] }),
  formatManifest: () => 'm',
  probe: async () => ({ ok: true, sessions: [] }),
  browserPort: 1,
  readBrowser: async () => ({ pos: 106, dur: 600, paused: false, url: 'file:///a.mp4' }),
});

test('没有台词就交付 → 不算完成：不说、不推进、结果头顶 [DELIVERY INCOMPLETE]', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gate-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  delete process.env.DSH_WATCH_REQUIRE_LINES;      // 门槛默认开
  try {
    const args = { input: 'a.mp4', cursor: 106, segment: 120, lead: 15 };
    const r = await runWatchPass({ ...args }, deps());

    assert.equal(r.ok, true);
    assert.equal(r.complete, false, '没台词不算交付完成');
    assert.match(r.text, /\[DELIVERY INCOMPLETE\]/, '必须在最前面顶一条缺台词');
    assert.match(r.text, /没有台词/, '要明确说缺什么');

    // 状态：这一段既没进 spoken，也没成为 lastDelivered
    const st = await loadWatch();
    const [sk] = Object.keys(st).filter((k) => k !== 'version' && k !== '$schema');
    const s = st[sk] ?? {};
    const spoken = s.spoken ?? {};
    assert.ok(!(120 in spoken) && !(0 in spoken), `不该写 spoken，实得 ${JSON.stringify(spoken)}`);
    assert.notEqual(s.lastDelivered, 0, '不该把 lastDelivered 推到这一段');
    assert.ok(s.missingLines && Object.keys(s.missingLines).length > 0, '应记下欠账');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('补上台词之后再交付 → 放行，且欠账清掉', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gate2-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  delete process.env.DSH_WATCH_REQUIRE_LINES;
  try {
    const args = { input: 'a.mp4', cursor: 106, segment: 120, lead: 15 };
    await runWatchPass({ ...args }, deps());                    // 第一次：欠台词

    await saveLines('a.mp4', [{ from: 0, at: 100, text: '这一段的台词写上了。' }]);
    const r = await runWatchPass({ ...args }, deps());

    assert.equal(r.complete, true, '有台词才算交付完成');
    assert.doesNotMatch(r.text, /\[DELIVERY INCOMPLETE\]/, '不该还挂着缺台词');

    const st = await loadWatch();
    const [sk] = Object.keys(st).filter((k) => k !== 'version' && k !== '$schema');
    const s = st[sk] ?? {};
    assert.equal(s.lastDelivered, 0, '有台词才推进 lastDelivered');
    assert.ok(!(s.missingLines?.[0]), '欠账要清掉');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('DSH_WATCH_REQUIRE_LINES=0 时门槛关掉（老用例用来验别的行为）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gate3-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  process.env.DSH_WATCH_REQUIRE_LINES = '0';
  try {
    const r = await runWatchPass(
      { input: 'a.mp4', cursor: 106, segment: 120, lead: 15 }, deps(),
    );
    assert.equal(r.speaking, true, '关掉门槛后照旧交付');
    assert.equal(r.complete, true, '关掉门槛时 complete 也跟着为真');
    assert.doesNotMatch(r.text, /\[DELIVERY INCOMPLETE\]/);
  } finally {
    delete process.env.DSH_WATCH_REQUIRE_LINES;
    await rm(dir, { recursive: true, force: true });
  }
});
