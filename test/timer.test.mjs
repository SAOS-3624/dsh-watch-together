/**
 * timer.test.mjs — 钟的两条基础设施：滴答（startTicker）与叫醒（wakeSession）。
 *
 * 叫醒"该在什么时候发生"的判定不在本文件——它跟着播放进度走，在 position.shouldSpeak。
 * 这里只验证钟本身：滴答会跑、能停、上一轮没跑完时不叠车。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { startTicker } from '../src/timer.js';

test('startTicker: 会跑、能停、不叠车', async () => {
  let n = 0;
  let concurrent = 0;
  let maxConcurrent = 0;
  const t = startTicker({
    everyMs: 5,
    tick: async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      n += 1;
      await new Promise((r) => setTimeout(r, 20));
      concurrent -= 1;
    },
  });
  await new Promise((r) => setTimeout(r, 60));
  t.dispose();
  const after = n;
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(after >= 1, '应该跑过');
  assert.equal(n, after, 'dispose 之后不该再跑');
  assert.equal(maxConcurrent, 1, '上一轮没跑完时不能叠上去');
});
