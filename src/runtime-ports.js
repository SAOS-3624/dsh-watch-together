/**
 * runtime-ports.js — the only place core modules get their TTS/window adapters.
 *
 * Core modules (chat-store, watch-loop, watch-actions, input-surface) never import
 * voice.js / floating-window.js / window-protocol.js directly. They ask for a port;
 * this module is the composition root that supplies the default adapter pair and
 * lets the host install injected interfaces with installPorts().
 *
 * A bare import of this module still gets the historical default (speech bus +
 * bundled floating window), so CLI use and the existing tests keep working.
 */

import { createTtsInterface } from './tts-interface.js';
import { createWindowInterface } from './window-interface.js';
import * as speechBus from './speech-bus.js';
import * as voiceAdapter from './voice-adapter.js';

let installed = { tts: null, window: null };

/** Default TTS adapter = event bus + the optional external-adapter loader. */
function defaultTts() {
  return createTtsInterface({ ...speechBus, ...voiceAdapter });
}

/** Install host-provided interfaces. Missing sides keep their previous/default adapter. */
export function installPorts({ tts = null, window = null } = {}) {
  if (tts) installed.tts = tts;
  if (window) installed.window = window;
  return { ...installed };
}

/** Drop injected interfaces (tests / host teardown). */
export function resetPorts() {
  installed = { tts: null, window: null };
}

export function getTtsPort() {
  if (!installed.tts) installed.tts = defaultTts();
  return installed.tts;
}

export function getWindowPort() {
  if (!installed.window) installed.window = createWindowInterface();
  return installed.window;
}
