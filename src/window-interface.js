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
    message(entry, env = process.env) {
      return typeof t.message === 'function'
        ? t.message(entry, env)
        : appendWindowEvent({ type: 'message', ...entry }, env);
    },
    meta(text, extra = {}, env = process.env) {
      return typeof t.meta === 'function'
        ? t.meta(text, extra, env)
        : appendWindowEvent({ type: 'meta', text, ...extra }, env);
    },
    control(action, value = null, env = process.env) {
      return typeof t.control === 'function'
        ? t.control(action, value, env)
        : appendWindowEvent({ type: 'control', action, value }, env);
    },
    tts(event, env = process.env) {
      return typeof t.tts === 'function'
        ? t.tts(event, env)
        : appendWindowEvent({ type: 'tts', ...event }, env);
    },
    actions(env = process.env) {
      return typeof t.actions === 'function' ? t.actions(env) : readWindowActions(env);
    },
    accept(action, env = process.env) {
      return typeof t.accept === 'function' ? t.accept(action, env) : appendWindowAction(action, env);
    },
    status() {
      return { alive: Boolean(t.alive()), hidden: Boolean(t.hidden()) };
    },
  });
}
