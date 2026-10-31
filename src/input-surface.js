/**
 * input-surface.js — "用户能在哪儿插话"的那一侧：悬浮窗 + 聊天服务 + 一句要告诉模型的话。
 *
 * 为什么单独成文件：这块和"陪看"没有关系 —— 它不知道段、不知道播放位置、不知道模型，
 * 只回答一个问题："用户现在能在哪儿打字/说话，我该怎么告诉他"。
 * 以前它长在 `handler.js` 里，于是那个**只该做分流**的文件有四十行 UI 准备，
 * 还带一个 `widgetNote` 变量从函数头传到函数尾。
 *
 * 三个坑（都真踩过）：
 *   ① **两个端口毫无关系**：聊天服务固定 9377，浏览器调试端口 9333。
 *      以前把调试端口当聊天端口传进 `ensureChatSession`，那个端口被浏览器占着，
 *      listen 必然失败、异常又被吞掉 —— "聊天框一直没起来"没人知道为什么。
 *   ② **只 listen 不会在屏幕上出现任何东西**。真要阻塞时得把悬浮窗开起来，
 *      否则用户只能去宿主输入框打字，而宿主的输入框送不进阻塞中的调用 ——
 *      表现就是"插话没反应、只能干等"。
 *   ③ **自己 listen 失败不代表没得用**：另一个实例占着 9377 时，页面照样开得出来、
 *      插话照样通 —— 因为写的是同一个 `chat.jsonl`。
 *
 * 输入框的主入口是 Python 悬浮窗（`examples/floating-chat/window.py`）；
 * 浏览器页面只剩只读兜底（`chatPageUrl()`），不再自动打开，也没有置顶小窗。
 */

import {
  DEFAULT_CHAT_PORT, appendSpoken, chatAlive, chatPageUrl, ensureChatSession,
} from './chat.js';
import { openFloatingWindow } from './floating-window.js';

/**
 * 造一个"准备输入面"的函数：**幂等**，同一个 execute 里调几次都只开一次窗。
 *
 * 返回值是 `{ note }` —— `note` 是要附在工具结果后面的一句话（模型据此告诉用户去哪儿说话）。
 * 用 `??=` 缓存的是 Promise 而不是结果：第二次调用直接复用第一次的，不会各开一个窗口。
 *
 * @returns {() => Promise<{note: string}>}
 */
export function createInputSurface() {
  let prepared = null;
  return () => {
    prepared ??= open();
    return prepared;
  };
}

/** 这个进程里"悬浮窗已开"这句话只说一次 —— 用户看到两条一模一样的系统提示会以为出错了 */
let announced = false;

async function open() {
  // 1) 悬浮窗（Python tkinter，无边框/置顶；里面还有「麦」可以语音输入）
  const win = openFloatingWindow({ log: () => {} });
  // 2) 聊天服务（扩展上报位置走它，记录页也由它提供）
  const srv = await ensureChatSession().catch(() => null);
  const port = srv?.port ?? DEFAULT_CHAT_PORT;
  const alive = srv ? true : await chatAlive(port).catch(() => false);

  if (win.ok) {
    if (!announced) {
      announced = true;
      try {
        // 走统一出口（写盘 + 语音）—— 窗口里出现的每一句都给念，这条也不例外
        appendSpoken('assistant', '[一起看] 悬浮窗已开 —— 在那里打字，或点「麦」直接说话，我等待时会立刻收到。');
      } catch { /* 写不进流不影响陪看 */ }
    }
    return {
      note: `\n[widget] 悬浮窗已打开（${win.python} ${win.script}）：`
        + '在里面打字、或点「麦」说话，我等待时会立刻被唤醒。',
    };
  }
  if (win.reason === 'already-opened') {
    return { note: '\n[widget] 悬浮窗已经开着 —— 直接在里打字/说话即可。' };
  }
  // 开不起来要说清楚原因，并给一条能走通的兜底：只有 Python 悬浮窗和（只读的）聊天记录页
  return {
    note: `\n[widget] 悬浮窗没开起来（${win.reason}）。`
      + (alive
        ? `兜底：浏览器打开 ${chatPageUrl(port)}（只读记录 + 可输入），`
          + '或双击 examples/floating-chat/launch.cmd。'
        : ''),
  };
}
