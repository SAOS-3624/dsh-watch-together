/**
 * tts-interface.js — the **voice/TTS** side of the plugin.
 *
 * The core never imports an engine. It emits timed speech events; a consumer
 * may speak them, caption them, or ignore them. This adapter freezes the
 * event-bus surface so a host can replace it without touching the watch loop.
 */

export const TTS_INTERFACE_VERSION = 1;

/**
 * @param {{
 *   onSpeech: Function,
 *   emitSpeech: Function,
 *   emitSpoken?: Function,
 *   speechSubscribers: Function,
 *   lastSpeech: Function,
 *   attachConfiguredVoice?: Function,
 *   attachedAdapters?: Function,
 *   configuredVoiceAdapter?: Function,
 * }} bus
 */
export function createTtsInterface(bus = {}) {
  const {
    onSpeech, emitSpeech, emitSpoken, speechSubscribers, lastSpeech,
    attachConfiguredVoice, attachedAdapters, configuredVoiceAdapter,
  } = bus;
  for (const [name, fn] of Object.entries({ onSpeech, emitSpeech, speechSubscribers, lastSpeech })) {
    if (typeof fn !== 'function') throw new TypeError(`tts: ${name}() is required`);
  }
  return Object.freeze({
    kind: 'tts',
    version: TTS_INTERFACE_VERSION,
    subscribe(handler, options) {
      return onSpeech(handler, options);
    },
    due(event) {
      return emitSpeech({ ...event, state: 'due' });
    },
    scheduled(event) {
      return emitSpeech({ ...event, state: 'scheduled' });
    },
    spoken(event) {
      return (emitSpoken ?? emitSpeech)({ ...event, state: 'spoken' });
    },
    skipped(event) {
      return emitSpeech({ ...event, state: 'skipped' });
    },
    subscribers() {
      return speechSubscribers();
    },
    last() {
      return lastSpeech();
    },
    attachConfigured: typeof attachConfiguredVoice === 'function' ? attachConfiguredVoice : null,
    attached: typeof attachedAdapters === 'function' ? attachedAdapters : () => [],
    configured: typeof configuredVoiceAdapter === 'function' ? configuredVoiceAdapter : () => null,
  });
}
