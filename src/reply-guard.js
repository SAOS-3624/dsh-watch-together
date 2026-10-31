/**
 * reply-guard.js — "你刚说的那句"和"脚本台词"别挤在同一个时间点。
 *
 * ## 要解决的现象
 *
 * 用户插一句话，模型回了两三句（这些都走 `say`，都会被念）；同一时刻脚本里
 * 还挂着一句在 12:36 要念的词。结果三件事挤在一起：
 *
 *   ① 声音引擎是**串行**的：回话还没念完，脚本那句就在排队；
 *   ② 排队超过 3.5 秒，适配器会**直接丢掉**那一句（宁可少说一句，也不要越说越晚）——
 *      于是用户听到的是"回完话后面那句没了"，而且悬浮窗里也没有它的字；
 *   ③ 就算没丢，两句内容也没关系：回话已经说完了画面这会儿是什么，脚本那句还在说上一件事。
 *
 * 用户的原话是"把后面那句根据插话回复的内容修改一下"—— **改**，不是删。
 * 所以这里的做法是：
 *   · 把回话占住的那一小段（默认 12 秒）里的脚本台词**取走**；
 *   · 取走的东西随工具结果还给模型，并让它按刚说的那句重写（或者干脆不要）。
 *
 * ## 为什么还要记"声音忙到什么时候"
 *
 * 循环发台词之前会看 `voiceBusyUntil`：上一句没念完就不发下一句。
 * 但那个值只在**循环自己**发词时更新 —— 模型用 `say` 说话时它不知道，
 * 于是回话刚开口两秒，循环又把脚本那句塞进去了。这里补上这一半。
 */

import { pullItemsBetween } from './watch-lines.js';
import { speechSeconds } from './speech.js';

/** 回话之后多久之内不再念脚本台词（播放秒）。12 秒 ≈ 一句半到两句的长度 */
export const REPLY_GUARD_SEC = 12;

const state = {
  /** 最后一次说话（`say`）的墙钟毫秒；0 = 这一场还没说过 */
  at: 0,
  /** 说话时的播放位置（秒）；读不到就是 null */
  pos: null,
  /** 说了什么（只留给排查/重写上下文用） */
  text: '',
  /** 声音引擎忙到什么时候（墙钟毫秒） */
  busyUntil: 0,
};

/** `Number(null) === 0`：位置"不知道"必须还是 null，不能变成"0 秒" */
const posOf = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));

/**
 * 记一次"模型说话了"。
 *
 * @param {string} text
 * @param {{ pos?: number|null, now?: number }} [o] `pos` = 说话时的播放秒数
 */
export function noteReply(text, { pos = null, now = Date.now() } = {}) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  state.at = now;
  state.pos = Number.isFinite(posOf(pos)) ? Number(pos) : null;
  state.text = t;
  // **按完整时长算**（不是 speechLag 的一半）：那是"什么时候可以插话"，这里问的是"引擎什么时候空出来"
  state.busyUntil = now + speechSeconds(t.length) * 1000;
  return { ...state };
}

/** 最近一次说话（`{ at, pos, text, busyUntil }`；没说过时 `at` 为 0） */
export function lastReply() {
  return { ...state };
}

/** 声音引擎被这句回话占到什么时候（墙钟毫秒） */
export function replyBusyUntil() {
  return state.busyUntil || 0;
}

/**
 * 把回话之后 `guardSec` 秒内的脚本台词取走。
 *
 * @param {string|null} input 陪看的那条视频；不知道就别调（返回空）
 * @param {{ pos?: number|null, guardSec?: number, env?: object }} [o]
 * @returns {Promise<{pulled: Array<{from:number, at:number, text:string}>, guardSec: number}>}
 */
export async function pullLinesNear(input, { pos = null, guardSec = REPLY_GUARD_SEC, env = process.env } = {}) {
  const p = posOf(pos);
  // 读不到位置就不动：宁可让它照常念，也不能按错误的时间段去删词
  // （注意 `Number(null)` 是 0 —— 不判空就会把第一段开头那 12 秒的词全取走）
  if (!input || !Number.isFinite(p)) return { pulled: [], guardSec };
  const pulled = await pullItemsBetween(input, p + 1, p + guardSec, { env }).catch(() => []);
  return { pulled, guardSec };
}

/** 取走的那些台词 → 交给模型的那段话（要求**重写**，不是要求它忽略） */
export function pulledLinesNote({ pulled, guardSec = REPLY_GUARD_SEC, pos = null } = {}) {
  const list = Array.isArray(pulled) ? pulled : [];
  if (list.length === 0) return '';
  const good = Number.isFinite(posOf(pos));
  const head = good
    ? `你刚才那句落在 ${fmt(Number(pos))}，接下来 ${guardSec} 秒（到 ${fmt(Number(pos) + guardSec)}）`
    : `你刚才那句之后 ${guardSec} 秒`;
  const body = list.map((l) => `  · ${fmt(l.at)}「${String(l.text).slice(0, 60)}」`).join('\n');
  return `\n[lines·太近] ${head}里本来还有 ${list.length} 句脚本台词，我先把它们取走了 —— `
    + '回话和它们挨着念会连成一串（声音引擎串行，后一句排太久会被直接丢掉）。\n'
    + `${body}\n`
    + '**按你刚说的那句重写它们**（改词、缩短、合并成一句都行），或者干脆不要；'
    + '别把原来那句原样加回去。写法还是 `lines: [{ from: <段起点>, at: <秒数>, text: "…" }]`。';
}

const fmt = (s) => {
  const total = Math.max(0, Math.round(Number(s) || 0));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

/** 仅测试用：清空状态（换一场陪看时必须清，否则上一场的回话会卡住新一场的开头） */
export function __resetReplyGuard() {
  state.at = 0;
  state.pos = null;
  state.text = '';
  state.busyUntil = 0;
}
