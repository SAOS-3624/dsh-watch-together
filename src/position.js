/**
 * position.js — 把"每 15 秒才读一次"的位置，变成随时可用的"用户在几分几秒"。
 *
 * ## 为什么需要单独一层
 *
 * 浏览器里的 `video.currentTime` 是**毫秒级真值**，但我们不能每 2 秒去读一次 ——
 * 一次读要连 CDP、列页面、问每个页面"你有 video 吗"，比一次本地比较贵得多。
 * 所以实际节奏是：**每 15 秒真读一次，中间的十几秒按时钟外推**。
 *
 * 由此产生一个必须分开看的两件事：
 *   - `pos`     —— 最近一次读到的位置（可信）
 *   - `updated` —— 它是**什么时候**被读到的（决定它现在还准不准）
 *
 * ## 三种可信度
 *
 * - `fresh`        刚读过（≤ FRESH_MS，刚好盖住一个读取周期）：**直接信**
 * - `extrapolated` 读数有点旧，但状态是 playing：按时钟往前推，**推多少有上限**
 * - `unknown`      太久没读到：连"是不是还在播"都不知道（缓冲/暂停/页签切走都可能），
 *                  **不许当实时值用**，上层要么要用户报时间，要么停表
 *
 * `unknown` 是真实会发生的：浏览器被关掉、页签切走、播放器卡死，都会让读数停住。
 * 这时候继续外推就是编 —— 所以超过上限就降级，交给上层去问。
 *
 * **外推是常态，不是异常**：我们每 15 秒才读一次，中间每个 tick 都在推。
 * 这没问题是下一次读取会立刻把误差纠回来。真正危险的是"错过读取之后还在推"——
 * 因为那段时间里可能暂停过、缓冲过，硬推就会往前多推。所以 `SAFETY_AFTER_MS`
 * 之后说话要多越过一段余量。
 *
 * > 这层原先是给 Windows 系统媒体控件（SMTC）写的：它只在事件发生时刷新，
 * > 实测隔过 143 / 216 秒，外推上限得开到 180 秒。SMTC 已整块删掉，
 * > 现在上限收到 60 秒 —— 连续错过三次读取，基本就是那个浏览器不在了。
 */

/** 读数在这个时间内，认为位置"刚刚读到过"：直接用，不做任何推算 */
export const FRESH_MS = 5_000;
/**
 * 超过这么久还没读到新值，说明**错过了一次读取**（读取周期 15 秒）。
 *
 * 正常时刻读数最多 16 秒旧，外推是可靠的（下一次读取会立刻纠正误差），不需要额外保守。
 * 但错过一次读取之后就不一样了：中间可能暂停过、缓冲过，此时外推会往前多推，
 * 这时候说话要越过边界一段安全余量（见 shouldSpeak）—— 宁可晚几秒，不要早。
 */
export const SAFETY_AFTER_MS = 20_000;
/**
 * 外推最多推这么久，超过就降级成 unknown。
 *
 * 60 秒 ≈ 连续错过 3 次读取。到这个地步多半不是"刷新慢"，而是源没了。
 */
export const MAX_EXTRAPOLATE_MS = 60_000;

const clampPos = (n, dur) => {
  if (!Number.isFinite(n) || n < 0) return 0;
  return Number.isFinite(dur) && dur > 0 ? Math.min(n, dur) : n;
};

/**
 * 从一次浏览器读数建锚点。
 * @param {{pos:number, dur:number, status:string, updated:number, title?:string}} sample
 */
export function makeAnchor(sample, now = Date.now()) {
  const dur = Number(sample?.dur) || 0;
  return {
    pos: clampPos(sample?.pos, dur),
    dur,
    status: sample?.status,
    // updated 缺失就当作"刚刚"——宁可信一次，也不要一开始就 unknown
    updated: Number(sample?.updated) || now,
    title: sample?.title ?? null,
    sampledAt: now,
  };
}

/** 这个状态字符串是不是"在播" */
export function isPlaying(status) {
  return status === 'playing';
}

export function isPaused(status) {
  return status === 'paused';
}

/**
 * 现在大概是第几秒，以及这个数字能不能信。
 * @returns {{pos:number, confidence:'fresh'|'extrapolated'|'unknown', staleMs:number, why:string}}
 */
export function estimate(anchor, now = Date.now(), {
  freshMs = FRESH_MS, maxExtrapolateMs = MAX_EXTRAPOLATE_MS,
} = {}) {
  if (!anchor) return { pos: 0, confidence: 'unknown', staleMs: Infinity, why: 'no-anchor' };
  const staleMs = Math.max(0, now - anchor.updated);

  // 暂停：位置不会自己走，读数就是当前值 —— **永远可信**。
  // （早先这里用 stale 去降级，结果暂停时被判成"读不到进度"，于是不停打扰用户。）
  if (isPaused(anchor.status)) {
    return { pos: anchor.pos, confidence: 'fresh', staleMs, why: 'paused' };
  }
  if (!isPlaying(anchor.status)) {
    return { pos: anchor.pos, confidence: 'unknown', staleMs, why: 'not-playing' };
  }

  // 在播：刚读过就是准的
  if (staleMs <= freshMs) {
    return { pos: anchor.pos, confidence: 'fresh', staleMs, why: 'recent-read' };
  }

  // 在播但读数旧了：按墙钟推，但**有上限**
  if (staleMs <= maxExtrapolateMs) {
    const pos = clampPos(anchor.pos + staleMs / 1000, anchor.dur);
    return { pos, confidence: 'extrapolated', staleMs, why: 'wall-clock' };
  }

  // 推太久了：承认不知道。缓冲/暂停/页签切走都可能，硬推就是编。
  return {
    pos: clampPos(anchor.pos + maxExtrapolateMs / 1000, anchor.dur),
    confidence: 'unknown',
    staleMs,
    why: 'stale',
  };
}

/**
 * 该不该说话 —— 把"新鲜度"并进判定。
 *
 * 规则：
 *   - 新鲜 → 到了就说
 *   - 外推的 → 必须**越过边界一段安全余量**才说（余量 5 秒：够挡住"推快了"的误差，
 *               又不至于把 15 秒的提前量全吃掉，否则就等于卡在段末才开口）
 *   - 完全不知道 → 不说，交给上层去问用户
 */
export function shouldSpeak({
  anchor, segments = [], spoken = [], now = Date.now(),
  lead = 15, safetySec = 5, aheadSec = 0,
  freshMs = FRESH_MS, maxExtrapolateMs = MAX_EXTRAPOLATE_MS,
} = {}) {
  // （safetySec 只在错过读取后才生效，见下）
  const est = estimate(anchor, now, { freshMs, maxExtrapolateMs });
  if (est.why === 'paused') {
    return { speak: false, ...est, reason: 'paused' };
  }
  if (est.confidence === 'unknown') {
    return { speak: false, ...est, reason: 'position-unknown' };
  }
  const pos = est.pos + Math.max(0, aheadSec);
  for (const seg of segments) {
    const sayAt = Number.isFinite(seg.sayAt) ? seg.sayAt : seg.to - lead;
    if (spoken.includes(seg.from)) continue;
    if (pos < sayAt) continue;
    if (pos > seg.to + 60) continue;                     // 早就过去了，不补
    // 只在"错过了一次读取"时保守：正常的外推（读数 ≤16 秒旧）是可靠的，
    // 下一次读取会把误差纠回来，不需要白白晚 5 秒。
    if (est.confidence === 'extrapolated' && est.staleMs > SAFETY_AFTER_MS
      && pos < sayAt + safetySec) {
      return { speak: false, ...est, reason: 'extrapolated-not-confirmed', segment: seg.from };
    }
    return { speak: true, ...est, segment: seg.from, sayAt, pos: +pos.toFixed(1), reason: 'due' };
  }
  return { speak: false, ...est, reason: 'not-due', pos: +pos.toFixed(1) };
}
