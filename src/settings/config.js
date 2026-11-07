/**
 * settings/config.js — 陪看设置页读写的小 JSON。
 *
 * 复用已有约定：
 *   ~/.dsh/video.json  { browserPort, launchBrowser }   （与分镜插件共享）
 *   ~/.dsh/voice.json  { adapter }                       （voice-adapter.js 已读）
 *   ~/.dsh/watch.json  { chatPort }                       （本页新增，chat-server 读取）
 *   ~/.dsh/watch-window.json { glass, geometry, name, … } （悬浮窗自己读写；本页只碰 glass）
 *
 * 这里不 import chat-server，避免 chat-server -> settings -> chat-server 的环。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_CHAT_PORT = 9377;

/**
 * 悬浮窗样式预设。
 *
 * `auto` 不落盘（写进去等于删掉 `glass` 键）：窗口自己会按环境判断 ——
 * 远程桌面/录屏用 solid（WDA 会让整窗在对面消失），其余用 live。
 *
 * 三个具体的档位：
 *   live   实时玻璃，抓屏 + 模糊，最好看也最吃 CPU
 *   frost  静态磨砂，一张预生成的底板，不抓屏（低配机/高分屏选这个）
 *   solid  纯色底板，最省
 */
export const WINDOW_STYLES = Object.freeze(['auto', 'live', 'frost', 'solid']);
const MAX_TEXT = 300;

export function dshHome(env = process.env) {
  return env.DSH_HOME || join(env.USERPROFILE || env.HOME || homedir(), '.dsh');
}

export function videoConfigPath(env = process.env) { return join(dshHome(env), 'video.json'); }
export function voiceConfigPath(env = process.env) { return join(dshHome(env), 'voice.json'); }
export function watchConfigPath(env = process.env) { return join(dshHome(env), 'watch.json'); }
/** 悬浮窗自己的配置（窗口进程也往这里写 geometry/name）；本页只改 `glass`。 */
export function windowConfigPath(env = process.env) { return join(dshHome(env), 'watch-window.json'); }

function readObject(path) {
  if (!existsSync(path)) return { data: {}, error: null, exists: false };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { data: {}, error: '配置文件不是 JSON 对象', exists: true };
    }
    return { data: raw, error: null, exists: true };
  } catch (e) {
    return { data: {}, error: 'JSON 解析失败：' + String(e?.message ?? e), exists: true };
  }
}

function writeObject(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.' + process.pid + '.tmp';
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, path);
  } finally {
    if (existsSync(tmp)) rmSync(tmp, { force: true });
  }
}

function port(value, field) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(field + ' 必须是 1-65535 的整数');
  return n;
}

export function readWatchSettings(env = process.env) {
  const path = watchConfigPath(env);
  const raw = readObject(path);
  let chatPort = DEFAULT_CHAT_PORT;
  if (raw.data.chatPort !== undefined) {
    const n = Number(raw.data.chatPort);
    if (Number.isInteger(n) && n > 0 && n <= 65535) chatPort = n;
  }
  return { path, exists: raw.exists, error: raw.error, chatPort };
}

export function configuredChatPort(env = process.env) {
  return readWatchSettings(env).chatPort;
}

export function writeWatchSettings(patch = {}, env = process.env) {
  const path = watchConfigPath(env);
  const { data } = readObject(path);
  const next = { ...data };
  if (patch.chatPort !== undefined) next.chatPort = port(patch.chatPort, 'chatPort');
  writeObject(path, next);
  return readWatchSettings(env);
}

/**
 * 悬浮窗样式（`watch-window.json` 的 `glass`）。
 *
 * 为什么写这个文件而不是 `watch.json`：窗口进程每 250ms 只看 `watch-window.json`
 * 的 mtime，改这里才能**当场换过来**；写成别的文件要等下次开窗。
 * 这个文件窗口自己也写（geometry / name / hidden），所以只能读-改-写，不能覆盖。
 */
export function readWindowSettings(env = process.env) {
  const path = windowConfigPath(env);
  const raw = readObject(path);
  const value = typeof raw.data.glass === 'string' ? raw.data.glass.trim().toLowerCase() : '';
  // `hidden` 是老键，`mode` 是新键：两个都要认（窗口自己也是这么读的）
  const hidden = raw.data.hidden === true || raw.data.mode === 'hidden';
  return {
    path,
    exists: raw.exists,
    error: raw.error,
    style: WINDOW_STYLES.includes(value) ? value : 'auto',
    mode: hidden ? 'hidden' : 'full',
    danmaku: raw.data.danmaku === true,
  };
}

export function writeWindowSettings(patch = {}, env = process.env) {
  const path = windowConfigPath(env);
  const { data } = readObject(path);
  const next = { ...data };
  if (patch.style !== undefined) {
    const style = String(patch.style ?? '').trim().toLowerCase();
    if (!WINDOW_STYLES.includes(style)) {
      throw new Error('style 必须是 auto / live / frost / solid');
    }
    // `auto` 不落盘：窗口把"没有 glass 键"理解成自动，写个 auto 进去反而看不懂
    if (style === 'auto') delete next.glass;
    else next.glass = style;
  }
  if (patch.mode !== undefined) {
    const mode = String(patch.mode ?? '').trim().toLowerCase();
    if (mode !== 'full' && mode !== 'hidden') {
      throw new Error('mode 必须是 full / hidden');
    }
    // 两个键永远一起写：老版本窗口只认 `hidden`，降级后还得能看懂
    if (mode === 'hidden') {
      next.mode = 'hidden';
      next.hidden = true;
    } else {
      delete next.mode;
      next.hidden = false;
    }
  }
  if (patch.danmaku !== undefined) next.danmaku = Boolean(patch.danmaku);
  writeObject(path, next);
  return readWindowSettings(env);
}

export function readVideoSettings(env = process.env) {
  const path = videoConfigPath(env);
  const raw = readObject(path);
  const n = Number(raw.data.browserPort);
  return {
    path,
    exists: raw.exists,
    error: raw.error,
    browserPort: Number.isFinite(n) && n > 0 ? n : null,
    launchBrowser: raw.data.launchBrowser === true,
  };
}

export function writeVideoSettings(patch = {}, env = process.env) {
  const path = videoConfigPath(env);
  const { data } = readObject(path);
  const next = { ...data };
  if (patch.browserPort !== undefined) {
    if (patch.browserPort === false || patch.browserPort === 0 || patch.browserPort === null || patch.browserPort === '') {
      next.browserPort = false;
    } else {
      next.browserPort = port(patch.browserPort, 'browserPort');
    }
  }
  if (patch.launchBrowser !== undefined) {
    if (typeof patch.launchBrowser !== 'boolean') throw new Error('launchBrowser 必须是布尔值');
    next.launchBrowser = patch.launchBrowser;
  }
  writeObject(path, next);
  return readVideoSettings(env);
}

export function readVoiceSettings(env = process.env) {
  const path = voiceConfigPath(env);
  const raw = readObject(path);
  return {
    path,
    exists: raw.exists,
    error: raw.error,
    adapter: typeof raw.data.adapter === 'string' ? raw.data.adapter : '',
    envOverrides: ['DSH_VOICE_ADAPTER']
      .filter((k) => env[k] !== undefined && env[k] !== ''),
  };
}

export function writeVoiceSettings(patch = {}, env = process.env) {
  const path = voiceConfigPath(env);
  const { data } = readObject(path);
  const next = { ...data };
  if (patch.adapter !== undefined) {
    if (typeof patch.adapter !== 'string') throw new Error('adapter 必须是字符串');
    const adapter = patch.adapter.trim();
    if (adapter.length > MAX_TEXT) throw new Error('adapter 太长');
    if (adapter) next.adapter = adapter;
    else delete next.adapter;
  }
  writeObject(path, next);
  return readVoiceSettings(env);
}

export function configPaths(env = process.env) {
  return {
    home: dshHome(env),
    video: videoConfigPath(env),
    voice: voiceConfigPath(env),
    watch: watchConfigPath(env),
    window: windowConfigPath(env),
  };
}
