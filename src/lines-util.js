/**
 * lines-util.js — **不读图**也能写出台词：把字幕变成"候选句 + 秒数"。
 *
 * ## 为什么有这个文件
 *
 * 之前的流程是：等 watch_together 把一张 storyboard 图交给我 → 我看图 → 想台词 →
 * 再调一次工具把台词写进去。一段要花掉一张图（400~700 vision token）加一份清单，
 * 而真正需要的其实只有**这段在说什么**和**那句话在第几秒**。
 *
 * 那两个信息字幕里都有，而且是纯文本。所以这里做三件事：
 *
 *   1. `loadCues(input)`     拿字幕（B 站走 yt-dlp；本地文件读同名 .srt/ass 旁边的 json），
 *                            并缓存到 `<cache>/subs-<sessionKey>.json` —— 同一支片子只抓一次
 *   2. `sentencesIn()`       把视频切成"一句一句"，每句带一个准确的起始秒（`at` 就用它）
 *   3. `pickCandidates()` /  从一段窗口里挑几句：前者给人（模型）看，挑 8~10 句只要
 *      `autoPick()`          两三百字；后者**完全不经过模型**，按打分直接选几句写进稿子
 *
 * ## 别指望 autoPick 会"评论"
 *
 * 它只会**复述字幕原文**。对解说类视频（地图奇遇记这种）勉强能听；
 * 对剧情片就是灾难 —— 那种内容必须有人看一眼画面再说人话。
 * 所以 `auto` 明说自己是"省事模式"，`scan` + `set` 才是正常路径。
 *
 * ## 为什么秒数必须是 `at` 而不是 `from`
 *
 * `from` 是"这一段从哪开始"，`at` 是"这句话在第几秒念"。写错 `from` 整段不响，
 * 写错 `at` 就提前/延后几十秒 —— 实测把第 247 秒的句子挂到 189 秒，用户当场发现
 * "台词对不上视频"。这里从字幕取的是**真实起始秒**，不是估计值。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { fetchRemoteSubtitles } from 'dsh-video-storyboard/subtitles';

import { sessionKey } from './watch.js';

/** 字幕缓存目录：和 chat.jsonl / watch.json 同一个根 */
function cacheDir(env = process.env) {
  const explicit = env.DSH_VIDEO_CACHE_DIR;
  if (explicit) return explicit;
  const base = env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  return join(base, 'dsh-video-storyboard', 'cache');
}

function subsFile(input, env) {
  return join(cacheDir(env), `subs-${sessionKey(input)}.json`);
}

/**
 * 拿这支片子的字幕（带缓存）。
 *
 * @returns {Promise<{ok:boolean, cues:Array<{from:number,to:number,text:string}>, lang?:string,
 *   source:'cache'|'remote'|'none', reason?:string}>}
 */
export async function loadCues(input, { env = process.env, cookies = null, refresh = false } = {}) {
  const file = subsFile(input, env);
  if (!refresh && existsSync(file)) {
    try {
      const j = JSON.parse(readFileSync(file, 'utf8'));
      if (Array.isArray(j?.cues) && j.cues.length > 0) {
        return { ok: true, cues: j.cues, lang: j.lang, source: 'cache' };
      }
    } catch { /* 坏了就当没有，重抓一次 */ }
  }
  if (!/^https?:/i.test(String(input ?? ''))) {
    return { ok: false, cues: [], source: 'none', reason: 'local-file-needs-sidecar' };
  }
  const r = await fetchRemoteSubtitles({ url: input, cookies });
  if (!r?.ok || !Array.isArray(r.segments) || r.segments.length === 0) {
    return { ok: false, cues: [], source: 'none', reason: r?.reason ?? 'no-subs' };
  }
  const cues = r.segments
    .map((c) => ({ from: Number(c.from), to: Number(c.to), text: String(c.text ?? '').trim() }))
    .filter((c) => Number.isFinite(c.from) && c.text);
  try {
    mkdirSync(cacheDir(env), { recursive: true });
    writeFileSync(file, JSON.stringify({ lang: r.lang ?? null, cues }), 'utf8');
  } catch { /* 写不进缓存只影响下次重抓 */ }
  return { ok: true, cues, lang: r.lang, source: 'remote' };
}

/** 这些句子只是语气/过渡，不该被选中当台词 */
const FILLER = /^(那么|所以|但是|而且|然后|其实|就是|对吧|你看|也就是说|换句话说|当然|不过)[，,]?/;
/** 结尾收得住：句号/问号/感叹号/省略号 */
const ENDS = /[。！？…!?]$/;

/**
 * 把字幕切成"一句一句"。
 *
 * B 站字幕的实际形态很乱：
 *   · 一句话常被拆成两三条 cue（"据报道首发的这一批" + "全部是在这里的富士康工厂组装出来的"）
 *   · **大量 cue 根本没有标点**，整段一口气写到底（实测 15 条 cue 连成 166 个字）
 *
 * 所以不能只靠标点切：还要在**停顿（间隔 > 0.8s）**、**逗号且已经够长**、**超长**处切。
 * 切出来的句子要能直接念 —— 太短没信息，太长 TTS 要念十几秒。
 *
 * @returns {Array<{at:number, to:number, text:string}>}
 */
export function sentencesIn(cues) {
  if (!Array.isArray(cues) || cues.length === 0) return [];
  // 只在 **cue 边界**上切 —— 每条 cue 就是一行字幕，本来就是"呼吸单位"。
  // 硬切到字符数会在词中间断开（实测切出"…也就是全球能造E"这种半截话）。
  const TARGET = 34;
  const out = [];
  let buf = null;
  const flush = () => {
    const text = buf ? buf.text.replace(/\s+/g, '').trim() : '';
    if (text) out.push({ at: buf.at, to: buf.to, text });
    buf = null;
  };
  for (const c of cues) {
    const piece = String(c.text ?? '').replace(/\s+/g, '').trim();
    if (!piece) continue;
    if (buf) {
      if (c.from - buf.to > 0.8) flush();                 // 停顿
      else if (buf.text.length + piece.length > TARGET) flush();   // 这一行再加就太长
    }
    if (!buf) buf = { at: c.from, to: c.to, text: piece };
    else { buf.text += piece; buf.to = c.to; }
    if (ENDS.test(buf.text)) flush();
  }
  flush();
  return out;
}

/** 一句话值不值得当台词：长度、是否填充词、有没有实词信息 */
export function scoreSentence(s) {
  const t = String(s.text ?? '');
  let score = 0;
  if (t.length >= 12 && t.length <= 40) score += 2;
  else if (t.length >= 8 && t.length <= 55) score += 1;
  else score -= 2;
  if (/\d|iPhone|iOS|[A-Za-z]{3,}/.test(t)) score += 1;      // 有具体信息
  if (/[\u4e00-\u9fa5]{6,}/.test(t)) score += 1;             // 成句的中文
  if (FILLER.test(t)) score -= 1;
  if (/[？?]$/.test(t)) score += 1;                          // 提问句往往是一个点
  return score;
}

/** 只保留窗口内、且长度适合念的句子 */
export function sentencesBetween(cues, from, to) {
  const start = Number(from);
  const end = Number(to);
  return sentencesIn(cues)
    .filter((s) => s.at >= start - 0.2 && s.at < end)
    .filter((s) => s.text.length >= 8 && s.text.length <= 60)
    .map((s) => ({ ...s, text: clip(s.text) }));
}

/** 太长念不完就截断在标点处（TTS 一句话 30 字左右比较舒服） */
function clip(text, max = 38) {
  const t = String(text);
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const m = cut.match(/.*[，,。！？；;]/);
  return (m ? m[0] : cut).replace(/[，,；;]$/, '') + '…';
}

/**
 * 给模型看的候选句：均匀铺在窗口里，最多 `max` 句。
 *
 * **只输出文本**，一张图都不解码 —— 这就是省 token 的地方。
 */
export function pickCandidates(cues, { from, to, max = 10 } = {}) {
  const sents = sentencesBetween(cues, from, to);
  if (sents.length === 0) return [];
  const span = Math.max(1, Number(to) - Number(from));
  const buckets = Math.max(1, Math.min(max, sents.length));
  const picked = [];
  const seen = new Set();
  for (let b = 0; b < buckets; b += 1) {
    const lo = Number(from) + (span * b) / buckets;
    const hi = Number(from) + (span * (b + 1)) / buckets;
    const inside = sents.filter((s) => s.at >= lo && s.at < hi);
    if (inside.length === 0) continue;
    const best = inside.slice().sort((x, y) => scoreSentence(y) - scoreSentence(x))[0];
    const key = best.text.replace(/[，,。！？\s]/g, '');
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(best);
  }
  return picked.sort((a, b) => a.at - b.at);
}

/**
 * 完全不过模型：按时间段均分，每段挑一句最好的。
 * 结果直接可以喂给 `saveLines`（`from` 由调用方补）。
 */
export function autoPick(cues, { from, to, count = 3 } = {}) {
  const sents = sentencesBetween(cues, from, to);
  if (sents.length === 0) return [];
  const n = Math.max(1, Math.min(count, sents.length));
  const span = Math.max(1, Number(to) - Number(from));
  const out = [];
  const seen = new Set();
  for (let i = 0; i < n; i += 1) {
    const lo = Number(from) + (span * i) / n;
    const hi = Number(from) + (span * (i + 1)) / n;
    const inside = sents.filter((s) => s.at >= lo && s.at < hi);
    const pool = inside.length > 0 ? inside : sents;
    const best = pool
      .filter((s) => !seen.has(s.text.replace(/[，,。！？\s]/g, '')))
      .sort((x, y) => scoreSentence(y) - scoreSentence(x))[0];
    if (!best) continue;
    seen.add(best.text.replace(/[，,。！？\s]/g, ''));
    out.push({ at: +best.at.toFixed(2), text: best.text });
  }
  return out.sort((a, b) => a.at - b.at);
}
