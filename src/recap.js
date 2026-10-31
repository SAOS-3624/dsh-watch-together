/**
 * recap.js — 长视频的短前情：只读**已经看过**的上一两段，给模型一段很短的上下文。
 *
 * 为什么需要它：每段交付都是一张新图 + 新清单，模型很容易在几十分钟后丢掉
 * "刚才发生了什么/自己说过什么"。把整段历史重新塞回去会线性涨 token，所以这里
 * 只取最近 N 段的少量句子：
 *   1. 优先用还没念掉的台词槽（读盘，不联网）；
 *   2. 没有台词时，从本地字幕缓存里挑少量候选句（只读缓存，不跑 ASR、不出图）。
 *
 * 绝不包含当前段之后的内容 —— 前情只用于衔接，不是剧透。
 */
import { cachedCues, pickCandidates } from './lines-util.js';
import { readSlot } from './watch-lines.js';
import { mmss } from './time.js';

function clean(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
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

    let texts = [];
    try {
      const slot = await readSlot(input, seg.from, { env });
      texts = (Array.isArray(slot) ? slot : [])
        .map((line) => clean(line?.text))
        .filter(Boolean);
    } catch { /* 读不到台词槽就退回字幕 */ }

    if (texts.length === 0 && cues.length > 0) {
      texts = pickCandidates(cues, { from: seg.from, to: seg.to, max: 2 })
        .map((s) => clean(s.text))
        .filter(Boolean);
    }
    if (texts.length === 0) continue;

    // 同一句可能在字幕和台词里重复出现；只保留第一次。
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
