/**
 * wake-retry.test.mjs — wakeWithRetry 的接线：重试几次、写几条 meta。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createWakeFailureGate } from '../src/wake-failure.js';
import { wakeWithRetry } from '../src/watch-loop.js';

function run({ wake, gate, sessionId = 'session-1', sleep } = {}) {
  const appends = [];
  const notes = [];
  let calls = 0;
  const promise = wakeWithRetry({
    ctx: {},
    sessionId,
    text: 'ping',
    wake: async (...args) => { calls += 1; return wake(...args); },
    gate,
    append: (...args) => appends.push(args),
    note: (msg) => notes.push(msg),
    sleep: sleep ?? (async () => { throw new Error('deterministic failure must not sleep'); }),
  });
  return { promise, appends, notes, calls: () => calls };
}

test('no-session-controller 不重试，失败只写一条可行动的 meta', async () => {
  const gate = createWakeFailureGate();
  const x = run({ gate, wake: async () => ({ ok: false, reason: 'no-session-controller' }) });
  const r = await x.promise;

  assert.equal(r.ok, false);
  assert.equal(x.calls(), 1, '确定性失败不该重试');
  assert.equal(x.appends.length, 1);
  const [role, text, opts] = x.appends[0];
  assert.equal(role, 'meta');
  assert.match(text, /no-session-controller/);
  assert.match(text, /DSH 会话控制器/);
  assert.equal(opts.say, false);
});

test('同一失败在静默期内不重复写 meta', async () => {
  const gate = createWakeFailureGate();
  const wake = async () => ({ ok: false, reason: 'no-session-controller' });

  const a = run({ gate, wake });
  await a.promise;
  const b = run({ gate, wake });
  await b.promise;

  assert.equal(a.appends.length, 1);
  assert.equal(b.appends.length, 0, '第二次应被节流');
  assert.match(b.notes.at(-1), /suppressed/);
});

test('偶发失败重试一次，第二次成功就不写 meta', async () => {
  let n = 0;
  const x = run({
    gate: createWakeFailureGate(),
    wake: async () => {
      n += 1;
      return n === 1 ? { ok: false, reason: 'resolve-failed' } : { ok: true };
    },
    sleep: async () => {},
  });
  const r = await x.promise;

  assert.equal(r.ok, true);
  assert.equal(x.calls(), 2);
  assert.equal(x.appends.length, 0);
});

test('静默期结束后的下一次失败带上折叠次数', async () => {
  let now = 1_000;
  const gate = createWakeFailureGate({ quietMs: 60_000, now: () => now });
  const wake = async () => ({ ok: false, reason: 'no-session-controller' });

  const a = run({ gate, wake });
  await a.promise;
  now = 2_000;
  const b = run({ gate, wake });
  await b.promise;
  now = 62_000;
  const c = run({ gate, wake });
  await c.promise;

  assert.equal(a.appends.length, 1);
  assert.equal(b.appends.length, 0);
  assert.equal(c.appends.length, 1);
  assert.match(c.appends[0][1], /1 次已折叠/);
});
