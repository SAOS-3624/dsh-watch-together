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
import { floatingWindowAlive, openFloatingWindow } from './floating-window.js';
import { loopStatus, stopWatchLoop } from './watch-loop.js';
import { attachConfiguredVoice, attachedAdapters, configuredVoiceAdapter } from './voice.js';

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
  /**
   * @param {{start?: boolean}} [o]
   *   `start: true` = 这是一次**新的开始**（没有正在跑的陪看）→ 窗口没了就重开；
   *   否则（同一场陪看中途再调）→ 窗口没了**不要**偷偷重开，而是判定"用户关了窗"并停止。
   *
   * 为什么要区分：用户的原话是"我刚才关了悬浮窗又自己弹出来了"。关窗是他表达
   * "我不看了"的方式，下一次调用立刻又把窗口顶回来，等于把他的动作撤销了。
   */
  return ({ start = false } = {}) => {
    prepared ??= open({ start });
    return prepared;
  };
}

/** 这个进程里"悬浮窗已开"这句话只说一次 —— 用户看到两条一模一样的系统提示会以为出错了 */
let announced = false;

/** 声音适配器：没挂就挂上（挂过就直接复用）。返回一句给人看的状态。 */
async function ensureVoice() {
  let spec = '';
  try {
    spec = String(configuredVoiceAdapter() ?? '').trim();
  } catch { spec = ''; }
  if (!spec) return { ok: false, reason: 'voice.json 没配 adapter' };
  if (attachedAdapters().includes(spec)) return { ok: true, name: tail(spec), cached: true };
  const r = await attachConfiguredVoice({ log: () => {} })
    .catch((e) => ({ ok: false, reason: String(e?.message ?? e) }));
  return { ok: r?.ok === true, name: r?.name ?? tail(spec), reason: r?.reason };
}

const tail = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() || String(p);

async function open({ start = false } = {}) {
  // 0) 声音：每次开始陪看都确认一次 —— 不挂的话台词只会写进流、一句也不念
  const voice = await ensureVoice();
  const voiceNote = voice.ok
    ? `声音：${voice.name}${voice.cached ? ' 已在' : ' 已挂上'}`
    : `声音：没挂（${voice.reason ?? '未知原因'}），台词只写不念`;

  // 1) 悬浮窗（Python tkinter，无边框/置顶；里面还有「麦」可以语音输入）
  //
  // **关窗 = 用户说不看了**。所以：
  //   · 新开一场（start）→ 窗口不在就开
  //   · 同一场中途调用 → 窗口不在就**判定被关**：停钟、返回"已中止"，绝不偷偷重开
  const running = loopStatus();
  if (!start && running.active && !floatingWindowAlive()) {
    stopWatchLoop('widget-closed');
    return {
      windowOpen: false,
      closedByUser: true,
      note: '\n[widget] 悬浮窗已被关掉 —— 陪看按你关窗的意思停在这里，我不再挂着、也不重开。'
        + '要接着看就再说一声，我会重新开窗。'
        + `\n[voice] ${voiceNote}。`,
    };
  }
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
      windowOpen: true,
      note: `\n[widget] 悬浮窗已打开（${win.python} ${win.script}）：`
        + '在里面打字、或点「麦」说话，我等待时会立刻被唤醒。'
        + `\n[voice] ${voiceNote}。`,
    };
  }
  if (win.reason === 'already-opened') {
    return {
      windowOpen: true,
      note: '\n[widget] 悬浮窗已经开着 —— 直接在里打字/说话即可。'
        + `\n[voice] ${voiceNote}。`,
    };
  }
  // 开不起来要说清楚原因，并给一条能走通的兜底：只有 Python 悬浮窗和（只读的）聊天记录页
  return {
    windowOpen: false,
    note: `\n[widget] 悬浮窗没开起来（${win.reason}）。`
      + (alive
        ? `兜底：浏览器打开 ${chatPageUrl(port)}（只读记录 + 可输入），`
          + '或双击 examples/floating-chat/launch.cmd。'
        : '')
      + `\n[voice] ${voiceNote}。`,
  };
}
