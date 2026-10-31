/**
 * watch-state.js — 陪看会话的状态存哪儿、怎么存，以及"一段多长、什么时候该说话"的算术。
 *
 * 存盘是为了宿主重启后接着看，不必重头。**只记指针，不记内容**：
 * 内容和图都在分镜缓存里，重复算一遍也就 8 s。
 *
 * 和 watch-lines.js 的分工：这里只管"这一部片子看到哪了"，
 * 台词队列怎么增删是那边的事 —— 两边都调 loadWatch/saveWatch，但互不了解对方写了什么。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { cacheDir } from 'dsh-video-storyboard/cache';
import { DEFAULT_SEGMENT } from './batches.js';

/**
 * 提前多少秒交付：用户还在看，但这段快到尾巴了，此刻插话不打断。
 *
 * **段长不在这里** —— 它由 `batches.js` 的批次表唯一定义（1/2/3/4 分钟 → 5 分钟稳定）。
 * 这里以前还导出一个 `WATCH_SEGMENT = 120`，和批次表的 300 并存，于是
 * "一段多长"在代码里有两个答案：谁先兜底就用谁的。2026-10-31 收成一处。
 */
export const WATCH_LEAD = 15;

/** 路径归一成小写正斜杠 —— 同一个文件在不同写法下必须算同一个会话。 */
export const norm = (p) => String(p ?? '').replace(/\\/g, '/').toLowerCase();

/** 老键（= 整条 URL 归一）。只用来把旧状态迁到新键上，新代码不要再拿它当键。 */
export const legacySessionKey = (input) => norm(input);

/**
 * **视频身份**：同一支片子的不同 URL 形态必须落到同一个键。
 *
 * 踩过的坑（实测）：浏览器扩展上报的是带追踪参数的完整地址
 * （`…/BV1g3xN6hEuw/?trackid=…&spm_id_from=…&vd_source=…`），而模型手里是干净的
 * `…/BV1g3xN6hEuw/`。以前键就是整条 URL，于是**同一支片子被拆成两个会话**：
 * 台词写在 A 键下，交付时查 B 键 —— 于是明明写了台词，结果里还挂着
 * 「[DELIVERY INCOMPLETE] 这一段还没有台词」。这个坑必须从根上堵。
 *
 * 规则：
 *   B 站   `bili:<bv 号>`（BV 号就是身份，大小写无关）
 *   其他 URL `host + pathname`（去掉 query / hash，去尾斜杠）
 *   本地文件 只看文件名（同一目录换了写法也算同一支）
 */
export function sessionKey(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return 'unknown';
  if (/^https?:/i.test(raw) || /^file:/i.test(raw)) {
    try {
      const u = new URL(raw);
      const bv = u.pathname.match(/\/video\/(bv[0-9a-z]+)/i);
      if (bv) return `bili:${bv[1].toLowerCase()}`;
      const p = decodeURIComponent(u.pathname).replace(/\/+$/, '');
      const k = `${u.host.toLowerCase()}${p}`.toLowerCase();
      if (k && k !== '') return k;
    } catch { /* 不是合法 URL，当路径处理 */ }
  }
  const path = raw.replace(/^file:\/\//i, '');
  return norm(path.split(/[\\/]/).filter(Boolean).pop()) || 'unknown';
}

/**
 * 把旧键（整条 URL）并到新键上。
 *
 * 只在新键**不存在**时搬；两边的同名字段合并（旧的 wins 只在缺失时补），
 * 免得迁移把新会话里刚写的东西盖掉。返回是否改动过。
 */
export function migrateKeys(state) {
  let changed = false;
  for (const key of Object.keys(state)) {
    const node = state[key];
    if (!node || typeof node !== 'object') continue;
    // **只迁 URL 键**。不是 URL 的键（`example.com/v/1` 这种测试用的、或别的调用方自己造的键）
    // 一律别碰：sessionKey 会把它们当路径取末段，迁一下就把数据搬到别的名字下面去了
    // （实测：`example.com/v/1` 被迁成 `1`，于是 saveLines 写进去、readSlot 读不到）。
    if (!/^https?:\/\//i.test(key) && !/^file:\/\//i.test(key)) continue;
    const target = sessionKey(key);
    if (target === key) continue;
    const prev = state[target];
    if (!prev || typeof prev !== 'object') {
      delete state[key];
      state[target] = node;
      changed = true;
      continue;
    }
    // 两个都在：合并（保留较新的 at），然后删掉旧键
    const merged = { ...node, ...prev };
    merged.at = Math.max(node.at ?? 0, prev.at ?? 0) || merged.at;
    for (const field of ['lines', 'material', 'missingLines', 'spoken']) {
      if (node[field] || prev[field]) {
        merged[field] = { ...(node[field] ?? {}), ...(prev[field] ?? {}) };
      }
    }
    state[target] = merged;
    delete state[key];
    changed = true;
  }
  return changed;
}

export function watchPath(env = process.env) {
  return join(cacheDir(env), 'watch.json');
}

/**
 * "用户自己把悬浮窗关了" 这件事要**记住**。
 *
 * 关窗是他表达"我不看了"的方式。可下一轮工具调用又按"新开一场"处理，把窗口顶回来
 * —— 等于把用户的动作撤销掉（2026-10-31 实报：「我每次关了悬浮窗…他又重新拉起来悬浮窗」）。
 *
 * 所以：关窗时落一条 `hangup`，之后**只有用户明确要求重开**（工具参数 `open: true`，
 * 或换了一支片子）才清掉它。
 */
export async function markHungUp(input, env = process.env) {
  const st = await loadWatch(env);
  st.hangup = { key: sessionKey(input), at: Date.now() };
  await saveWatch(st, env);
  return st.hangup;
}

/** 这个 input 是不是"被用户挂断、且还没说要看"的状态 */
export async function isHungUp(input, env = process.env) {
  const st = await loadWatch(env);
  const h = st.hangup;
  if (!h?.key) return false;
  return h.key === sessionKey(input);
}

/** 清掉挂断记录（用户明确要求重开时） */
export async function clearHungUp(env = process.env) {
  const st = await loadWatch(env);
  if (!st.hangup) return false;
  delete st.hangup;
  await saveWatch(st, env);
  return true;
}

export async function loadWatch(env = process.env) {
  try {
    const state = JSON.parse(await readFile(watchPath(env), 'utf8'));
    // 读进来时顺手把"整条 URL 当键"的老会话并到新键上（一次性、幂等）
    if (migrateKeys(state)) await saveWatch(state, env);
    return state;
  } catch {
    return {};
  }
}

export async function saveWatch(state, env = process.env) {
  try {
    // 只留最近 20 个源：不然看几十部片子之后这个文件会无限长
    const keys = Object.keys(state).sort((a, b) => (state[b]?.at ?? 0) - (state[a]?.at ?? 0));
    const pruned = {};
    for (const k of keys.slice(0, 20)) pruned[k] = state[k];
    await mkdir(cacheDir(env), { recursive: true });
    await writeFile(watchPath(env), JSON.stringify(pruned), 'utf8');
  } catch { /* 存不下就算了，最多重启后重算一段 */ }
}


/**
 * 这一段该不该说话了。
 *
 * 交付点刻意放在**段末前 lead 秒**，不是段末：
 * 用户正看着的时候插一句"这段快完了"，比卡在切换点更自然。
 */
export function deliveryState({ cursor, segment, size = DEFAULT_SEGMENT, lead = WATCH_LEAD }) {
  const end = segment + size;
  const remaining = end - cursor;
  return {
    segmentEnd: end,
    remaining: +remaining.toFixed(1),
    due: remaining <= lead,
    // 已经越界（用户看到下一段去了）也算该说，否则这段永远不会交付
    overdue: remaining <= 0,
  };
}
