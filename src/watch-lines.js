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

import { matchSegments, recallSegments } from 'dsh-video-storyboard/locate';
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

/**
 * 把 `at` 落在一段区间里的台词**取走**（返回出来，槽位里删掉）。
 *
 * 谁用得到：模型刚回了一句插话，而脚本台词在同一段时间里也有一句 —— 两句挨着念出来
 * 会连成一串（声音引擎串行，第二句要么排到后面、要么被适配器当作"追不上"直接丢掉）。
 * 所以把这段时间里的词取出来交给调用方：**让模型按它刚说的那句重写**，而不是默默删掉。
 *
 * 为什么放在这个文件：槽位格式（`{queue:[{text,at}]}`）只有这里知道。
 * 从外面按 `JSON.parse(...).queue` 去改，格式一改就静默失效。
 *
 * @param {number} lo 区间起点（播放秒，含）
 * @param {number} hi 区间终点（播放秒，含）
 * @returns {Promise<Array<{from:number, at:number, text:string}>>} 取走的那些
 */
export async function pullItemsBetween(input, lo, hi, { env = process.env } = {}) {
  const from = Number(lo);
  const to = Number(hi);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return [];
  const st = await loadWatch(env);
  const sk = sessionKey(input);
  const lines = st[sk]?.lines;
  if (!lines) return [];

  const pulled = [];
  let dirty = false;
  for (const key of Object.keys(lines)) {
    // 段起点在区间之后 = 这一段整个还在未来，连看都不用看
    if (!(Number(key) <= to)) continue;
    const items = slotItems(lines[key]);
    const kept = [];
    for (const it of items) {
      const at = Number(it.at);
      if (Number.isFinite(at) && at >= from && at <= to) pulled.push({ from: Number(key), at, text: it.text });
      else kept.push(it);
    }
    if (kept.length !== items.length) {
      writeSlot(lines, key, kept);
      dirty = true;
    }
  }
  if (dirty) {
    st[sk] = { ...(st[sk] ?? {}), lines, at: Date.now() };
    await saveWatch(st, env);
  }
  return pulled.sort((a, b) => a.at - b.at);
}

const writeSlot = (lines, from, items) => {
  if (items.length > 0) lines[from] = { queue: items, savedAt: Date.now() };
  else delete lines[from];
};

/** 归一化：去空白和标点，只留字。查锚点时"有没有标点"不该影响命中。 */
const bare = (s) => String(s ?? '').toLowerCase()
  .replace(/[\s\u3000]+/g, '')
  .replace(/[，。！？、；：""''（）《》…—,.!?;:"'()<>[\]{}~`]/g, '');

/**
 * 把 `at` 传的"字幕原文片段"查成秒数。
 *
 * 两条查找，按可靠性排：
 *   1. **本段及之后**的句子里做原文包含（同一句话在片子里会重复，取最早那次会落到上一段）
 *   2. 拼句/记错一两个字 —— 用 locate 的模糊匹配兜一下（≥60% 的字对得上）
 *
 * 查不到就返回 null，由调用方当"没写 at"处理（交给 pinTimes 铺开），并打日志。
 *
 * @param {Array<{from:number,text:string}>} cues
 * @param {string} q 字幕原文片段
 * @param {number} from 这句所属段的起点
 */
function anchorAt(cues, q, from) {
  const list = (Array.isArray(cues) ? cues : []).filter((c) => Number.isFinite(Number(c?.from)));
  if (list.length === 0) return null;
  const nq = bare(q);
  if (!nq) return null;
  const later = list.filter((c) => Number(c.from) >= Number(from) - 0.5);
  const pool = later.length > 0 ? later : list;
  const exact = pool.find((c) => bare(c.text).includes(nq));
  if (exact) return Number(exact.from);
  const [best] = matchSegments(pool, q, { max: 1, minScore: 0.6 });
  return best ? Number(best.from) : null;
}

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
      const q = l.at.trim();
      // **先查落盘的 `subs-<key>.json`，再查 locate 的进程内记忆**。
      // 后者只有 4 条、重启就空，而台词恰恰经常在另一个进程/另一轮里写 ——
      // 查不到就会被当成"没写 at"，落到段首：用户看到的就是"台词比画面早一大截"。
      const subs = cachedCues(input, { env });
      let hit = anchorAt(subs, q, from);
      if (hit === null) hit = anchorAt(recallSegments(input) ?? [], q, from);
      at = hit === null ? NaN : hit;
      if (!Number.isFinite(at)) {
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
export async function consumeLine(input, from, { env = process.env, notAfter = Infinity } = {}) {
  const st = await loadWatch(env);
  const sk = sessionKey(input);
  const lines = st[sk]?.lines;
  if (!lines) return null;
  const key = Number(from);
  const items = slotItems(lines[key]);
  if (items.length === 0) return null;
  // `notAfter` = 只取已经到点的第一条。段末交付点比段内台词的 at 早时，
  // 不传这个限制会把**未来**的那句提前消费掉，到点就再也没词了。
  const limit = Number(notAfter);
  const index = Number.isFinite(limit)
    ? items.findIndex((it) => it.at === null || Number(it.at) <= limit)
    : 0;
  if (index < 0) return null;
  const [hit] = items.splice(index, 1);
  writeSlot(lines, key, items);
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
 * 两版都踩过坑，改之前先看清楚：
 *
 *   ① 最早是**均匀铺开**（`from + i*size/n`）：三段词就是 0/40/80 秒。画面不按这个
 *      节奏走，那几句往往比对应画面早十几二十秒 —— "台词比画面早"（2026-10-31 实报）。
 *
 *   ② 后来改成"贴着真实句子起点"，但**取的是这一段里最前面的 N 个起点**。于是 16 句
 *      台词全被钉进段首 60 秒里，平均 2~3 秒一条：钟每 2 秒打一拍、一拍发一句，
 *      用户听到的就是"机关枪突突突"，而且后 14 句比画面早一到两分钟
 *      （2026-10-31 19:5x 实报，用当时挂着的 16 条实测：181.6→244.2，本来该铺满 180 秒）。
 *
 * 所以现在：**先算每句在这一段里的理想位置（均分），再去字幕里挑离它最近的句子起点**。
 * 既贴着真实说话的时刻，又铺满整段。挑不到（离理想位置超过半个槽位 / 起点用完了）
 * 就用理想位置本身 —— 绝不允许比上一句更早（旧实现会退成 150 < 152.8 这种乱序）。
 *
 * @param {Array<{at:number|null,text:string}>} items
 * @param {number} from 段起点（秒）
 * @param {number} size 段长（秒）
 * @param {Array<{from:number,to:number,text:string}>} cues 这一段附近的时间码
 */
export function pinTimes(items, from, size, cues = []) {
  const end = from + size;
  // 起点去重（同一条字幕重复出现很常见），保留两位小数避免浮点抖动
  const starts = [...new Set((Array.isArray(cues) ? cues : [])
    .map((c) => Number(c?.from))
    .filter((t) => Number.isFinite(t) && t >= from - 0.5 && t < end)
    .map((t) => +t.toFixed(2)))]
    .sort((a, b) => a - b);

  const n = items.length;
  const slot = size / n;
  // 容差：半个槽位。字幕起点密的时候贴句子，稀的时候就老实按均分走 ——
  // 否则"最近起点"可能离理想位置几十秒，等于把第 5 句又拽回段首。
  const tol = Math.min(30, Math.max(2, slot / 2));

  const out = [];
  let cursor = from;
  let pi = 0;
  for (let i = 0; i < n; i++) {
    const it = items[i];
    if (it?.at !== null && it?.at !== undefined && Number.isFinite(Number(it?.at))) {
      out.push(it);
      cursor = Math.max(cursor, Number(it.at) + 1);
      continue;
    }
    // 这一句在这一段里的理想位置：按顺序均分
    const ideal = from + (i * size) / n;
    let pick = -1;
    let bestD = Infinity;
    for (let k = pi; k < starts.length; k += 1) {
      if (starts[k] < cursor) { pi = k + 1; continue; }
      const d = Math.abs(starts[k] - ideal);
      if (d < bestD && d <= tol) { bestD = d; pick = k; }
      // 已经越过理想位置，再往后只会更远
      if (starts[k] >= ideal) break;
    }
    const at = pick >= 0 ? Math.max(starts[pick], cursor) : Math.max(ideal, cursor);
    if (pick >= 0) pi = pick + 1;
    out.push({ ...it, at });
    cursor = at + 1;
  }
  return out;
}

/**
 * @param {number} pos 当前播放位置（秒）
 * @param {{ size?: number, sizeOf?: (from:number)=>number, lateSec?: number,
 *   lagSec?: number, meta?: boolean }} [o]
 *        `size` 当前段长；`sizeOf(from)` 给**别的段**取它自己的段长（见下面 pin 的那段注释）；
 *        `meta: true` 时返回 `{ text, at, lateSec }` 而不是纯字符串 ——
 *        循环要靠它算"这句比画面晚了多少秒"（`statusOnly` 的可观测性用）。
 */
export async function dueLine(input, pos, {
  size = 0, sizeOf = null, lateSec = 3, lagSec = null, env = process.env, meta = false,
} = {}) {
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
  let dirty = false;              // 整份有没有改动（决定结尾要不要写盘）
  for (const [key, slot] of Object.entries(lines)) {
    const from = Number(key);
    // 未来段落的词不参与：写 360s 的词不该在 150s 就被念出来
    if (!(from <= now)) continue;
    let items = slotItems(slot);
    // **段长要按这一句自己所属的段算**：批次表是 1/2/3/4/5 分钟递进的，
    // 拿当前段（可能是 5 分钟）去铺开头那段 60 秒的稿子，后几句会被铺到段外，
    // 结果整段听着都错位。`sizeOf` 由调用方按批次表给。
    const own = typeof sizeOf === 'function' ? Number(sizeOf(from)) : NaN;
    const ownSize = Number.isFinite(own) && own > 0 ? own : size;
    // **改动要按段算**：以前用的是外层那个 `dirty`，一段 pin 过之后后面每一段都会重写一遍
    // watch.json（钟每 2 秒一拍，等于每 2 秒写一次盘），而内容其实没变。
    let changed = false;
    // **把"没写 at"的台词当场钉死**：一旦有了段长，就把它们铺进这一段并存回去。
    // 不能每次读都现算：念掉一条之后队列长度变了，后面几条的时刻会跟着往前跳
    // （实测：四句 60 秒的稿子，念掉第一句后第二句的时刻从 135 变成 120，于是连珠炮）。
    if (ownSize > 0 && items.some((x) => x.at === null)) {
      items = pinTimes(items, from, ownSize, subs);
      changed = true;
    }
    // **迟到就作废**：位置跳过去了（拖进度条 / 快进），那句描述的画面已经不在银幕上，
    // 补念出来只会和画面对不上。停顿几秒内的正常延迟仍然会念。
    // 判断用"该开口的时刻"（at + 后延），否则加了延以后正常的一句也会被当成迟到删掉。
    // **没写 at 的不参与作废**：它们的时刻还没算出来（见上面 pin 的那段），
    // 拿 -Infinity 去比就是"永远迟到" —— 那会把整批好词静默删掉。
    const kept = items.filter((x) => x.at === null || !(dueAt(x.at, x.text) < now - lateSec));
    if (kept.length !== items.length) { items = kept; changed = true; }
    if (changed) { writeSlot(lines, from, items); dirty = true; }
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
  if (meta) {
    // 迟到多少秒：现在的播放位置 - 这句本该开口的时刻（正数 = 晚了）
    const planned = dueAt(best.at, best.text);
    return {
      text: best.text,
      at: Number.isFinite(Number(best.at)) ? Number(best.at) : null,
      planned: Number.isFinite(planned) ? +Number(planned).toFixed(2) : null,
      late: Number.isFinite(planned) ? +(now - planned).toFixed(1) : null,
    };
  }
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
