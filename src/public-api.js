/**
 * public-api.js — importable surface for companion plugins, tests and tools.
 * The DSH plugin entry point remains src/index.js.
 */

export {
  INTERFACE_VERSION,
  createWatchInterfaces,
} from './interfaces.js';
export { createRecognitionInterface } from './recognition-interface.js';
export { createTtsInterface } from './tts-interface.js';
export { createWindowInterface } from './window-interface.js';
export {
  WINDOW_PROTOCOL_VERSION,
  WINDOW_EVENT_TYPES,
  WINDOW_ACTION_TYPES,
  windowEventFile,
  windowOutboxFile,
  normalizeWindowEvent,
  appendWindowEvent,
  readWindowEvents,
  appendWindowAction,
  readWindowActions,
} from './window-protocol.js';
