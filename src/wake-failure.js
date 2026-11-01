/**
 * wake-failure.js — 叫醒失败的重试与去重策略。
 *
 * 背景（2026-11-01 实报）：悬浮窗里出现几十条
 * `[一起看] 叫醒失败：no-session-controller`。
 *
 * 两个问题：
 *   1. no-session-controller / no-session-id 是**确定性**失败，重试 800ms 没有意义；
 *   2. 每一拍/每句插话都写一条 meta，失败持续时会把聊天流刷满。
 *
 * 这里只做纯策略判断，不碰 fs / 网络，方便单测。
 */

/** 同样的失败在这么久之内只显示一次（期间次数折叠到下一次）。 */
export const WAKE_FAILURE_QUIET_MS = 60_000;

/** 这些原因不是“偶发”，重试不会变好。 */
const DETERMINISTIC_FAILURES = new Set([
  'no-session-controller',
  'no-session-id',
]);

/** 是否值得等 800ms 再试一次。 */
export function isRetryableWakeFailure(reason) {
  const r = String(reason ?? '');
  return !DETERMINISTIC_FAILURES.has(r);
}

/** 给用户看一句能行动的提示（只对最常见的接线错误加）。 */
export function wakeFailureHint(reason) {
  return String(reason ?? '') === 'no-session-controller'
    ? '（当前进程没有 DSH 会话控制器，不能叫醒模型；请从 DSH 里启动，或先关掉陪看循环）'
    : '';
}

/**
 * 失败提示的节流器。
 *
 * `admit(key, at)` 返回：
 *   { allowed: boolean, suppressed: number }
 *
 * `suppressed` 是上一次显示之后、到这次为止折叠掉的次数；
 * 第一次显示为 0，静默期内返回 false 但累加次数。
 */
export function createWakeFailureGate({ quietMs = WAKE_FAILURE_QUIET_MS, now = Date.now } = {}) {
  const state = new Map();

  return {
    admit(key, at = now()) {
      const k = String(key ?? 'unknown');
      const prev = state.get(k);
      if (prev && at - prev.at < quietMs) {
        prev.suppressed += 1;
        return { allowed: false, suppressed: prev.suppressed };
      }
      const suppressed = prev?.suppressed ?? 0;
      state.set(k, { at, suppressed: 0 });
      return { allowed: true, suppressed };
    },
    reset() {
      state.clear();
    },
  };
}

/** 进程级默认节流器：所有 watch loop 共用。 */
export const wakeFailureGate = createWakeFailureGate();
