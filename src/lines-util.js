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

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
/** ASR 分块长度：本机 sherpa 服务对单次请求的音频长度敏感，30 秒一块最稳 */
const CHUNK_SEC = 30;

import { fetchRemoteSubtitles } from 'dsh-video-storyboard/subtitles';
// **目录口径只有一份**（storyboard 的 cache.js）：自己再写一遍就会分叉 ——
// 以前这份写的是 `LOCALAPPDATA/AppData/Local`，在 Linux/mac 上会造出一个根本不存在的
// `~/AppData/Local`，字幕缓存和 chat.jsonl 落到两个地方去。
import { cacheDir } from 'dsh-video-storyboard/cache';

import { sessionKey } from './watch.js';

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
  const [{ resolveAsrConfig, canTranscribe }, { ensureAsr }] = await Promise.all([
    import(new URL('asr.js', here)),
    import(new URL('asr-lifecycle.js', here)),
  ]);
  const cfg = resolveAsrConfig(env);
  // **没配就先说"没配"，别发请求。** 以前这里照样往默认的云端地址发，401 被 catch 吞成
  // `asr-empty` —— 于是"这台机器没装 ASR"和"这片子真的没人说话"在结果里长得一模一样。
  // 用户听到的只有一句"我听不见声音"，不知道该装什么（2026-11-01 评论区的主要来源）。
  if (!canTranscribe(cfg)) return { ok: false, cues: [], source: 'none', reason: 'no-key' };
  // 本机 ASR 服务没起就拉起来。**必须把配置传进去** —— `ensureAsr({})` 读不到
  // `~/.dsh/asr.json` 里的 `manage.start`，只会回 "no manage.start configured"。
  await ensureAsr({ baseUrl: cfg.baseUrl, config: cfg, env }).catch(() => {});

  const from = Math.max(0, Number(start) || 0);
  const to = Number.isFinite(Number(end)) ? Number(end) : from + CHUNK_SEC;
  const base = cfg.baseUrl.replace(/\/$/, '');

  const out = [];
  // 三种失败要分开报，否则全糊成 asr-empty（= "这片子没人说话"，一个会误导人的结论）：
  //   wav === null   → 媒体里抽不出音轨（这条副本没声音，或 ffmpeg 不认）
  //   sent === 0     → 一次都没连上 ASR（服务没起 / 端口错 / 云端 401）
  //   其余           → 真连上了，但一个字都没听出来
  let chunks = 0;
  let sent = 0;
  let lastError = null;
  for (let s = from; s < to; s += CHUNK_SEC) {
    const len = Math.min(CHUNK_SEC, to - s);
    const wav = await extractWav(media, s, len, env);
    if (!wav) continue;
    chunks += 1;
    let got = null;
    for (let attempt = 0; attempt < 2 && !got; attempt++) {
      try {
        got = await postWav(base, wav, cfg);
      } catch (e) {
        lastError = e;
        await new Promise((r) => setTimeout(r, 800));
      }
    }
    if (got) sent += 1;
    for (const seg of got?.segments ?? []) {
      const text = String(seg.text ?? '').trim();
      const a = Number(seg.start ?? seg.from);
      const b = Number(seg.end ?? seg.to);
      if (!text || !Number.isFinite(a)) continue;
      out.push({ from: a + s, to: (Number.isFinite(b) ? b : a + 2) + s, text });
    }
  }
  if (out.length === 0) {
    if (chunks === 0) return { ok: false, cues: [], source: 'none', reason: 'no-audio' };
    if (sent === 0) {
      return {
        ok: false,
        cues: [],
        source: 'none',
        reason: 'asr-unreachable',
        detail: `${String(lastError?.message ?? lastError ?? 'no response').slice(0, 120)} @ ${base}`,
      };
    }
    return { ok: false, cues: [], source: 'none', reason: 'asr-empty' };
  }

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
  // 和 storyboard 的 media-store 同一个默认值（`<tmpdir>/dsh-video-storyboard/media`）。
  // 以前写的是 `LOCALAPPDATA/Temp/...` —— 在 Windows 上碰巧是同一个目录，换个系统就找不到。
  const dir = env.DSH_VIDEO_MEDIA_DIR || join(tmpdir(), 'dsh-video-storyboard', 'media');
  const s = String(input ?? '').trim();
  if (!s) return null;
  // 本地文件**自己就是媒体**，不用去缓存目录里找。
  if (!/^https?:/i.test(s)) return existsSync(s) ? s : null;
  const m = s.match(/(BV[0-9A-Za-z]{10})/i);
  // 匹配用的针：B 站用 BV 号，别的站点用整条 URL。
  // **不能留 `if (!needle) return video` 那种兜底** —— YouTube / 直链没有 BV 号时会
  // 返回目录里碰到的**第一个** video.mp4，于是转写的是另一部片子的音轨：台词全错，
  // 而且一句错都不报（用户只会说"它听到的东西和画面对不上"）。
  const needle = (m ? m[1] : s).toLowerCase();
  try {
    for (const d of readdirSync(dir)) {
      const sub = join(dir, d);
      const meta = join(sub, 'meta.json');
      const video = join(sub, 'video.mp4');
      if (!existsSync(video) || !existsSync(meta)) continue;
      try {
        const j = JSON.parse(readFileSync(meta, 'utf8'));
        if (String(j?.url ?? '').toLowerCase().includes(needle)) return video;
      } catch { /* 坏的 meta 跳过 */ }
    }
  } catch { /* 没有媒体目录 */ }
  return null;
}

/**
 * "拿不到台词"的每种原因 → 一句**用户能懂**的话（含该做什么）。
 *
 * 文案只写一份：`transcriptOnly` 的返回、陪看交付时的告示都从这里取。
 * 以前这些都只报一个英文码（`no-key` / `asr-empty`），模型转述成"我听不见声音"，
 * 用户既不知道缺什么、也不知道装一次就永久解决 —— 评论区里同一个问题被问了几十遍。
 */
export function explainCuesFailure(reason, detail) {
  switch (String(reason ?? '')) {
    case 'no-key':
      return '这台机器没有可用的听音能力：默认后端是云端（要 key），本机 ASR 也没起。'
        + '装一次 sherpa-onnx（免费、不联网，约 15 分钟，docs/INSTALL.zh.md 第 3 步）就能永久解决；'
        + '或者给 B 站 cookie，让我改读它的 CC 字幕。';
    case 'asr-unreachable':
      return `ASR 服务连不上（${detail ?? 'no response'}）—— 装了但没启动，或地址/端口不对（~/.dsh/asr.json）。`;
    case 'asr-failed':
      return `ASR 调用失败（${detail ?? 'see log'}）—— 服务在跑但这一路不通。`;
    case 'no-audio':
      return '这份副本**没有音轨**（下载时只取了画面），不是我听不见 —— 换成带声音的副本或本地文件。';
    case 'asr-empty':
      return 'ASR 跑过了，这一段没听到人声（纯音乐 / 只有音效 / 真没人说话）。';
    case 'no-media':
      return '还没有本地副本可听 —— 先让它出一次图（会顺手下载这一段），再取字幕。';
    case 'local-file-needs-sidecar':
      return '本地文件没有配套字幕：把同名 .srt/.ass 放在旁边，或让它直接听这个文件。';
    case 'needs-login':
      return 'B 站有 CC 字幕，但要登录才给 —— 配一次 cookies（`checkCookies: true` 可当场验证）。';
    case 'no-ytdlp':
      return '这台机器没有 yt-dlp，抓不到站点字幕。';
    case 'no-subs':
      return '这条片子既没有 CC 字幕，ASR 也没给出句子。';
    default:
      return `拿不到台词（${reason ?? 'unknown'}）。`;
  }
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
    // 把 ASR 那边的**具体**原因带上去：`no-key`（没装）/ `asr-unreachable`（装了没起）/
    // `no-audio`（这份副本没音轨）/ `asr-empty`（真没说话）—— 四种药方完全不同。
    return {
      ok: false,
      cues: [],
      source: 'none',
      reason: a?.reason ?? r?.reason ?? 'no-subs',
      ...(a?.detail ? { detail: a.detail } : {}),
    };
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

/**
 * **只读缓存**的字幕（不联网、不跑 ASR）。
 *
 * 台词延迟要按"这句字幕本身有多少字"算 —— 那个字数就在字幕里。但延迟是每秒算好几次的，
 * 不能每次都去抓字幕/跑 ASR，所以这里只读 `subs-<key>.json`，没有就返回空数组。
 *
 * **而且只读一次**：这在热路径上（钟每 2 秒一拍，一拍要问好几次），
 * 以前每次都 `readFileSync` + `JSON.parse` 整份字幕 —— 两小时片子几千条，几十到几百 KB，
 * 一天下来纯粹是白烧。现在按 `路径 + 大小 + mtime` 认缓存，文件没动就返回**同一个数组**
 * （同一身份很重要：`makeLagFn` 的 memo 挂在数组上）。
 */
const cueCache = new Map();

export function cachedCues(input, { env = process.env } = {}) {
  const file = subsFile(input, env);
  try {
    const st = statSync(file);
    const hit = cueCache.get(file);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.cues;
    const j = JSON.parse(readFileSync(file, 'utf8'));
    const cues = Array.isArray(j?.cues) ? j.cues : [];
    cueCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, cues });
    // 一部片一份；只留最近 8 份，别让长进程攒下几百份字幕
    if (cueCache.size > 8) cueCache.delete(cueCache.keys().next().value);
    return cues;
  } catch {
    cueCache.delete(file);
    return [];
  }
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
