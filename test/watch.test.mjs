/**
 * watch.test.mjs — 「一起看」的段逻辑与交付时机。
 *
 * 这些数字决定体验：段太长不连贯，lead 太大提前剧透，重复交付会让人被同一段说两次。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  deliveryState, segmentStart, WATCH_LEAD, WATCH_SEGMENT,
} from '../src/watch.js';
import { validateWatchArgs, watchToolSpec } from '../src/tool-spec.js';

test('segmentStart: 按段长向下取整', () => {
  assert.equal(segmentStart(0, 120), 0);
  assert.equal(segmentStart(10, 120), 0);
  assert.equal(segmentStart(119.9, 120), 0);
  assert.equal(segmentStart(120, 120), 120);
  assert.equal(segmentStart(125, 60), 120);
  assert.equal(segmentStart(-5, 120), 0);
});

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


test('默认参数是"120 秒一段、提前 15 秒说"', () => {
  assert.equal(WATCH_SEGMENT, 120);
  assert.equal(WATCH_LEAD, 15);
});

test('validateWatchArgs: input 可省略（自动探测），给了就必须非空', () => {
  assert.deepEqual(validateWatchArgs({ input: 'a.mp4' }), []);
  assert.deepEqual(validateWatchArgs({ input: 'a.mp4', cursor: 30, segment: 60, cells: 6 }), []);
  assert.deepEqual(validateWatchArgs({}), [], '省略 input 是合法的：从系统媒体控件反查');
  assert.ok(validateWatchArgs({ input: '' }).some((p) => /input/.test(p)), '空字符串要拒');
  assert.ok(validateWatchArgs({ input: 'a', cursor: -1 }).some((p) => /cursor/.test(p)));
  assert.ok(validateWatchArgs({ input: 'a', segment: 5 }).some((p) => /segment/.test(p)));
  assert.ok(validateWatchArgs({ input: 'a', cells: 12 }).some((p) => /cells/.test(p)));
});

test('watchToolSpec: 告诉模型"别复述剧情"和"读不到就问，不要猜"', () => {
  const spec = watchToolSpec();
  assert.equal(spec.name, 'watch_together');
  assert.match(spec.description, /do not retell the plot/i);
  assert.match(spec.description, /SMTC|media session/i);
  assert.equal(spec.parameters.input.required, undefined, 'input 不再必填：可以自动探测');
  assert.ok(spec.output?.schema, '输出 schema 必须存在，否则注册就崩');
});
