/**
 * position.test.mjs — "读数 + 读数时刻"的可信度模型。
 *
 * 前提：位置只来自浏览器调试端口的 `video.currentTime`，
 * 而我们是**每 15 秒才真读一次**，中间十几秒靠外推。
 *
 * 所以两件事必须分开看：
 *   pos     —— 最近一次读到的值（本身是准的）
 *   updated —— 它是什么时候读到的（决定现在还准不准）
 *
 * > 这套模型原先是给 Windows 媒体控件（SMTC）写的：它只在事件时刷新，
 * > 实测隔过 143 / 216 秒，外推上限得开到 180 秒。SMTC 已删除，
 * > 上限收到 60 秒（≈ 连错过 3 次读取），FRESH_MS 涨到 20 秒（要盖住一个读取周期）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FRESH_MS, MAX_EXTRAPOLATE_MS, estimate, makeAnchor, shouldSpeak,
} from '../src/position.js';

const T0 = 1_700_000_000_000;   // 任意基准时刻

test('刚读到的位置直接信（fresh）', () => {
  const a = makeAnchor({ pos: 128.6, dur: 1087, status: 'playing', updated: T0 }, T0);
  const e = estimate(a, T0 + 3000);
  assert.equal(e.confidence, 'fresh');
  assert.ok(Math.abs(e.pos - 128.6) < 0.01, '不该外推，直接用读到的值');
});

test('一个读取周期之内：按墙钟推，这是常态不是异常', () => {
  // 每 15 秒才读一次，所以"读数 16 秒旧"是正常状态，推出来的位置比冻结值更准
  const a = makeAnchor({ pos: 100, dur: 1087, status: 'playing', updated: T0 }, T0);
  const e = estimate(a, T0 + 16_000);
  assert.equal(e.confidence, 'extrapolated');
  assert.ok(Math.abs(e.pos - 116) < 0.2, `应推成 116，实得 ${e.pos}`);
  assert.ok(16_000 > FRESH_MS, `FRESH_MS=${FRESH_MS} 应该只覆盖"刚刚读到"`);
});

test('在播但读数旧了：按墙钟推（extrapolated）', () => {
  const a = makeAnchor({ pos: 100, dur: 1087, status: 'playing', updated: T0 }, T0);
  const e = estimate(a, T0 + 30_000);
  assert.equal(e.confidence, 'extrapolated');
  assert.ok(Math.abs(e.pos - 130) < 0.2, `应推成 130，实得 ${e.pos}`);
});

test('推太久就承认不知道（unknown），不硬推', () => {
  const a = makeAnchor({ pos: 100, dur: 1087, status: 'playing', updated: T0 }, T0);
  const e = estimate(a, T0 + MAX_EXTRAPOLATE_MS + 60_000);
  assert.equal(e.confidence, 'unknown');
  assert.equal(e.why, 'stale');
  assert.ok(e.pos <= 100 + MAX_EXTRAPOLATE_MS / 1000 + 0.01, '位置不能无限外推');
});

test('暂停：位置就是读到的值，且永远可信（不能因为"旧"就判成读不到）', () => {
  const a = makeAnchor({ pos: 213.5, dur: 1087, status: 'paused', updated: T0 }, T0);
  const e = estimate(a, T0 + 60_000);
  assert.ok(Math.abs(e.pos - 213.5) < 0.01, '暂停一分钟位置都不该变');
  assert.equal(e.why, 'paused');
  assert.equal(e.confidence, 'fresh', '暂停是已知状态，不是"读不到"');
});

test('暂停时不说话（哪怕位置已经过了边界）', () => {
  const a = makeAnchor({ pos: 118, dur: 1087, status: 'paused', updated: T0 }, T0);
  const r = shouldSpeak({ anchor: a, segments: [{ from: 0, to: 120 }], now: T0 + 60_000 });
  assert.equal(r.speak, false);
  assert.equal(r.reason, 'paused');
});

test('该说：新鲜时到点就说', () => {
  const a = makeAnchor({ pos: 110, dur: 1087, status: 'playing', updated: T0 }, T0);
  const r = shouldSpeak({ anchor: a, segments: [{ from: 0, to: 120 }], now: T0 + 2000, lead: 15 });
  assert.equal(r.speak, true);
  assert.equal(r.segment, 0);
});

test('该说：外推的必须越过安全余量才说（不抢话）', () => {
  // sayAt=105、安全余量 5 → 外推到 106 时还差 4 秒，不能开口
  const near = makeAnchor({ pos: 76, dur: 1087, status: 'playing', updated: T0 }, T0);
  const r1 = shouldSpeak({ anchor: near, segments: [{ from: 0, to: 120 }], now: T0 + 30_000, lead: 15 });
  assert.equal(r1.speak, false);
  assert.equal(r1.reason, 'extrapolated-not-confirmed');
  // 外推到 116（≥ 105+5）才说
  const r2 = shouldSpeak({ anchor: near, segments: [{ from: 0, to: 120 }], now: T0 + 40_000, lead: 15 });
  assert.equal(r2.speak, true);
});

test('该说：完全不知道就闭嘴', () => {
  const a = makeAnchor({ pos: 100, dur: 1087, status: 'playing', updated: T0 }, T0);
  const r = shouldSpeak({ anchor: a, segments: [{ from: 0, to: 120 }], now: T0 + 10 * 60_000 });
  assert.equal(r.speak, false);
  assert.equal(r.reason, 'position-unknown');
});

test('该说：说过的段不重复，早就过去的不补', () => {
  const a = makeAnchor({ pos: 110, dur: 1087, status: 'playing', updated: T0 }, T0);
  assert.equal(shouldSpeak({ anchor: a, segments: [{ from: 0, to: 120 }], spoken: [0], now: T0 }).speak, false);

  const b = makeAnchor({ pos: 600, dur: 1087, status: 'playing', updated: T0 }, T0);
  assert.equal(shouldSpeak({ anchor: b, segments: [{ from: 0, to: 120 }], now: T0 }).speak, false);
});

test('提前量让判定往前挪（本机延迟补偿）', () => {
  const a = makeAnchor({ pos: 92, dur: 1087, status: 'playing', updated: T0 }, T0);
  const noAhead = shouldSpeak({ anchor: a, segments: [{ from: 0, to: 120 }], now: T0, lead: 15, aheadSec: 0 });
  assert.equal(noAhead.speak, false, '92 秒还没到 105');
  const withAhead = shouldSpeak({ anchor: a, segments: [{ from: 0, to: 120 }], now: T0, lead: 15, aheadSec: 15 });
  assert.equal(withAhead.speak, true, '补 15 秒提前量后应该到了');
});
