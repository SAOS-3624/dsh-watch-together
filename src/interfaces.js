/**
 * interfaces.js — the plugin's public seams.
 *
 * The watch loop should be able to run with:
 *   - any recognition provider (storyboard / ASR / a test double),
 *   - any TTS bus (companion voice plugin / local adapter / none),
 *   - any floating-window transport (bundled Python / web / test double).
 *
 * These objects are the only things that cross those seams. Keep them small
 * and versioned; adapters live in their own files.
 */

import { appendChat, readChat } from './chat-store.js';
import { createRecognitionInterface } from './recognition-interface.js';
import { createTtsInterface } from './tts-interface.js';
import { createWindowInterface } from './window-interface.js';
import * as speechBus from './speech-bus.js';
import * as voiceAdapter from './voice-adapter.js';
import { runStoryboard } from 'dsh-video-storyboard/pipeline';
import { formatManifest } from 'dsh-video-storyboard/format';
import { cachedCues } from './lines-util.js';
import { installPorts } from './runtime-ports.js';

export const INTERFACE_VERSION = '1.0.0';

export function createWatchInterfaces(overrides = {}) {
  const recognition = overrides.recognition ?? createRecognitionInterface({
    runStoryboard,
    formatManifest,
    cues: cachedCues,
  });
  const tts = overrides.tts ?? createTtsInterface({ ...speechBus, ...voiceAdapter });
  const window = overrides.window ?? createWindowInterface();
  const chat = overrides.chat ?? Object.freeze({
    append: appendChat,
    read: readChat,
  });
  const api = Object.freeze({
    version: INTERFACE_VERSION,
    recognition,
    tts,
    window,
    chat,
  });
  // 组合根：把这一组接口装进运行时端口，chat-store / watch-loop 等核心模块
  // 只从这里取 TTS / 窗口，不再 import 具体实现。
  installPorts(api);
  return api;
}
