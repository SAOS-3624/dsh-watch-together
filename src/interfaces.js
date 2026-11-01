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
import { runStoryboard } from 'dsh-video-storyboard/pipeline';
import { formatManifest } from 'dsh-video-storyboard/format';
import { cachedCues } from './lines-util.js';

export const INTERFACE_VERSION = '1.0.0';

export function createWatchInterfaces(overrides = {}) {
  const recognition = overrides.recognition ?? createRecognitionInterface({
    runStoryboard,
    formatManifest,
    cues: cachedCues,
  });
  const tts = overrides.tts ?? createTtsInterface(speechBus);
  const window = overrides.window ?? createWindowInterface();
  const chat = overrides.chat ?? Object.freeze({
    append: appendChat,
    read: readChat,
  });
  return Object.freeze({
    version: INTERFACE_VERSION,
    recognition,
    tts,
    window,
    chat,
  });
}
