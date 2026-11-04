/**
 * companion-api.js — 声音适配器能问核心的两个问题：**接下来念什么**、**现在播到哪**。
 *
 * ## 边界（issue #4 上定下来的，改之前先看）
 *
 * 这两个方法**必须是纯读**：核心不替适配器合成、不缓存音频、不知道合成要多久、
 * 也不管适配器缓存几段。给到"下一两句是什么、现在播到哪"就够了 ——
 * 决定预不预合成、什么时候丢过期音频，全在适配器自己。
 *
 * 为什么不能做成"核心帮你预合成"：核心一旦开始管音频生命周期，就会出现第二个
 * 声音引擎跟它抢话（core #27 的立场），而且合成慢的机器上要不要重试这种事，
 * 核心根本没法知道。
 *
 * ## 和 `scheduled` 事件的关系
 *
 * `scheduled` 是**推**：核心在台词写好、还没到点时，逐句把未来 1 分钟内的句子发出来。
 * 这两个方法是**拉**：适配器想知道"再往后呢 / 现在到哪了"时自己问。
 * 两者不重复记账 —— `upcoming()` 读的是同一份台词槽，**不看**发过没发过。
 *
 * ## 别把这两个方法当"精确播放器"
 *
 * `at` 的单位是**播放秒**（不是墙钟），`pos` 是外推值（见 `position.js` 的三种可信度）。
 * 位置只用来做"我合成的那句是不是已经过期"这种粗判断，别拿它算毫秒级同步。
 */

import { readPlayhead } from './playhead.js';
import { upcomingLines } from './watch-lines.js';

/** 默认往前看多久（秒）。够盖住一次网络往返 + 排一句队，又不至于把整段台词都拉出来 */
export const DEFAULT_HORIZON_SEC = 20;
/**
 * 上限。再长就不是"预取"了，而是在替核心做调度 ——
 * 而且一次返回几十句会让适配器分不清哪些是马上要念的。
 */
export const MAX_HORIZON_SEC = 120;

const clampHorizon = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return DEFAULT_HORIZON_SEC;
  return Math.min(MAX_HORIZON_SEC, Math.max(1, v));
};

/**
 * 现在播到哪了。
 *
 * @returns {{pos:number|null, dur:number|null,
 *   confidence:'fresh'|'extrapolated'|'unknown', staleMs:number|null}}
 *   `confidence` 不是 fresh 就别拿 `pos` 当实时值；
 *   `unknown` 时 `pos` 是 `null`（不是 0 —— 见 `playhead.js` 那段）。
 */
export function position() {
  const ph = readPlayhead();
  return {
    pos: ph.pos,
    dur: ph.dur,
    confidence: ph.confidence,
    staleMs: ph.staleMs,
  };
}

/**
 * 接下来会念的台词（**只读**：不消费、不改槽位、不合成）。
 *
 * 只返回已经写好、而且带 `at` 的句子 —— 没写 `at` 的老台词还没钉到时间轴上，
 * 拿去做预合成会排错顺序（见 `upcomingLines` 的注释）。
 *
 * **消费过的句子不会出现**：`dueLine` 会把念掉的那条从槽位里删掉，所以这里是
 * "还欠着的"而不是"这一段的全文"。
 *
 * @param {{horizonSec?:number, env?:object}} [o]
 * @returns {Promise<Array<{at:number, text:string, segment:number}>>} 按 `at` 升序；
 *   没在陪看 / 位置不知道时是空数组
 */
export async function upcoming({ horizonSec = DEFAULT_HORIZON_SEC, env = process.env } = {}) {
  const ph = readPlayhead();
  if (!ph.active || !ph.input || !Number.isFinite(ph.pos)) return [];
  const rows = await upcomingLines(ph.input, {
    after: ph.pos,
    before: ph.pos + clampHorizon(horizonSec),
    env,
  });
  // `from` 是段首秒数（和 `due`/`scheduled` 事件里的 `segment` 同一个口径），
  // 适配器按 (input, segment, text) 做预合成缓存时要靠它对上号。
  return rows.map((r) => ({ at: r.at, text: r.text, segment: r.from }));
}

/** 挂到 `attach(api)` 上的那两个方法。冻结，免得适配器改掉核心的实现 */
export const companionApi = Object.freeze({ upcoming, position });
