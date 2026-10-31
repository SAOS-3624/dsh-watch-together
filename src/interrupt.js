/**
 * interrupt.js — 在"等一件慢事"的同时，听得见用户在聊天框里说话。
 *
 * ## 为什么需要单独一层
 *
 * 陪看里有好几处会**干等**：
 *   · 等分镜建好（建一段要 8–10 秒，带 ASR 更久）
 *   · 等这一段看完（等到段末前 15 秒才交付）
 *   · 等用户把视频打开（waitForVideo，最长 2 分钟）
 *   · 等台词到点（cue）
 *
 * 宿主自己的输入框在这些等待里**送不进来**（实测：用户发的消息排在回复之后，
 * 是事后补写的）。但 chat.jsonl 是我们自己 append 的，写盘即时 —— 所以轮询那个文件
 * 是唯一"边等边能听见"的通道。
 *
 * ## 关键取舍：插话**不取消**正在做的事
 *
 * 等分镜被打断时，不把 runStoryboard 掐掉——它已经跑了大半，掐了就是白烧 CPU，
 * 用户下次来还得重跑。做法是让它继续跑完（结果会落进缓存），先回去回应用户；
 * 用户回完再调一次工具，缓存里已经有了，立刻就拿到。
 *
 * ## 为什么用**共享**的 watcher
 *
 * `makeChatWatcher()` 以"创建时的条数"为基线，只报增量。如果每次等待都新建一个，
 * 那么**模型思考期间**用户说的话就会落在两次等待的缝隙里，谁都不报，永远丢掉。
 * 所以整个进程共用一个：上次消费到哪，下次从哪继续。
 */

import { makeChatWatcher } from './chat.js';

/**
 * 共享的"新消息"探测器。
 *
 * 基线在**第一次用到**时建立 —— 那之前的历史消息一条都不会被当成插话。
 * @param {object} [env]
 */
let shared = null;
export function chatWatcherShared(env = process.env) {
  if (!shared) {
    // 延迟 import 会打断模块的静态依赖图，这里直接同步构造：
    // makeChatWatcher 只做一次 readFile，成本可以忽略。
    shared = makeChatWatcher(env);
  }
  return shared;
}

/**
 * 现在有几个地方正**阻塞着等用户说话**（`wait` / `nextLine` / `waitUntil`）。
 *
 * ## 为什么必须有这个计数
 *
 * 聊天框是**一个**消费型通道：`poll()` 报过一次就把它标成已读。阻塞等待和陪看循环
 * 共用同一个 watcher，谁先 poll 谁拿到。而循环那边的处理是 `followup()` ——
 * 会话正卡在工具调用里等结果时，投进去的消息要**等这一轮结束**才会被处理，
 * 所以它接不住"从等待里出来"这件事。实测（2026-10-31）：用户在悬浮窗说话，
 * 循环把话吃了、`followup` 排进去，等待里的 `poll()` 再也看不见它 ——
 * 表现就是"我在窗口里说话，它一动不动"。
 *
 * 所以：**有等待者时，循环不许碰这个通道**。等待者拿到话就直接返回工具结果，
 * 那才是唯一能把人从阻塞里叫出来的路。
 */
let chatWaiters = 0;

/** 进入"我在等用户说话"的状态，返回退出函数（务必 finally 里调） */
export function enterChatWait() {
  chatWaiters += 1;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    chatWaiters = Math.max(0, chatWaiters - 1);
  };
}

/** 有几个等待者（给循环判断"这条通道现在归谁"） */
export function chatWaiterCount() {
  return chatWaiters;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 一边等 `promise`，一边盯着聊天框。
 *
 * @param {Promise} promise 正在做的那件慢事（**不会被取消**）
 * @param {{ watcher?: Function, everyMs?: number }} o
 * @returns {Promise<{kind:'done', value:*} | {kind:'error', error:*}
 *   | {kind:'interrupted', text:string, at:number, pending:Promise}>}
 */
export async function raceChat(promise, { watcher = null, everyMs = 500 } = {}) {
  const poll = watcher ?? chatWatcherShared();
  if (!poll) {
    try {
      return { kind: 'done', value: await promise };
    } catch (error) {
      return { kind: 'error', error };
    }
  }

  let settled = false;
  let value = null;
  let failure = null;
  // **不 await 这个** —— 我们要的是"先回去回应用户"，不是"等它跑完"
  const pending = Promise.resolve(promise).then(
    (v) => { settled = true; value = v; return v; },
    (e) => { settled = true; failure = e; throw e; },
  );
  // 没人取结果时别变成 unhandledRejection（Node 15 起会带崩进程）
  pending.catch(() => {});

  // **这段也是"我在等用户说话"**：陪看循环每 2 秒也会 poll，它一旦先吃掉，
  // 这里就永远看不见（见上面 chatWaiters）。叫醒（followup）接不住阻塞中的会话，
  // 只有这里的提前返回能让人从"等结果"里出来。
  const leaveChan = enterChatWait();
  try {
    while (!settled) {
      const hit = poll();
      if (hit && String(hit.text ?? '').trim()) {
        return { kind: 'interrupted', text: hit.text, at: hit.at, pending };
      }
      // **等"慢事完成"和"下一拍轮询"里先发生的那个**，别傻等满 everyMs。
      // 第一版就是傻等：于是每次建图都被硬加了 500ms，等图建完，
      // 视频早就过了交付点 —— 阻塞等待一进去就立刻返回，等于没等。
      await Promise.race([pending.then(() => {}, () => {}), sleep(everyMs)]);
    }
  } finally {
    leaveChan();
  }
  // **失败要原样带出去**：以前这里失败也返回 `{kind:'done', value:null}`，
  // 于是"建图抛错"变成调用方几百行之后的 `null.png` ——
  // 真正的错误信息（ffmpeg 报错、地址不是视频页、网络断）全丢了，
  // 用户只看到 `Cannot read properties of null (reading 'png')`。
  if (failure) return { kind: 'error', error: failure };
  return { kind: 'done', value };
}

/**
 * 睡一段时间，中途如果用户说话了就提前返回那句话。
 *
 * @param {number} ms
 * @param {{ watcher?: Function, everyMs?: number }} o
 * @returns {Promise<{text:string, at:number}|null>} 没被打断就是 null
 */
export async function sleepWithChat(ms, { watcher = null, everyMs = 500 } = {}) {
  const poll = watcher ?? chatWatcherShared();
  if (!poll) { await sleep(ms); return null; }
  const end = Date.now() + Math.max(0, ms);
  while (Date.now() < end) {
    const hit = poll();
    if (hit && String(hit.text ?? '').trim()) return hit;
    await sleep(Math.min(everyMs, Math.max(1, end - Date.now())));
  }
  return null;
}
