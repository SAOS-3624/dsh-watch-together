/**
 * position-bridge.js — 浏览器扩展报上来的播放位置。
 *
 * ## 为什么要有这条通道
 *
 * 位置原来是靠浏览器调试端口（CDP）读的，但 CDP 有个死结：**必须带着
 * `--remote-debugging-port` 启动浏览器**，而且 Chromium 136 之后还不许用默认 profile。
 * 也就是说用户必须另外开一个"陪看专用窗口"。
 *
 * 扩展没有这个限制：它是浏览器**明确信任**的通道。装一次之后，用户平时怎么开浏览器都行，
 * 扩展在页面里读 `video.currentTime`，POST 到本地这个服务。
 *
 * ## 为什么落盘而不是留在内存
 *
 * 上报的进程（插件里跑着 9377 服务的那个）和读位置的进程**可能不是同一个**：
 * 插件内是同一个进程；但 CLI（`watch.mjs`）是另一个进程，它也要能读到。
 * 所以写到缓存目录下的一个 json 里，谁都能读。
 *
 * 文件很小（两百来字节），每秒写一次；写入走"临时文件 + rename"，
 * 读的人不会读到半截 JSON。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { cacheDir } from 'dsh-video-storyboard/cache';

export const BRIDGE_FILE = 'position.json';

/**
 * 多久算"新鲜的"。
 *
 * 扩展是每秒上报一次。留 5 秒的余量：偶尔丢一两次上报（页面在后台被节流、
 * 或者 service worker 被回收重建）不该让位置突然变成"读不到"。
 */
export const BRIDGE_MAX_AGE_MS = 5000;

/** 关掉这条通道（测试用：免得读到这台机器上真实的播放位置） */
export function bridgeEnabled(env = process.env) {
  return env.DSH_WATCH_BRIDGE !== '0';
}

export function bridgePath(env = process.env) {
  return join(cacheDir(env), BRIDGE_FILE);
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * 把上报的原始 JSON 规范化。位置本身必须有效，其余字段缺了就算了。
 *
 * `at` **用服务端收到的时刻**，不用上报方的时间：浏览器和服务器的时钟可能差几秒，
 * 而这里判断的是"多久没收到新上报"，只能在同一个时钟上比。
 */
export function normalizeBridgeSample(raw, now = Date.now()) {
  const pos = num(raw?.pos);
  if (pos === null || pos < 0) return null;
  const dur = num(raw?.dur);
  return {
    pos,
    dur: dur && dur > 0 ? dur : null,
    title: typeof raw?.title === 'string' ? raw.title.slice(0, 200) : null,
    url: typeof raw?.url === 'string' ? raw.url.slice(0, 2000) : null,
    paused: raw?.paused === true,
    ended: raw?.ended === true,
    at: now,
  };
}

/**
 * 存一份。写入失败不算错 —— 调用方（HTTP 处理器）只需要"尽力"。
 * @returns {Promise<object|null>} 规范化后的样本
 */
export async function writeBridge(raw, { env = process.env, now = Date.now(), dir = null } = {}) {
  const sample = normalizeBridgeSample(raw, now);
  if (!sample) return null;
  const base = dir ?? cacheDir(env);
  const target = join(base, BRIDGE_FILE);
  try {
    await mkdir(base, { recursive: true });
    const tmp = `${target}.tmp`;
    await writeFile(tmp, JSON.stringify(sample), 'utf8');
    await rename(tmp, target);   // rename 是原子的：读的人要么看到旧值，要么看到新值
  } catch { /* 落不下盘也不影响本次值：HTTP 那边已经拿到了 */ }
  return sample;
}

/**
 * 读最近一次上报，太旧就当作没有。
 * @returns {Promise<{pos:number,dur:number|null,title:string|null,url:string|null,
 *   paused:boolean,ended:boolean,at:number,ageMs:number}|null>}
 */
export async function readBridge({
  env = process.env, now = Date.now(), maxAgeMs = BRIDGE_MAX_AGE_MS, dir = null,
} = {}) {
  if (!bridgeEnabled(env)) return null;
  let raw;
  try {
    raw = JSON.parse(await readFile(join(dir ?? cacheDir(env), BRIDGE_FILE), 'utf8'));
  } catch {
    return null;
  }
  const pos = num(raw?.pos);
  const at = num(raw?.at);
  if (pos === null || pos < 0 || at === null) return null;
  const ageMs = Math.max(0, now - at);
  if (ageMs > maxAgeMs) return null;
  return {
    pos,
    dur: num(raw?.dur),
    title: raw?.title ?? null,
    url: raw?.url ?? null,
    paused: raw?.paused === true,
    ended: raw?.ended === true,
    at,
    ageMs,
  };
}

/** 给 doctor / status 用的一行：不管新不新鲜，都如实说 */
export async function bridgeStatus({ env = process.env, now = Date.now() } = {}) {
  if (!bridgeEnabled(env)) return { enabled: false, fresh: false, ageMs: null, pos: null, title: null };
  try {
    const raw = JSON.parse(await readFile(bridgePath(env), 'utf8'));
    const ageMs = Math.max(0, now - Number(raw?.at ?? 0));
    return {
      enabled: true,
      fresh: Number.isFinite(Number(raw?.pos)) && ageMs <= BRIDGE_MAX_AGE_MS,
      ageMs,
      pos: num(raw?.pos),
      title: raw?.title ?? null,
    };
  } catch {
    return { enabled: true, fresh: false, ageMs: null, pos: null, title: null };
  }
}
