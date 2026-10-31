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
import { chatWaiterCount, enterChatWait } from '../src/interrupt.js';

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

/**
 * 2026-10-31 晚实报：「悬浮窗插话不能让他从等待中出来」。
 *
 * 聊天框是**一个消费型通道**（poll 报过一次就标已读），阻塞等待和钟共用同一个 watcher。
 * 钟那边处理插话是 `followup()` —— 会话正卡在工具调用里等结果，投进去的消息要等这一轮
 * 结束才处理。所以谁先 poll 谁决定成败：钟先吃，等待里就永远看不见，人在窗口里说话
 * 就"一动不动"。等待者优先，钟在有人等的时候必须闭嘴。
 */
test('有人在阻塞等待时，钟不许抢这句插话（抢走了等待里就再也看不见）', async () => {
  stopWatchLoop('init4');
  const { tick, woken } = boot({ messages: [{ role: 'user', text: '停一下，我问个事', at: Date.now() }] });
  const release = enterChatWait();
  try {
    await tick();
    assert.equal(woken.length, 0, '等待者优先：钟不许消费这条通道');
  } finally {
    release();
  }
  await tick();
  assert.equal(woken.length, 1, '没人等了，钟照旧叫醒（别把插话丢了）');
  assert.match(woken[0], /停一下，我问个事/);
  stopWatchLoop('cleanup4');
});

test('等待者退出后计数归零（漏减会让钟永远不敢说话）', () => {
  const a = enterChatWait();
  const b = enterChatWait();
  assert.equal(chatWaiterCount(), 2);
  a();
  b();
  b();                    // 重复调用不该减成负数
  assert.equal(chatWaiterCount(), 0);
});
