/**
 * interject-anywhere.test.mjs — 插话在**每一个**等待点都插得进去。
 *
 * 用户的问题（paraphrased）：「waitForVideo → speakNow → 写台词 → wait:true → 循环，
 * 这里面插话能随时插入任何一个箭头对吗」。
 *
 * 答案是：
 *   · 所有**阻塞**的入口都盯着聊天框：waitForVideo / wait / waitUntil / waitForRefill /
 *     nextLine，连"建图"那段慢事也是 raceChat 一起盯；
 *   · `speakNow` / 写台词 是立刻返回的，不需要插话；
 *   · 剩下的缝隙是"模型在思考 / 钟在后台空转"—— 这一段以前没人听，现在钟每一拍
 *     顺手看一眼聊天框，有新消息就真 wake 一次（只针对用户插话，不是段末打扰）。
 *
 * 这个文件锁的就是最后那条：没有它，用户说的话会一直躺在 chat.jsonl 里，
 * 直到模型下一次调工具才被发现。
 */

process.env.DSH_WATCH_BRIDGE = '0';
process.env.DSH_WATCH_REQUIRE_LINES = '0';

import test from 'node:test';
import assert from 'node:assert/strict';

import { loopStatus, startWatchLoop, stopWatchLoop } from '../src/watch-loop.js';

function boot({ wakeOnChat = true, messages = [] } = {}) {
  let tick = null;
  const woken = [];
  const queue = [...messages];
  startWatchLoop({
    ctx: { sessionController: { prompt: async () => {} } },
    sessionId: 's-chat', input: 'c.mp4',
    segments: [{ from: 0, to: 120 }], browserPort: 1, segment: 120, ramp: [], depth: 2,
    wake: false,                 // 段末打扰还是关着 —— 插话唤醒不该被它影响
    wakeOnChat,
    deps: {
      now: () => Date.now(),
      ticker: ({ tick: t }) => { tick = t; return { dispose() {} }; },
      readBrowser: async () => ({ pos: 10, dur: 600, paused: false, title: 'c.mp4' }),
      probeEveryMs: 0,
      loadLatency: async () => null,
      chatWatcher: () => () => queue.shift() ?? null,
      wakeChat: async (_c, o) => { woken.push(o.text); return { ok: true }; },
    },
    log: () => {},
  });
  return { tick: () => tick(), woken };
}

test('钟在后台空转时用户插话 → 立刻叫醒模型，并带上那句话', async () => {
  stopWatchLoop('init');
  const { tick, woken } = boot({ messages: [{ role: 'user', text: '这段什么意思？', at: Date.now() }] });
  await tick();
  assert.equal(woken.length, 1, '应该叫醒一次');
  assert.match(woken[0], /用户插话/);
  assert.match(woken[0], /这段什么意思？/);
  assert.match(woken[0], /台词优先/, '要提醒台词优先，但先回这句');
  assert.equal(loopStatus().active, true, '叫醒不等于停钟');
  stopWatchLoop('cleanup');
});

test('没有新消息就不打扰', async () => {
  stopWatchLoop('init2');
  const { tick, woken } = boot({ messages: [] });
  await tick();
  await tick();
  assert.equal(woken.length, 0, '没插话就一句话都别说');
  stopWatchLoop('cleanup2');
});

test('wakeOnChat:false 时回到"只靠阻塞等待收插话"', async () => {
  stopWatchLoop('init3');
  const { tick, woken } = boot({ wakeOnChat: false, messages: [{ role: 'user', text: '在吗', at: Date.now() }] });
  await tick();
  assert.equal(woken.length, 0, '关了就不该叫醒');
  stopWatchLoop('cleanup3');
});
