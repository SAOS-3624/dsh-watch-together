/**
 * watch.test.mjs — 「一起看」的段逻辑与交付时机。
 *
 * 这些数字决定体验：段太长不连贯，lead 太大提前剧透，重复交付会让人被同一段说两次。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  deliveryState, WATCH_LEAD,
} from '../src/watch.js';
import { validateWatchArgs, watchToolSpec } from '../src/tool-spec.js';

test('deliveryState: 到段末前 lead 秒才算该说', () => {
  const size = 120;
  const early = deliveryState({ cursor: 60, segment: 0, size, lead: 15 });
  assert.equal(early.due, false);
  assert.equal(early.remaining, 60);

  const atLead = deliveryState({ cursor: 105, segment: 0, size, lead: 15 });
  assert.equal(atLead.due, true, '剩 15 秒刚好进交付区');

  const over = deliveryState({ cursor: 130, segment: 0, size, lead: 15 });
  assert.equal(over.overdue, true, '用户已经看到下一段，也要交付，否则这段永远不说');
});


test('交付点是段末前 15 秒（段长本身由 batches.js 定义，这里不再锁死）', () => {
  assert.equal(WATCH_LEAD, 15);
  // 段长只有一处定义：`batches.DEFAULT_SEGMENT`。以前这里还断言 WATCH_SEGMENT === 120，
  // 等于给一个生产路径根本不用的值上了锁。
  const s = deliveryState({ cursor: 0, segment: 0, size: 300 });
  assert.equal(s.segmentEnd, 300);
  assert.equal(s.due, false);
});

test('validateWatchArgs: input 可省略（自动探测），给了就必须非空', () => {
  assert.deepEqual(validateWatchArgs({ input: 'a.mp4' }), []);
  assert.deepEqual(validateWatchArgs({ input: 'a.mp4', cursor: 30, segment: 60, cells: 6 }), []);
  assert.deepEqual(validateWatchArgs({}), [], '省略 input 是合法的：从系统媒体控件反查');
  assert.ok(validateWatchArgs({ input: '' }).some((p) => /input/.test(p)), '空字符串要拒');
  assert.ok(validateWatchArgs({ input: 'a', cursor: -1 }).some((p) => /cursor/.test(p)));
  assert.ok(validateWatchArgs({ input: 'a', segment: 5 }).some((p) => /segment/.test(p)));
  assert.ok(validateWatchArgs({ input: 'a', cells: 12 }).some((p) => /cells/.test(p)));
  // 默认段长是 300（batches.DEFAULT_SEGMENT），不是旧代码里的 120：
  // lead=150 在默认段长下合法，不能被误拦。
  assert.deepEqual(validateWatchArgs({ lead: 150 }), []);
  assert.ok(validateWatchArgs({ lead: 300 }).length > 0, 'lead 必须小于默认段长 300');
  // at 省略或显式 null 都表示“到段首再说”，不能因为 Number(null)===0 被拒。
  assert.deepEqual(validateWatchArgs({ lines: [{ from: 180, at: null, text: 'x' }] }), []);
  assert.deepEqual(validateWatchArgs({ lines: [{ from: 180, text: 'x' }] }), []);
});

test('watchToolSpec: 告诉模型"别复述剧情"和"读不到就问，不要猜"', () => {
  const spec = watchToolSpec();
  assert.equal(spec.name, 'watch_together');
  assert.match(spec.description, /do not retell the plot/i);
  assert.match(spec.description, /extension/i, '要告诉模型位置也能从扩展来');
  assert.match(spec.description, /do not guess/i, '读不到就问，别猜');
  assert.equal(spec.parameters.input.required, undefined, 'input 不再必填：可以自动探测');
  assert.ok(spec.output?.schema, '输出 schema 必须存在，否则注册就崩');
});
