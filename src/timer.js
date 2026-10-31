/**
 * timer.js — 陪看的"钟"。
 *
 * 职责只有两件：**定时跑 tick**（startTicker）、**该说时叫醒**（wakeSession）。它不生成内容、不出图。
 *
 * 为什么这么拆：叫醒一次 = 往会话里投一条消息 = 模型要跑一轮，很贵。
 * 所以 tick 可以每 2 秒敲一次（几乎不花钱），但**只有真的到点才叫醒**。
 * 用户看两小时 ≈ 60 次唤醒，不是 3600 次。
 *
 * 叫醒走 `sessionController.resolveAgent()` → `agent.followup()` → `sessions.flush()`
 * （DSH 内置 schedule 插件就是这么做的）。**不要写 `ctx.sessionController`**：
 * 没 inject 的服务取它直接抛错，见 `controllerOf()`。
 * 拿不到这个服务就退化成"返回原因"，绝不让插件起不来。
 */

import { randomUUID } from 'node:crypto';

/**
 * 取 `sessionController`：先 `ctx.get()`（可选依赖的正规取法），老环境才退回属性访问，
 * 并把 cordis 那个"without inject"抛错吞掉。
 */
export function controllerOf(ctx) {
  if (!ctx) return null;
  try {
    if (typeof ctx.get === 'function') {
      const viaGet = ctx.get('sessionController');
      if (viaGet) return viaGet;
    }
  } catch { /* 没有 get() / 服务没注册，往下走 */ }
  try {
    return ctx.sessionController ?? null;
  } catch { return null; }
}

/** 唤醒用的消息：DSH 的 `followup()` 要的是一条 user 角色的消息（`MessageBase`） */
function followupMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: String(text ?? '') }],
    // 自定义 source.kind 是 DSH 文档里给插件用的形状（`{ kind: 'my-plugin' }`）
    source: { kind: 'watch-together' },
  };
}

/**
 * 起钟。返回 dispose；`unref()` 保证它不阻止宿主退出。
 * @param {{everyMs?: number, tick: () => (void|Promise<void>)}} opts
 */
export function startTicker({ everyMs = 2000, tick, immediate = true } = {}) {
  let disposed = false;
  let running = false;

  const guard = async () => {
    if (disposed || running) return;   // 上一轮还没跑完就别叠上去
    running = true;
    try {
      await tick();
    } catch {
      /* 钟自己出问题不该把宿主带崩 */
    } finally {
      running = false;
    }
  };

  const timer = setInterval(guard, everyMs);
  timer.unref?.();
  if (immediate) void guard();

  return {
    dispose() {
      disposed = true;
      clearInterval(timer);
    },
  };
}

/**
 * 把"叫醒"这件事包起来：叫不醒就返回原因，**绝不抛**（不然又被 ticker 的 catch 吞掉）。
 *
 * ## 取服务必须容错
 *
 * DSH（cordis）里，**没在 `inject` 里声明的服务，取属性会直接抛**
 * `Error: cannot get property "sessionController" without inject`，不是返回 undefined。
 * 以前这里第一行就是 `ctx?.sessionController`，于是每一次唤醒都抛，又正好落在
 * `startTicker` 的 `try/catch` 里被静默吞掉 —— 表现是"钟在走、位置也对、就是没人说话"。
 * `ctx.get(name)` 是可选依赖的正规取法（取不到返回 undefined），DSH 自己也用它
 * （`this.ctx.get("agentPresets")`）。
 *
 * ## 叫醒的写法是宿主定的
 *
 * workbuddy 那边是 `sessionController.prompt({ mode:'queue' })`，DSH 里没有这套。
 * DSH 的正规做法（内置 schedule 插件就是范本）：
 *   1. `sessionController.resolveAgent(sessionId)` → `{ agent }` / `{ error }`
 *   2. `agent.followup(message)` 排队下一轮并唤醒驱动器
 *   3. `sessions.flush(agent.session)` 确认真的落进会话（followup 只进收件箱）
 */
export async function wakeSession(ctx, { sessionId, text } = {}) {
  const sc = controllerOf(ctx);
  if (!sc?.resolveAgent) return { ok: false, reason: 'no-session-controller' };
  if (!sessionId) return { ok: false, reason: 'no-session-id' };

  try {
    const resolved = await sc.resolveAgent(sessionId);
    if (!resolved || resolved.error || !resolved.agent) {
      const reason = resolved?.error?.message ?? resolved?.error ?? 'resolve-failed';
      return { ok: false, reason: String(reason).slice(0, 160) };
    }
    resolved.agent.followup(followupMessage(text));
    let flushed = null;
    try {
      const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : null;
      if (sessions?.flush) flushed = await sessions.flush(resolved.agent.session);
    } catch { flushed = false; }
    return { ok: true, via: 'followup', flushed };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e).slice(0, 160) };
  }
}
