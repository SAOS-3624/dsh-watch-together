import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { makePlan } from '../src/batches.js';
import { sessionKey, saveLines } from '../src/watch.js';
import { recapFor, recapOptions } from '../src/recap.js';

const INPUT = 'https://example.com/video/long';

async function withCues(cues, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'recap-'));
  const env = { DSH_VIDEO_CACHE_DIR: dir };
  try {
    const file = join(dir, `subs-${sessionKey(INPUT)}.json`);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ cues }), 'utf8');
    return await fn(env);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('第一段没有前情', async () => {
  const plan = makePlan({ segment: 300, ramp: [] });
  assert.equal(await recapFor(INPUT, { plan, segStart: 0, env: {} }), '');
});

test('长视频取上一两段的缓存字幕，且不包含未来段', async () => {
  const cues = [
    { from: 10, to: 12, text: '这是第一段里一句足够长的字幕内容' },
    { from: 20, to: 22, text: '第一段还有另一句值得带上的信息' },
    { from: 310, to: 312, text: '第二段这一句说明刚才发生了什么' },
    { from: 620, to: 622, text: '这是当前段，绝不能提前出现' },
  ];
  await withCues(cues, async (env) => {
    const plan = makePlan({ segment: 300, ramp: [] });
    const out = await recapFor(INPUT, { plan, segStart: 600, env, maxSegments: 2 });
    assert.match(out, /\[前情\]/);
    assert.match(out, /第一段里一句/);
    assert.match(out, /第二段这一句/);
    assert.doesNotMatch(out, /当前段/);
    assert.match(out, /00:00–05:00|00:05–10:00/);
  });
});

test('maxChars 截断，不会把整段字幕塞回去', async () => {
  const cues = Array.from({ length: 20 }, (_, i) => ({
    from: i * 15 + 1,
    to: i * 15 + 3,
    text: `第一段第 ${i} 句很长很长的字幕，用来测试前情上限`,
  }));
  await withCues(cues, async (env) => {
    const plan = makePlan({ segment: 300, ramp: [] });
    const out = await recapFor(INPUT, { plan, segStart: 300, env, maxSegments: 1, maxChars: 90 });
    assert.ok(out.length <= 90, `too long: ${out.length}`);
    assert.match(out, /…$/);
  });
});

test('前情默认关闭；env/args 才开，且参数有上下限', () => {
  assert.deepEqual(recapOptions({ args: {}, env: {} }), {
    enabled: false, maxSegments: 2, maxChars: 420,
  });
  assert.equal(recapOptions({ args: {}, env: { DSH_WATCH_RECAP: '1' } }).enabled, true);
  assert.equal(recapOptions({
    args: { recap: false }, env: { DSH_WATCH_RECAP: '1' },
  }).enabled, false, '显式 false 要能覆盖 env');
  assert.deepEqual(recapOptions({
    args: { recap: true, recapSegments: 9, recapMaxChars: 5 }, env: {},
  }), { enabled: true, maxSegments: 3, maxChars: 80 });
});

test('前情只读字幕原句，不读模型写过的台词槽', async () => {
  const cues = [{ from: 10, to: 12, text: '这是本地字幕里的一句原话，足够长' }];
  await withCues(cues, async (env) => {
    await saveLines(INPUT, [{ from: 0, text: '这是模型二手总结，不该当前情' }], { env });
    const plan = makePlan({ segment: 300, ramp: [] });
    const out = await recapFor(INPUT, { plan, segStart: 300, env, maxSegments: 1 });
    assert.match(out, /本地字幕里的一句原话/);
    assert.doesNotMatch(out, /模型二手总结/);
  });
});
