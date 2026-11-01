/**
 * window-interface.js — the plugin-facing floating-window contract.
 *
 * A window implementation can be the bundled Python process, a future web
 * window, or a test double. The watch plugin only calls this object:
 *
 *   open() / hide() / show() / alive() / hidden()
 *   message(entry) / meta(text) / control(action, value) / tts(event)
 *
 * Messages are written to the protocol file; process/config details stay in
 * the transport, not in the watch loop.
 */

import {
  appendWindowAction, appendWindowEvent, readWindowActions,
} from './window-protocol.js';
import {
  floatingWindowAlive, floatingWindowHidden, openFloatingWindow, setWindowHidden,
} from './floating-window.js';

export const WINDOW_INTERFACE_VERSION = 1;

export function createWindowInterface({ transport = null } = {}) {
  const t = transport ?? {
    open(options = {}) {
      return openFloatingWindow(options);
    },
    hide() {
      return setWindowHidden(true);
    },
    show() {
      return setWindowHidden(false);
    },
    alive() {
      return floatingWindowAlive();
    },
    hidden() {
      return floatingWindowHidden();
    },
  };
  return Object.freeze({
    kind: 'window',
    version: WINDOW_INTERFACE_VERSION,
    open(options) {
      return t.open(options);
    },
    hide() {
      return t.hide();
    },
    show() {
      return t.show();
    },
    alive() {
      return t.alive();
    },
    hidden() {
      return t.hidden();
    },
    message(entry) {
      return appendWindowEvent({ type: 'message', ...entry });
    },
    meta(text, extra = {}) {
      return appendWindowEvent({ type: 'meta', text, ...extra });
    },
    control(action, value = null) {
      return appendWindowEvent({ type: 'control', action, value });
    },
    tts(event) {
      return appendWindowEvent({ type: 'tts', ...event });
    },
    actions(env = process.env) {
      return readWindowActions(env);
    },
    accept(action, env = process.env) {
      return appendWindowAction(action, env);
    },
    status() {
      return { alive: Boolean(t.alive()), hidden: Boolean(t.hidden()) };
    },
  });
}
