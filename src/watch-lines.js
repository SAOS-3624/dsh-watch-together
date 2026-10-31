/**
 * watch-lines.js — 预设台词：agent 提前写好，到点直接念，不用现场想。
 *
 * 这是 watch 里最长的一块（原本和播放进度探测挤在同一个文件里）。核心是一个**位置轴上的队列**：
 * 每句可以带 `at`（绝对秒），到那个位置就念，不由桶边界决定，也不由墙钟决定。
 *
 * 三个容易踩的地方，改之前先看注释：
 *   1. 槽位上的 `at` 是"什么时候写的"，队列项上的 `at` 才是"什么时候念" —— 别混。
 *   2. 带 at 的新词**合并**进同段，不覆盖；不带 at 的才整段覆盖。
 *   3. 没写 at 的老台词要在**有段长时钉死**并存回去，不能每次读都现算。
 */

import { recallSegments } from 'dsh-video-storyboard/locate';
import { makeLagFn, speechLag } from './speech.js';
import { cachedCues } from './lines-util.js';
import { loadWatch, saveWatch, sessionKey } from './watch-state.js';

/**
 * 把槽位规范成 `[{ text, at }]`。兼容三种历史写法：
 *   字符串队列（最早的格式） / 单句 `{ text }` / 带 `at` 的队列。
 *
 * 注意：只认**队列项**上的 `at`（= 该念的时刻）。槽位上那个 `at` 是"什么时候写的"，
 * 拿它当念的时刻，整句会被推到几百年后。
 */
function slotItems(slot) {
  if (!slot) return [];
  const raw = Array.isArray(slot.queue) ? slot.queue : (slot.text ? [{ text: slot.text }] : []);
  return raw
    .map((it) => (typeof it === 'string'
      ? { text: it, at: null }
      : { text: String(it?.text ?? ''), at: Number.isFinite(it?.at) ? Number(it.at) : null }))
    .filter((x) => x.text);
}

/**
 * 从某一段的稿子里挑掉几句（`keep(item) === false` 的删掉）。
 *
 * 为什么需要它：台词的时间窗**过去之后就不该再念** —— 交付时如果发现
 * `at` 早于当前进度（模型写晚了），除了不当场念，还得把它们从稿子里摘掉，
 * 否则钟在看到它们时已经没有意义（`dueLine` 虽然有迟到作废，但留着会让
 * "还欠几句"的判断一直为真）。
 *
 * @returns {Promise<number>} 删掉了几句
 */
export async function pruneSlot(input, from, keep, { env = process.env } = {}) {
  const st = await loadWatch(env);
  const sk = sessionKey(input);
  const lines = st[sk]?.lines;
  if (!lines || !lines[from]) return 0;
  const items = slotItems(lines[from]);
  const kept = items.filter((x) => {
    try { return keep(x) !== false; } catch { return true; }
  });
  const dropped = items.length - kept.length;
  if (dropped > 0) {
    writeSlot(lines, from, kept);
    st[sk].at = Date.now();
    await saveWatch(st, env);
  }
  return dropped;
}

const writeSlot = (lines, from, items) => {
  if (items.length > 0) lines[from] = { queue: items, savedAt: Date.now() };
  else delete lines[from];
};

/**
 * 预设台词：agent 提前写好，到点直接念，不用现场想。
 *
 * 每条可以带 `at`（绝对秒，位置轴上的时刻）：**到那个位置就念**，不由桶边界决定，
 * 也不由墙钟决定。不带 `at` 就按原来的口径——进入这一段时念。
 */
export async function saveLines(input, lines, { env = process.env } = {}) {
  if (!Array.isArray(lines) || lines.length === 0) return 0;
  const st = await loadWatch(env);
  const sk = sessionKey(input);
  const prev = st[sk]?.lines ?? {};

  // 同一次调用里，同一个 from 出现多次 = 这一段要连说几句（按给定顺序）；
  // 只出现一次 = 覆盖这一段原有的稿子（改了主意不该留下旧句）。
  const grouped = new Map();
  for (const l of lines) {
    const from = Number(l?.from);
    const text = String(l?.text ?? '').trim();
    if (!Number.isFinite(from) || !text) continue;
    if (!grouped.has(from)) grouped.set(from, []);
    // `at` 除了秒数，还可以直接传**字幕原文片段**，这里去转写里查它的 from。
    // 为什么必须有这条路：模型凭印象写秒数会整段错 —— 实测把"1/4 螺口"挂在 189 秒，
    // 而字幕里它在 247 秒，提前了 58 秒，用户当场发现"台词对不上视频"。
    let at = Number(l?.at);
    if (typeof l?.at === 'string' && l.at.trim()) {
      const segs = recallSegments(input) ?? [];
      const q = l.at.trim();
      const hit = segs.find((x) => String(x.text ?? '').includes(q));
      at = hit ? Number(hit.from) : NaN;
      if (!hit) {
        // 查不到就明确说出来，别悄悄当成"没写 at"（那会让它落在段首，更错）
        console.warn(`[watch] line anchor not found in transcript: ${q}`);
      }
    }
    grouped.get(from).push({
      text: text.slice(0, 300),
      ...(Number.isFinite(at) ? { at } : {}),
    });
  }

  let n = 0;
  for (const [from, items] of grouped) {
    // **带 at 的按时刻合并**，不覆盖同段其它句子。
    // 以前这里是无条件覆盖，于是"后补一句收尾词"会把这一批已经写好的四句全冲掉 ——
    // 表现是台词凭空消失，而且没有任何提示。
    const withAt = items.filter((x) => x.at !== undefined);
    if (withAt.length > 0) {
      const merged = new Map();
      for (const it of slotItems(prev[from])) merged.set(it.at ?? null, it);
      for (const it of items) merged.set(it.at ?? null, it);   // 同一个 at = 改词
      const list = [...merged.values()].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
      writeSlot(prev, from, list);
    } else {
      // 老口径（不带 at）：这一段只有一句 / 一组，整段覆盖
      prev[from] = { queue: items, savedAt: Date.now() };
    }
    n += items.length;
  }
  st[sk] = { ...(st[sk] ?? {}), lines: prev, at: Date.now() };
  await saveWatch(st, env);
  return n;
}

/** 取某一段的预设台词（没有就 null） */
export async function loadLine(input, from, { env = process.env } = {}) {
  const st = await loadWatch(env);
  const hit = st[sessionKey(input)]?.lines?.[Number(from)];
  return slotItems(hit)[0]?.text ?? null;
}

/**
 * 念完就删。
 *
 * 为什么必须删：用户倒回去重看时，如果这句还留着，会被**一模一样地再说一遍** —— 太假了。
 * 删掉之后同一段再遇到，会退回"到点再看一眼图"，说出来的话至少是新的。
 */
export async function consumeLine(input, from, { env = process.env } = {}) {
  const st = await loadWatch(env);
  const sk = sessionKey(input);
  const lines = st[sk]?.lines;
  if (!lines) return null;
  const key = Number(from);
  const items = slotItems(lines[key]);
  if (items.length === 0) return null;
  const [hit, ...rest] = items;
  writeSlot(lines, key, rest);
  st[sk] = { ...(st[sk] ?? {}), lines, at: Date.now() };
  await saveWatch(st, env);
  return hit.text;
}

/**
 * **到点的那一句**：在所有已写好的台词里，找 `at` 最小且已经到点的那一条，念掉它。
 *
 * 为什么需要它：剧本是按"段"写的，但说话的时刻是**位置**上的一个点。
 * 拿段边界当触发点，一段里写四句就会在段首连着说完、然后整整一分钟没词 ——
 * 听起来就是"比我看到的快很多"（实测日志：02:26 / 02:38 / 02:50 … 每 12 秒一句，
 * 而画面是一分钟才跨一个内容段）。
 *
 * 这里按 `at` 触发：位置到哪，就说到哪。暂停时位置不动，也就不会继续说。
 * 不带 `at` 的老台词按"进入这一段"处理，并在段内均匀铺开（每条占 1/k 段）。
 * 迟到超过 `lateSec`（默认 3 秒）的词直接作废：位置跳过去了，那句描述的画面已经不在。
 * 只认"两个时间大致相等"——早一点不发，晚太多也不要。
 *
 * @param {number} pos  当前播放位置（秒）
 * @param {{ size?: number, lateSec?: number }} [o] 当前段长（给没写 at 的台词分位）、迟到宽限
 */

/**
 * 给"没写 `at`"的台词补上时刻。
 *
 * 以前是**均匀铺开**（`from + i*size/n`）：三段词就是 0/40/80 秒。
 * 问题是画面里的句子不会按这个节奏出现 —— 那几句往往比对应画面早十几二十秒，
 * 用户看到的就是"台词比画面早"（2026-10-31 实报，截图里标签 01:51 / 02:39 都在画面前面）。
 *
 * 现在优先**贴着真实句子起点**：字幕（CC 或 ASR 的时间码）里这一段的句子起点，
 * 按顺序分给各句；分完还有剩，才退回均匀铺开。
 *
 * @param {Array<{at:number|null,text:string}>} items
 * @param {number} from 段起点（秒）
 * @param {number} size 段长（秒）
 * @param {Array<{from:number,to:number,text:string}>} cues 这一段附近的时间码
 */
export function pinTimes(items, from, size, cues = []) {
  const end = from + size;
  const starts = (Array.isArray(cues) ? cues : [])
    .map((c) => Number(c?.from))
    .filter((t) => Number.isFinite(t) && t >= from - 0.5 && t < end)
    .sort((a, b) => a - b);

  const n = items.length;
  const out = [];
  let cursor = from;
  let pi = 0;
  for (let i = 0; i < n; i++) {
    const it = items[i];
    if (it?.at !== null && Number.isFinite(Number(it?.at))) {
      out.push(it);
      cursor = Math.max(cursor, Number(it.at) + 1);
      continue;
    }
    // 找下一个还没用过的句子起点
    while (pi < starts.length && starts[pi] <= cursor) pi += 1;
    if (pi < starts.length) {
      out.push({ ...it, at: starts[pi] });
      cursor = starts[pi] + 1;
      pi += 1;
    } else {
      // 没有字幕可用：退回均匀铺开（至少不会全部挤在段首）
      out.push({ ...it, at: from + (i * size) / n });
    }
  }
  return out;
}

export async function dueLine(input, pos, { size = 0, lateSec = 3, lagSec = null, env = process.env } = {}) {
  const now = Number(pos);
  if (!Number.isFinite(now)) return null;
  const st = await loadWatch(env);
  const sk = sessionKey(input);
  const lines = st[sk]?.lines;
  if (!lines) return null;

  // 台词要往后挪多久：`at` 对齐的是"这句字幕**出现**的时刻"，TTS 一开口就和原声抢话。
  // 延迟按 **这句字幕本身有多少字** 算（说得越久的句子，越要往后等）。
  //
  // 取字幕的三条路，按可靠性排：
  //   1. `cachedCues(input)` —— 我们自己的 `subs-<key>.json` 缓存（**跨进程可靠**）
  //   2. `recallSegments(input)` —— 分镜包 locate 的 in-memory 记忆（新进程里常常是空的）
  //   3. 都没有 → 退化成按台词自己的字数估（见下面的 `lagFor`）
  const subs = cachedCues(input, { env });
  const lagOf = makeLagFn(subs.length > 0 ? subs : (recallSegments(input) ?? []));
  const lagFor = (at, text) => {
    // 测试要确定性：显式给 `lagSec`（通常 0）就直接用它，不查字幕也不按长度估
    if (Number.isFinite(lagSec)) return Number(lagSec);
    const fromSubs = lagOf(at);
    if (fromSubs > 0) return fromSubs;
    // 回退：按这一句自己的字数估（越长的句子，原声说完需要越久）
    return speechLag(String(text ?? '').length);
  };
  // 真正可以开口的时刻。没写 at 的老台词不参与（它们按"进入这一段"处理）。
  const dueAt = (at, text) => (at === null || !Number.isFinite(Number(at))
    ? -Infinity
    : Number(at) + lagFor(at, text));

  let best = null;
  let dirty = false;
  for (const [key, slot] of Object.entries(lines)) {
    const from = Number(key);
    // 未来段落的词不参与：写 360s 的词不该在 150s 就被念出来
    if (!(from <= now)) continue;
    let items = slotItems(slot);
    // **把"没写 at"的台词当场钉死**：一旦有了段长，就把它们均匀铺进这一段并存回去。
    // 不能每次读都现算：念掉一条之后队列长度变了，后面几条的时刻会跟着往前跳
    // （实测：四句 60 秒的稿子，念掉第一句后第二句的时刻从 135 变成 120，于是连珠炮）。
    if (size > 0 && items.some((x) => x.at === null)) {
      items = pinTimes(items, from, size, subs);
      dirty = true;
    }
    // **迟到就作废**：位置跳过去了（拖进度条 / 快进），那句描述的画面已经不在银幕上，
    // 补念出来只会和画面对不上。停顿几秒内的正常延迟仍然会念。
    // 判断用"该开口的时刻"（at + 后延），否则加了延以后正常的一句也会被当成迟到删掉。
    const kept = items.filter((x) => !(dueAt(x.at, x.text) < now - lateSec));
    if (kept.length !== items.length) {
      items = kept;
      dirty = true;
    }
    if (dirty) writeSlot(lines, from, items);
    items.forEach((item, i) => {
      if (dueAt(item.at, item.text) > now) return;
      if (!best || item.at < best.at) best = { from, index: i, at: item.at, text: item.text };
    });
  }
  if (!best) {
    if (dirty) {
      st[sk] = { ...(st[sk] ?? {}), lines, at: Date.now() };
      await saveWatch(st, env);
    }
    return null;
  }

  const items = slotItems(lines[best.from]);
  writeSlot(lines, best.from, items.slice(0, best.index).concat(items.slice(best.index + 1)));
  st[sk] = { ...(st[sk] ?? {}), lines, at: Date.now() };
  await saveWatch(st, env);
  return best.text;
}

/** 这一段还有没有台词（给"余量不足就叫醒模型"用） */
export async function hasLine(input, from, { env = process.env } = {}) {
  const st = await loadWatch(env);
  return slotItems(st[sessionKey(input)]?.lines?.[Number(from)]).length > 0;
}

/**
 * 某一段**还挂着**的台词（`[{ text, at }]`）。
 *
 * 给 `watch_together` 返回值的 `speech` 事件用：核心不发声，但只要把这份带 `at` 的稿子交出去，
 * 谁想接声音都能接（见 voice.js）。和 `loadLine` 的区别是它给整段，不是第一句。
 */
export async function readSlot(input, from, { env = process.env } = {}) {
  const st = await loadWatch(env);
  return slotItems(st[sessionKey(input)]?.lines?.[Number(from)]);
}

/** 库存概览：已经写好台词的段有哪些（诊断用） */
export async function linesOverview(input, { env = process.env } = {}) {
  const st = await loadWatch(env);
  const lines = st[sessionKey(input)]?.lines ?? {};
  return Object.entries(lines)
    .map(([from, slot]) => {
      const items = slotItems(slot);
      return { from: Number(from), count: items.length, ats: items.map((x) => x.at).filter((x) => x !== null) };
    })
    .filter((x) => x.count > 0)
    .sort((a, b) => a.from - b.from);
}
