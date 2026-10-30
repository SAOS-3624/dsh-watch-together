/**
 * watch-loop.test.mjs — 循环的起停与守卫。
 *
 * 这里不测"到点说话"（那要真宿主），只测**边界**：
 * 没有会话 id 就绝不起循环、重复起会先停旧的、stop 是幂等的。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { makePlan } from '../src/batches.js';
import { loopStatus, startWatchLoop, stopWatchLoop } from '../src/watch-loop.js';
import { onSpeech } from '../src/voice.js';

const segs = [{ from: 0, to: 120 }, { from: 120, to: 240 }];
const ctxStub = { sessionController: { prompt: async () => {} } };

test('没有会话 id 就不起循环（退化成手动模式）', () => {
  const r = startWatchLoop({ ctx: ctxStub, sessionId: null, input: 'a.mp4', segments: segs });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-session-id');
  assert.equal(loopStatus().active, false);
});

test('没有段就不起循环', () => {
  const r = startWatchLoop({ ctx: ctxStub, sessionId: 's1', input: 'a.mp4', segments: [] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-segments');
});

test('起了之后状态可读，stop 之后停住，且 stop 幂等', () => {
  const r = startWatchLoop({ ctx: ctxStub, sessionId: 's1', input: 'a.mp4', segments: segs, cursor: 10 });
  assert.equal(r.ok, true);
  const st = loopStatus();
  assert.equal(st.active, true);
  assert.equal(st.segments, 2);
  assert.equal(st.session, 's1');

  stopWatchLoop('test');
  assert.equal(loopStatus().active, false);
  stopWatchLoop('again');       // 幂等：再停一次不该抛
  assert.equal(loopStatus().active, false);
});

test('重复起会先停旧的（同一时刻只允许一段陪看）', () => {
  startWatchLoop({ ctx: ctxStub, sessionId: 's1', input: 'a.mp4', segments: segs });
  const r2 = startWatchLoop({ ctx: ctxStub, sessionId: 's2', input: 'b.mp4', segments: segs });
  assert.equal(r2.ok, true);
  assert.equal(loopStatus().session, 's2');
  stopWatchLoop('cleanup');
});

test('显式 depth 仍然按段数（旧口径），status 里能看到', () => {
  startWatchLoop({
    ctx: ctxStub, sessionId: 's-depth', input: 'd.mp4', segment: 60, ramp: [], depth: 2,
  });
  const st = loopStatus();
  assert.equal(st.depth, 2);
  assert.equal(st.bufferSec, 300);
  stopWatchLoop('cleanup');
});

test('不传 depth 时按时间算，status 报告 auto', () => {
  startWatchLoop({ ctx: ctxStub, sessionId: 's-auto', input: 'e.mp4', segment: 60, ramp: [] });
  const st = loopStatus();
  assert.equal(st.depth, 'auto');
  assert.equal(st.bufferSec, 300);
  stopWatchLoop('cleanup');
});

test('没有会话 id 但有声音订阅者：仍然起循环（台词交给订阅者念，不用叫醒谁）', () => {
  const off = onSpeech(() => {});
  try {
    const r = startWatchLoop({
      ctx: ctxStub, sessionId: null, input: 'voice.mp4', segment: 60, ramp: [],
    });
    assert.equal(r.ok, true, '有订阅者时不该被 sessionId 挡住');
    assert.equal(loopStatus().active, true);
    assert.equal(loopStatus().voice.listeners, 1);
  } finally {
    off();
    stopWatchLoop('cleanup');
  }
});

test('没有会话 id 又没有订阅者：照旧拒绝（没人可叫，也没人接声音）', () => {
  const r = startWatchLoop({ ctx: ctxStub, sessionId: null, input: 'x.mp4', segment: 60, ramp: [] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-session-id');
});

test('暂停且不动 → 空闲超时后自动停并叫醒（冻住的暂停态也算空闲）', async () => {
  let nowMs = 1_000_000;
  const now = () => nowMs;
  let tickFn = null;
  const ticker = (opts) => { tickFn = opts.tick; return { dispose() {} }; };
  // 浏览器一直报"暂停在 100 秒"，位置冻住 —— 人已经走了
  const readBrowser = async () => ({ pos: 100, dur: 600, paused: true, title: '暂停的片' });
  let woke = null;
  const wake = async (ctx, o) => { woke = o; return { ok: true }; };

  const r = startWatchLoop({
    ctx: ctxStub, sessionId: 's-pause', input: 'p.mp4',
    segments: segs,
    browserPort: 1,            // 让 readPositionOrNull 走注入的 readBrowser，不碰真 CDP
    deps: { now, ticker, readBrowser, wake, probeEveryMs: 0, loadLatency: async () => null },
  });
  assert.equal(r.ok, true);

  await tickFn();              // 第一拍：建 anchor（paused @100），记 lastMoveAt
  assert.equal(loopStatus().active, true, '第一拍不该停');

  nowMs += 250_000;           // 推进 250s，远超 idleMs（2×120s=240s），位置仍冻在 100
  await tickFn();

  assert.equal(loopStatus().active, false, '暂停冻住超过 2×分段应自动停');
  assert.ok(woke, '停表时应叫醒模型');
  assert.match(woke.text, /没动|停了一会儿/);
  stopWatchLoop('cleanup');
});
