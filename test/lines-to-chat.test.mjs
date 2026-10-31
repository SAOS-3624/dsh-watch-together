/**
 * lines-to-chat.test.mjs — 台词到点必须进悬浮窗，**不管有没有人念**。
 *
 * 实报的 bug（2026-10-31）：用户写了 `lines`，悬浮窗里一句台词都没有。
 * 根因是循环里"消费台词"整块包在 `if (speechSubscribers() > 0)` 里 ——
 * 那个函数只数 `voice: true` 的订阅者，而把台词写进流的 `attachSpeechToChat`
 * 订阅时是 `voice: false`（它只做展示，不该让循环以为"有人念"）。
 * 于是没挂声音适配器 → 台词既不念、也不显示，台词槽还一直积着不被消费。
 *
 * 展示与出声是两件事：**到点先交出去**（写进流），念不念由订阅者决定。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { attachSpeechToChat, readChat } from '../src/chat.js';
import { __resetSpeech, onSpeech } from '../src/voice.js';
import { saveLines } from '../src/watch-lines.js';
import { loopStatus, startWatchLoop, stopWatchLoop } from '../src/watch-loop.js';

/** 手动驱动的循环：把 ticker 换成"拿到 tick 函数"，其余用真的 */
function drive(opts, pos) {
  let tick = null;
  const r = startWatchLoop({
    ...opts,
    deps: {
      ticker: ({ tick: t }) => { tick = t; return { dispose() {} }; },
      now: () => Date.now(),
      wake: async () => ({ ok: true }),
      readBrowser: async () => ({ pos, dur: 600, paused: false, url: 'file:///a.mp4' }),
      loadLatency: async () => ({ samples: 5 }),
    },
  });
  return { r, tick: () => tick() };
}

test('没有声音订阅者：台词照样写进流（这是悬浮窗读的那一份）', async () => {
  __resetSpeech();
  const dir = await mkdtemp(join(tmpdir(), 'lines-chat-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    // 只有展示层订阅者（voice:false）—— 正是没挂声音适配器时的真实状态
    const off = attachSpeechToChat();
    assert.equal(readChat().length, 0);

    // 台词要贴在当前位置上：`dueLine` 默认 `lateSec: 3`，迟到 3 秒以上会被当成
    // "用户拖了进度条"作废，取不到自然也就进不了流（第一版测试就栽在这儿）。
    await saveLines('a.mp4', [{ from: 120, at: 197.5, text: '这句该出现在悬浮窗里' }]);

    const { r, tick } = drive(
      { ctx: {}, sessionId: 's-lines', input: 'a.mp4', segment: 120, ramp: [], cursor: 200 },
      200,
    );
    assert.equal(r.ok, true, '循环要起得来');
    await tick();
    stopWatchLoop('test');
    off();

    const rows = readChat();
    assert.equal(rows.length, 1, `台词应该进流，实得 ${rows.length} 条：${JSON.stringify(rows)}`);
    assert.equal(rows[0].role, 'line', '台词是 line 角色，不是 assistant');
    assert.equal(rows[0].text, '这句该出现在悬浮窗里');
    assert.equal(rows[0].say, true, '`say: true` 才是"要念的"');
  } finally {
    delete process.env.DSH_VIDEO_CACHE_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});

test('有声音订阅者时行为不变：进流 + 不叫醒模型（念了就等于说过了）', async () => {
  __resetSpeech();
  const dir = await mkdtemp(join(tmpdir(), 'lines-chat-voice-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    const offChat = attachSpeechToChat();
    let woke = 0;
    const offVoice = onSpeech(() => { woke += 1; }, { voice: true });   // 假装接了个引擎
    await saveLines('b.mp4', [{ from: 120, at: 197.5, text: '有声时这一句' }]);

    let tick = null;
    startWatchLoop({
      ctx: {}, sessionId: 's-lines-voice', input: 'b.mp4', segment: 120, ramp: [], cursor: 200,
      deps: {
        ticker: ({ tick: t }) => { tick = t; return { dispose() {} }; },
        now: () => Date.now(),
        wake: async () => { throw new Error('有声音时不该叫醒模型'); },
        readBrowser: async () => ({ pos: 200, dur: 600, paused: false, url: 'file:///b.mp4' }),
        loadLatency: async () => ({ samples: 5 }),
      },
    });
    await tick();
    const status = loopStatus();
    stopWatchLoop('test');
    offVoice();
    offChat();

    assert.equal(woke, 1, '声音订阅者收到一次');
    assert.equal(status.reason, 'spoke', '走的是台词分支，不是唤醒分支');
    const rows = readChat();
    assert.equal(rows.length, 1, '有声音时也只写一条（不重复）');
    assert.equal(rows[0].role, 'line');
  } finally {
    delete process.env.DSH_VIDEO_CACHE_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});
