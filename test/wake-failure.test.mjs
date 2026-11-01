/**
 * wake-failure.test.mjs — 叫醒失败：哪些值得重试、提示怎么节流。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WAKE_FAILURE_QUIET_MS,
  createWakeFailureGate,
  isRetryableWakeFailure,
  wakeFailureHint,
} from '../src/wake-failure.js';

test('确定性失败不重试，偶发失败才重试', () => {
  assert.equal(isRetryableWakeFailure('no-session-controller'), false);
  assert.equal(isRetryableWakeFailure('no-session-id'), false);
  assert.equal(isRetryableWakeFailure('resolve-failed'), true);
  assert.equal(isRetryableWakeFailure('timeout'), true);
  assert.equal(isRetryableWakeFailure(undefined), true);
});

test('no-session-controller 给出可行动的提示', () => {
  assert.match(wakeFailureHint('no-session-controller'), /DSH 会话控制器/);
  assert.equal(wakeFailureHint('resolve-failed'), '');
});

test('同类失败在静默期内折叠，过了窗口再显示一次', () => {
  const gate = createWakeFailureGate({ quietMs: WAKE_FAILURE_QUIET_MS, now: () => 0 });
  const key = 'session-1:no-session-controller';

  assert.deepEqual(gate.admit(key, 1_000), { allowed: true, suppressed: 0 });
  assert.deepEqual(gate.admit(key, 2_000), { allowed: false, suppressed: 1 });
  assert.deepEqual(gate.admit(key, 3_000), { allowed: false, suppressed: 2 });
  assert.deepEqual(gate.admit(key, 1_000 + WAKE_FAILURE_QUIET_MS), {
    allowed: true,
    suppressed: 2,
  });
});

test('不同 session / 原因分别计数，不互相吞掉', () => {
  const gate = createWakeFailureGate({ quietMs: 60_000 });
  assert.equal(gate.admit('s1:no-session-controller', 1_000).allowed, true);
  assert.equal(gate.admit('s2:no-session-controller', 1_001).allowed, true);
  assert.equal(gate.admit('s1:resolve-failed', 1_002).allowed, true);
  assert.equal(gate.admit('s1:no-session-controller', 2_000).allowed, false);
  assert.equal(gate.admit('s2:no-session-controller', 2_001).allowed, false);
});

test('reset 之后重新开始', () => {
  const gate = createWakeFailureGate({ quietMs: 60_000 });
  assert.equal(gate.admit('k', 1_000).allowed, true);
  assert.equal(gate.admit('k', 2_000).allowed, false);
  gate.reset();
  assert.equal(gate.admit('k', 3_000).allowed, true);
});
