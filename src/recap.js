/**
 * recap.js — 长视频的短前情：只读**已经看过**的上一两段，给模型一段很短的上下文。
 *
 * 为什么需要它：每段交付都是一张新图 + 新清单，模型很容易在几十分钟后丢掉
 * "刚才发生了什么/自己说过什么"。把整段历史重新塞回去会线性涨 token，所以这里
 * 只取最近 N 段的少量**字幕原句**（只读本地缓存，不跑 ASR、不出图）。
 * 不使用模型写过的台词槽：那是二手总结，不能当前情证据；
 * 也不包含当前段之后的内容 —— 前情只用于衔接，不是剧透。
 */
import { cachedCues, pickCandidates } from './lines-util.js';
import { mmss } from './time.js';

function clean(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function clampInt(value, fallback, min, max) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * 前情默认关闭：没有实测数据前，每段 200+ token 是纯成本。
 * 显式 args.recap=true 或环境变量 DSH_WATCH_RECAP=1 才开启；
 * args.recap=false 可以覆盖环境变量。
 */
export function recapOptions({ args = {}, env = process.env } = {}) {
  const enabled = args.recap === true
    || (args.recap === undefined && String(env.DSH_WATCH_RECAP ?? '') === '1');
  return {
    enabled,
    maxSegments: clampInt(args.recapSegments ?? env.DSH_WATCH_RECAP_SEGMENTS, 2, 1, 3),
    maxChars: clampInt(args.recapMaxChars ?? env.DSH_WATCH_RECAP_MAX_CHARS, 420, 80, 1200),
  };
}

/**
 * @param {string} input
 * @param {{plan:object, segStart:number, maxSegments?:number, maxChars?:number, env?:object}} o
 * @returns {Promise<string>} 以换行开头的短前情；第一段或没有素材时返回空串
 */
export async function recapFor(input, {
  plan, segStart, maxSegments = 2, maxChars = 420, env = process.env,
} = {}) {
  const start = Number(segStart);
  if (!Number.isFinite(start) || start <= 0 || typeof plan?.indexAt !== 'function') return '';
  const idx = plan.indexAt(start);
  if (!Number.isFinite(idx) || idx <= 0) return '';

  const cues = cachedCues(input, { env });
  const parts = [];
  for (let i = Math.max(0, idx - maxSegments); i < idx; i += 1) {
    const seg = typeof plan.from === 'function' ? plan.from(i, 1)[0] : null;
    if (!seg) continue;

    const texts = cues.length > 0
      ? pickCandidates(cues, { from: seg.from, to: seg.to, max: 2 })
        .map((s) => clean(s.text))
        .filter(Boolean)
      : [];
    if (texts.length === 0) continue;

    // 同一句可能在字幕缓存里重复出现；只保留第一次。
    const uniq = [];
    for (const t of texts) {
      if (!uniq.some((x) => x === t)) uniq.push(t);
    }
    parts.push(`[前情 ${mmss(seg.from)}–${mmss(seg.to)}] ${uniq.slice(0, 2).join(' / ')}`);
  }

  if (parts.length === 0) return '';
  const prefix = '\n[前情] 这是之前已经看过的内容，只用于衔接；不要复述：\n';
  let body = parts.join('\n');
  // 限制的是整条前情的长度，不只是正文：前缀本身也占 token。
  const budget = Math.max(24, Number(maxChars) - prefix.length);
  if (body.length > budget) body = `${body.slice(0, Math.max(0, budget - 1))}…`;
  return `${prefix}${body}`;
}
