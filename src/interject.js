/**
 * interject.js — 用户插话的**两个半边**：怎么交给模型，和它到底回了没有。
 *
 * ## 为什么要单独一个文件
 *
 * 插话有五个入口（建图时 / 补余量时 / 阻塞等待时 / waitUntil / nextLine），
 * 以前每个入口各写一段措辞。措辞一散开，就会出现"某一处忘了说该怎么说"，
 * 而模型是**照着这段话去做**的 —— 少一句"用 say 回"，它就一声不吭去取图。
 *
 * 2026-10-31 实报：用户问"你看到这个水果了吗"，模型先去 zoom 看画面，
 * 回来才说话。用户侧看到的是"叫了它一声，它没理我"。根因不在模型：
 * 它写的那句回复**根本不会出现在悬浮窗里**（只有 `say` 会），所以"先想再看"
 * 等于全程沉默。这里就是唯一那句话说清楚的地方。
 *
 * ## 为什么还要记"回没回"
 *
 * 光在插话那一刻说一遍不够：模型可能去做了别的事（补台词、取图），
 * 回来时那一段已经不在上下文最前面。于是这里记一条**待回执**：
 * 下一次工具结果里如果还没有 `say`，就把"你还没回她"顶出来，直到它回了为止。
 * 过期（3 分钟）就自己丢掉 —— 那时候再说"你刚没回"已经没有意义。
 */

/** 待回执最多挂这么久：过了就当这句话已经不需要回应了，别再念叨 */
const PENDING_TTL_MS = 180_000;

/** 现在挂着的那句插话（`{ text, at }`） */
let pending = null;

/** 记下"用户刚说了这句话，还没人回" */
export function noteInterjected(text, { at = Date.now() } = {}) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  pending = { text: t, at };
  return pending;
}

/** 明确表示"已经回过了"（模型这次带了 `say`） */
export function clearInterjected() {
  pending = null;
}

/** 现在还有没有没回的插话（过期就自动清掉） */
export function pendingInterjected(now = Date.now()) {
  if (!pending) return null;
  if (now - pending.at > PENDING_TTL_MS) { pending = null; return null; }
  return pending;
}

const clip = (s, n = 80) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/**
 * 插话交给模型的那一段话。
 *
 * 三条都是踩出来的：
 *   ① **先说话再干活** —— 普通回复用户看不见，只有 `say` 进流、被念；
 *   ② **`say` 和取图可以同一次调用** —— handler 在跑主流程之前就写流，字先出、画面后到，
 *      所以不需要"先调一次 say、再调一次 speakNow"两次往返；
 *   ③ **台词优先，但不是沉默优先** —— 欠台词时把 `lines` 和 `say` 一起给，两件事不冲突。
 *
 * @param {string} text 用户原话
 * @param {{ at?: number|null }} [o] `at` 是收到的墙钟时刻（写进抬头，便于对时）
 */
export function interjectNote(text, { at = null } = {}) {
  const said = String(text ?? '').trim();
  noteInterjected(said, at ? { at } : undefined);
  const when = Number.isFinite(Number(at))
    ? ` @${new Date(Number(at)).toTimeString().slice(0, 8)}`
    : '';
  return `[一起看·用户插话${when}] 「${said}」\n`
    + '⚠️ **先说话，再干活。** 你写的普通回复在悬浮窗里一个字都看不到（也不会被念），'
    + '只有 `say` 会进那条流。所以下一次工具调用**必须带 `say`**，把回应放在最前面：\n'
    + '  · 只回一句：      watch_together({ say: "…" })\n'
    + '  · 要同时看一眼：  watch_together({ say: "我看一眼", speakNow: true })\n'
    + '    （`say` 在取图/建图**之前**就写进流 —— 字先出、画面后到。'
    + '别一声不吭先去 zoom 或取图，用户会以为你没听见。）\n'
    + '台词优先：如果还有段欠台词，把 `lines` 和 `say` 放在**同一次调用**里 —— '
    + '先回这一句，词一起写，两件事不冲突，别拆成两次调用（那中间又是一段沉默）。';
}

/**
 * 工具结果末尾的"你还没回她"。
 *
 * @param {{ answered?: boolean, now?: number }} [o] `answered` = 这次调用带了 `say`
 * @returns {string} 没有待回执 / 已回 → 空串
 */
export function replyReminder({ answered = false, now = Date.now() } = {}) {
  if (answered) { clearInterjected(); return ''; }
  const p = pendingInterjected(now);
  if (!p) return '';
  const age = Math.max(0, Math.round((now - p.at) / 1000));
  return `\n[未回应] 用户 ${age} 秒前说的「${clip(p.text)}」你还没回。`
    + '悬浮窗里只有 `say` 会显示、会被念 —— 现在补一句：'
    + 'watch_together({ say: "…" })，要做的事可以放在同一次调用里。';
}

/** 仅测试用：清掉待回执，免得用例之间互相污染 */
export function __resetInterject() {
  pending = null;
}
