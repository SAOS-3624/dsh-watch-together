/**
 * voice-adapter.js — 按路径挂一个外部声音适配器。**核心不内置任何引擎。**
 *
 * 这一半只做三件事：从配置里读出"装哪个适配器"、dynamic import 它、
 * 把 attach(api) 拿到的 detach 记住。失败一律不抛 —— 声音是可选能力，
 * 装坏了最多没声音，不能让陪看起不来。
 *
 * ```json
 * // ~/.dsh/voice.json
 * { "adapter": "D:/code/my-voice.mjs" }
 * ```
 *
 * 适配器模块导出 `attach(api)`（或 default 导出同名函数），`api` 是
 * `{ onSpeech, speechSubscribers, emitSpeech, emitSpoken, lastSpeech }` ——
 * 合成完真的要出声时调一次 `emitSpoken(e)`，展示层才知道"字可以出现了"（见 `speech-bus.js`）。
 * `attach` 可以返回一个 detach 函数；不返回也行，但要自己管好退订。
 *
 * 和 `speech-bus.js` 的分工：总线不认识"文件路径""import""配置文件"，
 * 这里不认识"事件长什么样"。本机自用的实现在 `examples/voice-edge-tts/`。
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  emitSpeech, emitSpoken, lastSpeech, onSpeech, speechSubscribers,
} from './speech-bus.js';

/**
 * 已挂载的适配器：specifier → { detach, subscriptions }。
 *
 * subscriptions 是这个适配器通过 `onSpeech` 建立的订阅。适配器自己返回 detach 也好，
 * 没返回也好，卸载时都必须清掉；否则 `speechSubscribers()` 会一直 > 0，
 * 循环以为"有人会念"，从此不再叫醒模型 —— 用户看到的现象就是陪看默默变哑巴。
 *
 * @type {Map<string, {detach: Function|null, subscriptions: Set<Function>}>}
 */
const attached = new Map();

/** 正在挂载中的 specifier → Promise，避免并发重复 attach。 */
const pending = new Map();

/**
 * 读 `~/.dsh/voice.json` 里的 `adapter`，或者环境变量 `DSH_VOICE_ADAPTER`。
 *
 * **只读"装哪个适配器"这一个字段**，音色、语速、引擎路径都是适配器自己的事 ——
 * 这就是"核心不读 TTS 配置"的具体含义。
 */
export function configuredVoiceAdapter(env = process.env) {
  const fromEnv = String(env.DSH_VOICE_ADAPTER ?? '').trim();
  if (fromEnv) return fromEnv;
  const home = env.DSH_HOME || join(env.USERPROFILE || env.HOME || homedir(), '.dsh');
  try {
    const cfg = JSON.parse(readFileSync(join(home, 'voice.json'), 'utf8'));
    const spec = String(cfg?.adapter ?? '').trim();
    if (spec) return spec;
  } catch { /* 没配就算了：这是可选能力 */ }
  return null;
}

/** `D:/code/x.mjs`、`./x.mjs`、`/opt/x.mjs` 当路径；`my-voice-adapter` 当包名 */
function toImportSpecifier(spec) {
  const s = String(spec).trim();
  if (/^([a-zA-Z]:[\\/]|\\\\|\/|\.{1,2}[\\/])/.test(s)) {
    return pathToFileURL(s).href;
  }
  return s;
}

/** 在 attach 期间给 onSpeech 加一层记录，失败时才能精确回滚。 */
function trackedApi(api, subscriptions) {
  return {
    ...api,
    onSpeech(handler, options) {
      const off = onSpeech(handler, options);
      let active = true;
      const trackedOff = () => {
        if (!active) return false;
        active = false;
        subscriptions.delete(trackedOff);
        return off();
      };
      subscriptions.add(trackedOff);
      return trackedOff;
    },
  };
}

/**
 * 挂载一个外部适配器。**核心只做 dynamic import，不内置任何引擎**。
 *
 * @param {string} spec 模块名或文件路径
 * @param {{ log?: (msg:string)=>void }} [o]
 * @returns {Promise<{ok:boolean, reason?:string, cached?:boolean, name?:string}>}
 */
export async function loadVoiceAdapter(spec, { log = () => {} } = {}) {
  const raw = String(spec ?? '').trim();
  if (!raw) return { ok: false, reason: 'empty-specifier' };
  if (attached.has(raw)) return { ok: true, cached: true, name: raw };
  if (pending.has(raw)) return pending.get(raw);

  const work = (async () => {
    let mod = null;
    try {
      mod = await import(toImportSpecifier(raw));
    } catch (e) {
      const reason = `import failed: ${String(e?.message ?? e).slice(0, 200)}`;
      log(`[voice] ${raw}: ${reason}`);
      return { ok: false, reason };
    }

    const attach = mod?.attach ?? mod?.default;
    if (typeof attach !== 'function') {
      const reason = 'module does not export attach(api) (or a default function)';
      log(`[voice] ${raw}: ${reason}`);
      return { ok: false, reason };
    }

    const subscriptions = new Set();
    try {
      const detach = await attach(trackedApi({
        onSpeech, speechSubscribers, emitSpeech, emitSpoken, lastSpeech,
      }, subscriptions));
      attached.set(raw, {
        detach: typeof detach === 'function' ? detach : null,
        subscriptions,
      });
      // 模块没有自报名字时用路径末段 —— `attach.name` 永远是 "attach"，没有信息量
      const name = String(mod?.adapterName ?? raw).split(/[\\/]/).filter(Boolean).pop() || raw;
      log(`[voice] adapter attached: ${name}`);
      return { ok: true, name };
    } catch (e) {
      // attach 可能已经订阅后才抛（例如引擎探测中途炸掉）。只返回失败还不够：
      // 那些订阅还挂在总线上，循环会误以为有人会念。这里精确退订，不碰其他订阅者。
      for (const off of [...subscriptions]) {
        try { off(); } catch { /* 退订本身失败也要继续清 */ }
      }
      const reason = `attach failed: ${String(e?.message ?? e).slice(0, 200)}`;
      log(`[voice] ${raw}: ${reason}`);
      return { ok: false, reason };
    }
  })();

  pending.set(raw, work);
  try {
    return await work;
  } finally {
    pending.delete(raw);
  }
}

/** 按配置挂载（没配就是 no-op）。**这是核心唯一碰声音的地方**。 */
export async function attachConfiguredVoice({ env = process.env, log = () => {} } = {}) {
  const spec = configuredVoiceAdapter(env);
  if (!spec) return { ok: false, reason: 'not-configured' };
  return loadVoiceAdapter(spec, { log });
}

/** 已挂载的适配器列表（`statusOnly` 和排查用） */
export function attachedAdapters() {
  return [...attached.keys()];
}

/**
 * 全部卸载（测试/热重载用）。
 *
 * **只卸载适配器自己的订阅**，不调用 `__resetSpeech()`：聊天框、日志订阅者
 * 可能还活着，一次热重载不该让它们一起消失。适配器如果自己留了 detach，先调它，
 * 再清掉 attach 期间记录到的剩余订阅（防止适配器只订阅、不返回 detach）。
 */
export async function detachAdapters() {
  for (const [, entry] of attached) {
    try { await entry.detach?.(); } catch { /* 卸不掉也继续 */ }
    for (const off of [...entry.subscriptions]) {
      try { off(); } catch { /* 已经退订 */ }
    }
  }
  attached.clear();
}
