/**
 * pin-times.test.mjs — 没写 `at` 的台词，时刻要贴着**真实句子起点**，不能均匀铺开。
 *
 * 用户实报（2026-10-31 晚）：「台词还是比画面早」。截图里那几段台词的标签是
 * 01:51.3 / 02:39.3 这种整段等分的时刻，而画面里的那句话其实更晚才出现。
 *
 * 旧逻辑把 n 句台词均匀铺在段内（`from + i*size/n`），画面并不会按这个节奏走。
 * 现在优先用字幕（CC 或 ASR 时间码）里这一段的句子起点，分完还有剩才退回均匀。
 */

process.env.DSH_WATCH_BRIDGE = '0';

import test from 'node:test';
import assert from 'node:assert/strict';

import { pinTimes } from '../src/watch-lines.js';

const cues = [
  { from: 61.2, to: 64.0, text: '第一句' },
  { from: 95.4, to: 99.0, text: '第二句' },
  { from: 152.8, to: 156.0, text: '第三句' },
];

test('贴字幕句子起点：不再按段长等分', () => {
  const items = [{ at: null, text: 'A' }, { at: null, text: 'B' }, { at: null, text: 'C' }];
  const out = pinTimes(items, 60, 120, cues);
  assert.deepEqual(out.map((x) => x.at), [61.2, 95.4, 152.8]);
});

test('已经写了 at 的句子不动，后续没写 at 的接着往后找', () => {
  const items = [{ at: null, text: 'A' }, { at: 100, text: 'B' }, { at: null, text: 'C' }];
  const out = pinTimes(items, 60, 120, cues);
  assert.equal(out[0].at, 61.2, '第一句贴第一个起点');
  assert.equal(out[1].at, 100, '已经写好的 at 不许改');
  assert.equal(out[2].at, 152.8, '第三句要越过 100 秒往后找');
});

test('字幕用完之后退回均匀铺开（不许全部挤在段首）', () => {
  const items = [{ at: null, text: 'A' }, { at: null, text: 'B' }, { at: null, text: 'C' }, { at: null, text: 'D' }];
  const out = pinTimes(items, 60, 120, cues);
  assert.equal(out.length, 4);
  assert.deepEqual(out.slice(0, 3).map((x) => x.at), [61.2, 95.4, 152.8]);
  assert.equal(out[3].at, 60 + (3 * 120) / 4, '没字幕可用了就按等分补');
});

test('没有字幕时行为与老实现一致（等分）', () => {
  const items = [{ at: null, text: 'A' }, { at: null, text: 'B' }];
  const out = pinTimes(items, 300, 60, []);
  assert.deepEqual(out.map((x) => x.at), [300, 330]);
});

test('段外的字幕不参与（前一秒的起点不算这一段的）', () => {
  const items = [{ at: null, text: 'A' }];
  const out = pinTimes(items, 200, 60, [{ from: 195, to: 199, text: '属于上一段' }]);
  assert.equal(out[0].at, 200, '只能等分补齐，不能借用上一段的句子起点');
});
