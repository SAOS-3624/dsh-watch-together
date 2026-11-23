/**
 * settings/tts-test.js — 「试听」：按面板当前参数真的念一句（ACT.TTS_CN 的"测试"同款）。
 *
 * 走的是**陪看同一条合成链**，优先级和 `examples/voice-edge-tts/index.mjs` 一致：
 *   常驻合成器（stream/daemon.py）→ edge-tts 逐句兜底 → SAPI 系统嗓。
 * 哪一环真的出了声就报哪一环；显式选了 Edge 就不静默退回系统嗓，直接报失败原因 ——
 * 试听要如实，不是"怎么都能响"。
 *
 * 两件让试听"跟手"的事（2026-11-21 用户报「延迟有点高、有时候点了没反应」）：
 *   1. **常驻热合成器**：所有试听共用一个 daemon，参数随请求带（滑块随便拉不重启），
 *      第二次起首声 ~几百毫秒，不再每次冷启动 python + 建连；
 *   2. **新顶旧**：跑着的试听被下一次立刻掐断（AbortSignal + 通道 interrupt），
 *      回执 `reason:'interrupted'` —— 和陪看发声同一个原则：新的直接顶掉旧的。
 *
 * 注意：这里 import 了 `examples/voice-edge-tts/stream/client.mjs`（daemon 的 JSON 行
 * 协议包装）。这不是"核心依赖示例适配器"——核心仍然只发事件（src/voice.js）；
 * 是设置页的试听**故意**复用官方示例的常驻通道，保证"试听听到的"和"陪看听到的"同链。
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { defaultEdgeTtsBin, speak, speakViaEdgeTts, ttsPolicy } from '../../bin/tts.mjs';
import { pythonFor, startStream } from '../../examples/voice-edge-tts/stream/client.mjs';
import { effectiveTtsSettings } from './config.js';

export const TTS_TEST_DEFAULT_TEXT = '这是一句试听文本，听起来怎么样？';
export const TTS_TEST_MAX_TEXT = 200;

const DAEMON = fileURLToPath(new URL('../../examples/voice-edge-tts/stream/daemon.py', import.meta.url));

/* ------------------------------------------------- 常驻热合成器（试听共用） */

let warmStream = null;
let warmStarts = 0;
let idleTimer = null;
let currentRun = null; // 在飞的那一次试听（新顶旧用）
const IDLE_STOP_MS = 3 * 60_000;

/** 试听次数相关的可观测量（回归测试守"复用，不冷启动"用）。 */
export function ttsTestStreamStats() {
  return { starts: warmStarts, warm: !!(warmStream && warmStream.alive) };
}

/** 停掉常驻合成器（设置 API 卸载 / 闲置 / 测试收尾用）。 */
export function stopTtsTestStream() {
  clearTimeout(idleTimer);
  idleTimer = null;
  const stream = warmStream;
  warmStream = null;
  if (stream) {
    try { stream.stop(); } catch { /* 已经退了 */ }
  }
}

function touchIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { stopTtsTestStream(); }, IDLE_STOP_MS);
  if (typeof idleTimer.unref === 'function') idleTimer.unref(); // 别把宿主进程吊住
}

/**
 * 拿（或起）常驻合成器：同一个进程里所有试听共用一个。
 * `start` 是测试接缝（默认真起 daemon.py）；起不来返回 null，调用方退回逐句链。
 */
export function acquireTtsTestStream(env = process.env, start = startStream) {
  if (warmStream && warmStream.alive) {
    touchIdle();
    return warmStream;
  }
  stopTtsTestStream();
  const bin = defaultEdgeTtsBin(env);
  const python = bin ? pythonFor(bin) : null;
  if (!python || !existsSync(DAEMON)) return null;
  warmStarts += 1;
  warmStream = start({
    python,
    script: DAEMON,
    env: { ...process.env, ...env },
    log: () => {},
    onError: () => { warmStream = null; },
  });
  touchIdle();
  return warmStream;
}

/* ------------------------------------------------- 链路选择 */

/**
 * 试听走哪条链。`cfg.engine` 显式选了就不兜底（试听要如实，不是要"怎么都能响"）：
 *   'sapi'   → 只走系统嗓
 *   'edge'   → edge-stream → edge-tts，都失败就报错（**不**静默换系统嗓）
 *   留空（自动）→ 同上，最后多一步 SAPI 兜底，结果里报实际出声的引擎
 */
export function planTtsTest(cfg, env = process.env) {
  const explicit = cfg.engine === 'edge' || cfg.engine === 'sapi';
  const policy = explicit ? cfg.engine : ttsPolicy(env);
  if (policy === 'sapi') return { policy: 'sapi', chain: ['sapi'], explicit };
  const bin = defaultEdgeTtsBin(env);
  const python = bin ? pythonFor(bin) : null;
  const chain = [];
  if (python && existsSync(DAEMON)) chain.push('edge-stream');
  if (bin) chain.push('edge-tts');
  if (!explicit) chain.push('sapi');
  return { policy: 'edge', chain, bin, python, explicit };
}

/* ------------------------------------------------- 执行 */

function interruptedResult(line, ms) {
  return {
    ok: false, engine: 'interrupted',
    reason: 'interrupted', ms, firstMs: null, text: line,
  };
}

/** 让 promise 和 AbortSignal 赛跑；被掐断时顺手 interrupt 通道（停声音）。 */
function raceInterrupt(promise, signal, stream) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    if (signal?.aborted) return done({ ok: false, reason: 'interrupted' });
    signal?.addEventListener('abort', () => {
      try { stream?.interrupt(); } catch { /* 通道挂了就算了 */ }
      done({ ok: false, reason: 'interrupted' });
    }, { once: true });
    promise.then(
      (r) => done(r?.skipped ? { ok: false, reason: 'skipped' } : { ok: true, firstMs: r?.first ?? null }),
      (e) => done({ ok: false, reason: String(e?.message ?? e).slice(0, 160) }),
    );
    return undefined;
  });
}

/** 常驻通道念一句（参数随请求带，合成器不重启）。 */
async function streamOnce({ line, cfg, env, timeoutMs, signal, elapsed }) {
  const stream = acquireTtsTestStream(env);
  if (!stream) return { ok: false, reason: 'stream-unavailable' };
  const params = {
    voice: cfg.voice || undefined,
    rate: Number(cfg.rate) || 0,
    pitch: cfg.pitch || undefined,
    volume: Number.isFinite(Number(cfg.volume)) ? Number(cfg.volume) : 100,
  };
  const startedAt = elapsed();
  const r = await raceInterrupt(
    stream.say(line, { timeoutMs: Math.max(5_000, timeoutMs - 5_000), params }),
    signal,
    stream,
  );
  if (!r.ok) return r;
  // firstMs 要按「发出请求那一刻」起算（elapsed() 念完再取就虚高了）
  return { ok: true, firstMs: r.firstMs === null ? null : startedAt + r.firstMs };
}

/**
 * 试听一句。
 *
 * @param {{ text?: string, tts?: object, env?: object, timeoutMs?: number }} o
 *   `tts` = 面板当前值（不落盘；缺的键沿用已保存的 tts.json）。
 * @returns {Promise<{ok:boolean, engine:string, ms:number, firstMs:number|null, text:string, reason?:string}>}
 *   `engine` 是**实际出声**的链（edge-stream / edge-tts / sapi）；`firstMs` = 首声耗时；
 *   `reason:'interrupted'` = 被下一次试听顶掉了（不算失败）。
 */
export async function runTtsTest({ text, tts, env = process.env, timeoutMs = 60_000 } = {}) {
  const line = String(text ?? '').trim() || TTS_TEST_DEFAULT_TEXT;
  if (line.length > TTS_TEST_MAX_TEXT) throw new Error(`试听文本太长（最多 ${TTS_TEST_MAX_TEXT} 字）`);
  const cfg = effectiveTtsSettings(tts || {}, env);
  const plan = planTtsTest(cfg, env);
  const t0 = Date.now();
  const ms = () => Date.now() - t0;

  // **新顶旧**：有在飞的试听就先掐掉（和陪看发声同一原则，不排队、不叠着响）
  if (currentRun) currentRun.interrupt();
  const controller = new AbortController();
  const run = {
    interrupt() {
      try { controller.abort(); } catch { /* 已经结束 */ }
      try { warmStream?.interrupt(); } catch { /* 通道挂了就算了 */ }
    },
  };
  currentRun = run;

  try {
    const params = {
      voice: cfg.voice || null,
      rate: Number(cfg.rate) || 0,
      pitch: cfg.pitch || null,
      volume: Number.isFinite(Number(cfg.volume)) ? Number(cfg.volume) : 100,
    };
    let reason = '';
    for (const step of plan.chain) {
      if (step === 'edge-stream') {
        const r = await streamOnce({
          line, cfg, env, timeoutMs, signal: controller.signal, elapsed: ms,
        }).catch(() => null);
        if (r?.ok) {
          return {
            ok: true, engine: 'edge-stream',
            ms: ms(), firstMs: r.firstMs ?? ms(), text: line,
          };
        }
        if (r?.reason === 'interrupted') return interruptedResult(line, ms());
        reason = r?.reason || 'stream-failed';
      } else if (step === 'edge-tts') {
        const r = await speakViaEdgeTts(line, {
          ...params, voice: params.voice || undefined, bin: plan.bin, timeoutMs,
          signal: controller.signal,
        }).catch(() => null);
        if (r?.ok) {
          return {
            ok: true, engine: 'edge-tts',
            ms: ms(), firstMs: ms(), text: line,
          };
        }
        if (r?.reason === 'interrupted') return interruptedResult(line, ms());
        reason = r?.reason || 'edge-failed';
      } else {
        const r = await speak(line, {
          ...params, engine: 'sapi', timeoutMs, env, signal: controller.signal,
        }).catch(() => null);
        if (r?.ok) {
          return {
            ok: true, engine: 'sapi',
            ms: ms(), firstMs: ms(), text: line,
          };
        }
        if (r?.reason === 'interrupted') return interruptedResult(line, ms());
        reason = r?.reason || 'sapi-failed';
      }
    }
    return {
      ok: false,
      engine: plan.chain.at(-1) || 'none',
      reason: reason || 'edge-tts-not-installed',
      ms: ms(),
      firstMs: null,
      text: line,
    };
  } finally {
    if (currentRun === run) currentRun = null;
  }
}
