/**
 * timer.js — 陪看的"钟"。
 *
 * 职责只有两件：**定时跑 tick**（startTicker）、**该说时叫醒**（wakeSession）。它不生成内容、不出图。
 *
 * 为什么这么拆：叫醒一次 = 往会话里投一条消息 = 模型要跑一轮，很贵。
 * 所以 tick 可以每 2 秒敲一次（几乎不花钱），但**只有真的到点才叫醒**。
 * 用户看两小时 ≈ 60 次唤醒，不是 3600 次。
 *
 * 叫醒用 `ctx.sessionController.prompt({ ..., mode: 'queue' })`——这是 dsh-fish
 * 证明可行的那条路（它每小时醒一次、主动说话）。拿不到这个服务就退化成"只记日志"。
 */

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
 * 把"叫醒"这件事包起来：拿不到 sessionController 就退化成记日志，
 * 绝不因为一个可选服务缺失就让整个插件起不来。
 */
export async function wakeSession(ctx, { sessionId, text, timeoutMs = 30_000 } = {}) {
  const sc = ctx?.sessionController;
  if (!sc?.prompt) return { ok: false, reason: 'no-session-controller' };
  if (!sessionId) return { ok: false, reason: 'no-session-id' };

  const ac = new AbortController();
  const kill = setTimeout(() => ac.abort(), timeoutMs);
  kill.unref?.();
  try {
    await sc.prompt({
      requestId: `watch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      sessionId,
      // queue：入队即返回，不等模型想完 —— 我们要的是"叫醒"，不是"等它答"
      mode: 'queue',
      content: [{ type: 'text', text }],
    }, ac.signal);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e).slice(0, 160) };
  } finally {
    clearTimeout(kill);
  }
}
