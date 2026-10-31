/**
 * watch-material.js — **一段的"素材"到齐了没有**：图 和 字幕。
 *
 * ## 为什么要有这个状态
 *
 * 台词是从"看到的东西"加上"听到的句子"里写出来的，两半缺一不可：
 *
 *   image       storyboard 那张九宫格（画面上发生了什么）
 *   transcript  这一段的句子 + 每句的**真实起始秒**（`at` 用哪个数）
 *
 * 以前这两半是**同一次返回**给的（清单里每格下面带一行转写），所以"到齐了没有"
 * 这个问题不存在。接下来要把它们拆开返回（图一次、字幕一次），甚至可能只给其中一半
 * —— 那"台词该不该现在写"就必须有个显式状态，否则模型会拿半份素材开始编。
 *
 * 所以这里只做一件事：记下**哪一半已经交到模型手里了**，然后回答两个问题：
 *   · 齐了吗？（`ready`）
 *   · 缺哪一半？（`missing`）—— 结果里据此附一句"下一步该调什么"。
 *
 * ## 只记"交出过"，不记"模型读过"
 *
 * 工具层能知道的只有"我返回过这张图/这份字幕"。模型有没有看是它自己的事，
 * 这里不假装能验证 —— 但它能保证：**没返回过的东西，不许被当成素材用**。
 * 换句话说，`[material]` 说的是"我给了你什么"，不是"你懂了吗"。
 *
 * 存在 `watch.json` 的会话节点下（和 spoken / missingLines 同一层），
 * 所以跨调用、跨重启都还在；只留最近 40 段，别让状态文件无限长。
 */

import { loadWatch, saveWatch, sessionKey } from './watch.js';

const KEEP = 40;

/** 这个"一半"的名字就是状态里的键，别写字面量 */
export const MATERIAL_PARTS = ['image', 'transcript'];

function ensureSession(st, input) {
  const sk = sessionKey(input);
  st[sk] = st[sk] ?? {};
  st[sk].material = st[sk].material ?? {};
  return st[sk];
}

/**
 * 记下"这一半已经交出去了"。
 *
 * @param {'image'|'transcript'} part
 * @returns {Promise<{image:number|null, transcript:number|null, ready:boolean, missing:string|null}>}
 */
export async function markMaterial(input, segFrom, part, { env = process.env } = {}) {
  const st = await loadWatch(env);
  const s = ensureSession(st, input);
  const from = Number(segFrom);
  if (!Number.isFinite(from)) return { image: null, transcript: null, ready: false, missing: 'image' };
  const cur = s.material[from] ?? {};
  s.material[from] = { ...cur, [part]: Date.now() };
  // 只留最近 40 段（按时间排，最旧的那批丢掉）
  const keys = Object.keys(s.material).sort((a, b) => {
    const ta = Math.max(s.material[a]?.image ?? 0, s.material[a]?.transcript ?? 0);
    const tb = Math.max(s.material[b]?.image ?? 0, s.material[b]?.transcript ?? 0);
    return tb - ta;
  });
  for (const k of keys.slice(KEEP)) delete s.material[k];
  await saveWatch(st, env);
  return materialOf(s, from);
}

/** 这一段的素材状态（只读，不写盘） */
export async function materialState(input, segFrom, { env = process.env } = {}) {
  const st = await loadWatch(env);
  const s = st[sessionKey(input)] ?? {};
  return materialOf(s, Number(segFrom));
}

function materialOf(s, from) {
  const cur = s?.material?.[from] ?? {};
  const image = Number.isFinite(cur.image) ? cur.image : null;
  const transcript = Number.isFinite(cur.transcript) ? cur.transcript : null;
  const ready = Boolean(image && transcript);
  const missing = ready ? null : (image ? 'transcript' : 'image');
  return { image, transcript, ready, missing };
}

/**
 * 给模型看的一句话：现在能写台词了吗，不能的话下一步调什么。
 *
 * 文案直接写成"可执行的下一步" —— 只说"缺字幕"模型还得自己想去调什么参数，
 * 而它手里没有工具文档。
 */
export function materialNote(state) {
  if (state.ready) {
    return '\n[素材] 图 ✔ 字幕 ✔ —— 两半都到了，现在写台词（`lines`）。';
  }
  if (state.image && !state.transcript) {
    return '\n[素材] 图 ✔ 字幕 ✘ —— 句子的**真实秒数**还没有，先取字幕：'
      + ' `watch_together({ transcriptOnly: true, input: <同一个 input>, from: <段起点>, size: <段长> })`，'
      + '或者 `node bin/lines.mjs scan --from <段起点> --size <段长>`。'
      + '**别凭印象写 `at`** —— 字幕里有确切时间，凭感觉写的会整段错位。';
  }
  if (!state.image && state.transcript) {
    return '\n[素材] 图 ✘ 字幕 ✔ —— 有句子但没看到画面，先取图：'
      + ' 再调一次（`wait: true` 或 `speakNow: true`）让它把这一段交出来。';
  }
  return '\n[素材] 图 ✘ 字幕 ✘ —— 这一段还什么都没有，先取素材再写台词。';
}
