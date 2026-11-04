/**
 * playhead.js — "现在播到第几秒"对**外部**可见的那一层。
 *
 * ## 为什么需要它（而不是让调用方自己读）
 *
 * 位置有三条来路：扩展每秒上报（`position-bridge.js`）、调试端口每 15 秒探一次
 * （`watch-browser.js`）、用户自己报的 cursor。**判断哪条可信、怎么外推、什么时候
 * 承认不知道**，全在 `position.js` 那套锚点逻辑里。绕过去自己读 `position.json`
 * 的调用方，等于把那套规则重写一遍 —— 十有八九会写出"位置停了还在往前推"。
 *
 * ## 为什么不做成从 watch-loop 里直接读
 *
 * `watch-loop → runtime-ports → voice-adapter → companion-api`，如果
 * `companion-api` 再 import `watch-loop` 就成一个环。环在 ESM 里多数时候能跑，
 * 但"多数时候"不是工程约定：一旦哪天有人在 watch-loop 顶层求值点什么，就会炸在
 * 某个和本次改动毫无关系的测试里。所以循环**把结论推到这个小 store**，别人只读它。
 *
 * 写入方只有一个（`watch-loop.js` 的 `syncPlayhead()`），读取方可以有任意多个。
 */

import { estimate } from './position.js';

/** 没有陪看时的固定形状 —— 字段齐全，调用方不用到处判空 */
const IDLE = Object.freeze({
  active: false, input: null, dur: null, pos: null, confidence: 'unknown', staleMs: null,
});

let state = { active: false, input: null, dur: null, anchor: null };

/**
 * 循环每一拍把当前状态推过来。
 *
 * `anchor` 是 `position.js` 的锚点原样对象：**不要把 pos 单独传**，
 * 那样"读数多久以前读的"就丢了，外推和降级全都没法算。
 */
export function setPlayhead({ active = true, input = null, dur = null, anchor = null } = {}) {
  state = {
    active: Boolean(active),
    input: input ?? null,
    dur: Number.isFinite(dur) ? Number(dur) : null,
    anchor: anchor ?? null,
  };
}

/** 停表 / 换片时清掉，别让适配器拿着上一支片子的位置去丢音频 */
export function clearPlayhead() {
  state = { active: false, input: null, dur: null, anchor: null };
}

/**
 * 读当前位置。
 *
 * **`confidence === 'unknown'` 时 `pos` 是 `null`，不是 0。**
 * 这条和仓里其它地方反复踩的 `Number(null) === 0` 是同一个坑：
 * 给个 0，调用方就会算出"我合成的音频比当前位置晚了 300 秒"，然后默默丢光。
 * 不知道就该是不知道。
 *
 * @param {number} [now] 注入当前时刻（测试/仿真用虚拟时间）
 * @returns {{active:boolean, input:string|null, dur:number|null,
 *   pos:number|null, confidence:'fresh'|'extrapolated'|'unknown', staleMs:number|null}}
 */
export function readPlayhead(now = Date.now()) {
  if (!state.active || !state.anchor) return { ...IDLE, input: state.input, dur: state.dur };
  const est = estimate(state.anchor, now);
  const dur = state.dur ?? (Number.isFinite(state.anchor.dur) ? state.anchor.dur : null);
  return {
    active: true,
    input: state.input,
    dur,
    // 承认不知道时不给数字：见上面那段
    pos: est.confidence === 'unknown' || !Number.isFinite(est.pos) ? null : +est.pos.toFixed(1),
    confidence: est.confidence,
    staleMs: Number.isFinite(est.staleMs) ? Math.round(est.staleMs) : null,
  };
}
