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
  assert.deepEqual(out.map((x) => x.at), [61.2, 95.4, 120, 152.8]);
  // 第 3 句的理想位置是 120，离它最近的字幕起点是 152.8（差了 32.8 秒，超出半个槽位），
  // 所以退回均分。**不许再回头取 150** —— 旧实现会给出 152.8 → 150 这种倒序。
  for (let i = 1; i < out.length; i += 1) {
    assert.ok(out[i].at > out[i - 1].at, `第 ${i} 句不能比前一句还早`);
  }
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

/**
 * 2026-10-31 晚的实报：16 句台词挂在一个 3 分钟的段上，全被钉进**段首 62 秒**里
 * （181.6 → 244.2），钟每 2 秒打一拍、一拍发一句 —— 用户听到的是"机关枪突突突"，
 * 而且后 14 句比画面早一到两分钟。
 *
 * 病根：旧实现"取这一段最前面的 N 个字幕起点"，句数一多就全挤在开头。
 */
test('很多句台词要铺满整段，不许全挤在段首（机关枪实报）', () => {
  // 真实素材：一条 3 分钟的字幕，平均每 2 秒一个起点
  const dense = [];
  for (let t = 180; t < 360; t += 2) dense.push({ from: t, to: t + 2, text: `第${t}秒` });
  const items = Array.from({ length: 16 }, (_, i) => ({ at: null, text: `词${i}` }));

  const out = pinTimes(items, 180, 180, dense);
  const ats = out.map((x) => x.at);

  assert.equal(ats.length, 16);
  for (let i = 1; i < ats.length; i += 1) assert.ok(ats[i] > ats[i - 1], '必须严格递增');
  const span = ats[ats.length - 1] - ats[0];
  assert.ok(span > 150, `要铺满 180 秒的段（实得 ${span.toFixed(1)} 秒）`);

  // 相邻两句的间隔要接近均分（180/16 ≈ 11 秒），绝不能是 2 秒一条
  const gaps = ats.slice(1).map((t, i) => t - ats[i]);
  const minGap = Math.min(...gaps);
  assert.ok(minGap >= 6, `相邻两句至少要隔 6 秒（实得最小 ${minGap.toFixed(1)} 秒）`);
});

test('字幕只在开头挤成一堆时，不许把整批词都塞进开头那几秒', () => {
  // 开头四句字幕挨着（60/61/62/63），后面 100 多秒没有字幕起点
  const head = [60, 61, 62, 63].map((t) => ({ from: t, to: t + 0.5, text: `开头${t}` }));
  const items = Array.from({ length: 6 }, (_, i) => ({ at: null, text: `词${i}` }));
  const ats = pinTimes(items, 60, 120, head).map((x) => x.at);
  // 第一句贴 60，其余按均分走（60/80/100/120/140/160）——
  // 旧实现会把 60/61/62/63 全用掉，四句话在 3 秒里说完
  assert.deepEqual(ats, [60, 80, 100, 120, 140, 160]);
});
