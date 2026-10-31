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

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
/** ASR 分块长度：本机 sherpa 服务对单次请求的音频长度敏感，30 秒一块最稳 */
const CHUNK_SEC = 30;

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
 * 没有 CC 字幕时，用 ASR 自己的句子时间当时间码。
 *
 * 为什么要走 ASR：`at` 对齐的必须是"这句话**真正开始说**的秒数"。分镜清单只给到
 * 格子（45 秒一格），拿格子起点当 `at` 会让台词提前几十秒冒出来。
 *
 * 缓存进同一个 `subs-<sessionKey>.json`（`source:'asr'`），`sentencesIn` / `bin/lines.mjs`
 * 全都照常工作；ASR 只跑**缺的那一段窗口**，反复调不会重跑。
 */
async function asrCues(input, { env = process.env, start = 0, end = undefined } = {}) {
  const media = findCachedMedia(input, env);
  if (!media) return { ok: false, cues: [], source: 'none', reason: 'no-media' };

  const here = new URL('./', import.meta.resolve('dsh-video-storyboard/locate'));
  const [{ resolveAsrConfig }, { ensureAsr }] = await Promise.all([
    import(new URL('asr.js', here)),
    import(new URL('asr-lifecycle.js', here)),
  ]);
  const cfg = resolveAsrConfig(env);
  // 本机 ASR 服务没起就拉起来。**必须把配置传进去** —— `ensureAsr({})` 读不到
  // `~/.dsh/asr.json` 里的 `manage.start`，只会回 "no manage.start configured"。
  await ensureAsr({ baseUrl: cfg.baseUrl, config: cfg, env }).catch(() => {});

  const from = Math.max(0, Number(start) || 0);
  const to = Number.isFinite(Number(end)) ? Number(end) : from + CHUNK_SEC;
  const base = cfg.baseUrl.replace(/\/$/, '');

  const out = [];
  for (let s = from; s < to; s += CHUNK_SEC) {
    const len = Math.min(CHUNK_SEC, to - s);
    const wav = await extractWav(media, s, len, env);
    if (!wav) continue;
    let got = null;
    for (let attempt = 0; attempt < 2 && !got; attempt++) {
      got = await postWav(base, wav, cfg).catch(() => null);
      if (!got) await new Promise((r) => setTimeout(r, 800));
    }
    for (const seg of got?.segments ?? []) {
      const text = String(seg.text ?? '').trim();
      const a = Number(seg.start ?? seg.from);
      const b = Number(seg.end ?? seg.to);
      if (!text || !Number.isFinite(a)) continue;
      out.push({ from: a + s, to: (Number.isFinite(b) ? b : a + 2) + s, text });
    }
  }
  if (out.length === 0) return { ok: false, cues: [], source: 'none', reason: 'asr-empty' };

  const file = subsFile(input, env);
  let merged = out;
  try {
    const old = JSON.parse(readFileSync(file, 'utf8'));
    if (Array.isArray(old?.cues)) {
      const seen = new Set(out.map((c) => c.from.toFixed(1)));
      merged = old.cues.filter((c) => !seen.has(Number(c.from).toFixed(1))).concat(out)
        .sort((x, y) => x.from - y.from);
    }
  } catch { /* 没有旧缓存就是这份 */ }
  try {
    mkdirSync(cacheDir(env), { recursive: true });
    writeFileSync(file, JSON.stringify({ lang: cfg.language ?? null, source: 'asr', cues: merged }), 'utf8');
  } catch { /* 写不进缓存只影响下次重抓 */ }
  return { ok: true, cues: merged, lang: cfg.language, source: 'asr' };
}

/**
 * 抽一段 16k 单声道 wav 到**临时文件**。
 *
 * 不能管道输出：ffmpeg 往 stdout 写 wav 时无法回填长度，头里是 0xFFFFFFFF，
 * 本机 sherpa 服务解析这种头会直接回 500（实测 10/15/20/30 秒全 500，
 * 而同一段音频先落盘再传就是 200）。
 */
async function extractWav(media, start, len, env = process.env) {
  const ffmpeg = env.DSH_FFMPEG || 'ffmpeg';
  const tmp = join(tmpdir(), `watch-asr-${process.pid}-${Math.round(start)}.wav`);
  const args = ['-hide_banner', '-v', 'error', '-nostdin'];
  if (start > 0) args.push('-ss', String(start));
  args.push('-t', String(Math.max(0.5, len)), '-i', media, '-vn', '-ac', '1', '-ar', '16000', '-y', tmp);
  try {
    await runFile(ffmpeg, args);
    const buf = readFileSync(tmp);
    return buf.length > 1024 ? buf : null;
  } catch {
    return null;
  } finally {
    try { rmSync(tmp, { force: true }); } catch { /* 删不掉无所谓 */ }
  }
}

/** 发一段 wav 给 OpenAI 兼容的转写接口，只取 `segments` */
async function postWav(base, buf, cfg) {
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', cfg.model);
  form.append('response_format', 'verbose_json');
  if (cfg.language) form.append('language', cfg.language);
  const res = await fetch(`${base}/audio/transcriptions`, {
    method: 'POST',
    headers: cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {},
    body: form,
  });
  if (!res.ok) throw new Error(`ASR ${res.status}`);
  return res.json();
}

/** 这支片子的本地扫描副本（分镜跑过就有）：媒体目录里找 url 含同一 BV/文件名的那个 */
function findCachedMedia(input, env = process.env) {
  const dir = env.DSH_VIDEO_MEDIA_DIR
    || join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Temp', 'dsh-video-storyboard', 'media');
  const s = String(input ?? '');
  const m = s.match(/(BV[0-9A-Za-z]{10})/i);
  const needle = m ? m[1].toLowerCase() : null;
  try {
    for (const d of readdirSync(dir)) {
      const sub = join(dir, d);
      const meta = join(sub, 'meta.json');
      const video = join(sub, 'video.mp4');
      if (!existsSync(video) || !existsSync(meta)) continue;
      if (!needle) return video;
      try {
        const j = JSON.parse(readFileSync(meta, 'utf8'));
        if (String(j?.url ?? '').toLowerCase().includes(needle)) return video;
      } catch { /* 坏的 meta 跳过 */ }
    }
  } catch { /* 没有媒体目录 */ }
  return null;
}

/**
 * 拿这支片子的字幕（带缓存）。
 *
 * @returns {Promise<{ok:boolean, cues:Array<{from:number,to:number,text:string}>, lang?:string,
 *   source:'cache'|'remote'|'none', reason?:string}>}
 */
export async function loadCues(input, {
  env = process.env, cookies = null, refresh = false, start = 0, end = undefined,
} = {}) {
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
    // **没有 CC 字幕不是终点**：这时唯一可靠的时间码是 ASR 自己给的句子时间。
    // 以前这里直接返回 no-subs，于是模型只能拿分镜的格子时间（45 秒一格）当 `at`，
    // 台词就会提前几十秒冒出来 —— 用户 2026-10-31 报的"台词比视频提前了有点多"就是这个。
    const a = await asrCues(input, { env, start, end }).catch(() => null);
    if (a?.ok) return a;
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
