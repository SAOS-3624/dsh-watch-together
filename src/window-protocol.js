/**
 * window-protocol.js — the wire between the plugin and any floating window.
 *
 * The plugin writes **window-events.jsonl**; a window process reads it. The
 * window may write **window-outbox.jsonl** for user actions. This is the only
 * place that knows the on-disk schema. The window does not import Node, and
 * the plugin does not import Python.
 *
 * Message events intentionally carry the same role/text/at fields as chat.jsonl
 * so existing renderers can consume them unchanged. The window may read both
 * files during the migration; duplicate events are harmless because the
 * renderer de-duplicates by (role, text, at).
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { cacheDir } from 'dsh-video-storyboard/cache';

export const WINDOW_PROTOCOL_VERSION = 1;
export const WINDOW_EVENT_FILE = 'window-events.jsonl';
export const WINDOW_OUTBOX_FILE = 'window-outbox.jsonl';

export const WINDOW_EVENT_TYPES = Object.freeze([
  'message', 'meta', 'control', 'tts', 'ping',
]);
export const WINDOW_ACTION_TYPES = Object.freeze([
  'say', 'close', 'hide', 'show', 'rename', 'collapse', 'expand',
]);

export function windowEventFile(env = process.env) {
  return join(cacheDir(env), WINDOW_EVENT_FILE);
}

export function windowOutboxFile(env = process.env) {
  return join(cacheDir(env), WINDOW_OUTBOX_FILE);
}

function readJsonLines(file) {
  try {
    return readFileSync(file, 'utf8').split('\n').filter((line) => line.trim())
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch { return []; }
}

function appendJsonLine(file, value) {
  try {
    mkdirSync(dirname(file), { recursive: true });
  } catch { /* directory already exists */ }
  appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8');
  return value;
}

/** Validate/normalize an event. Unknown event types are dropped, not thrown. */
export function normalizeWindowEvent(event = {}) {
  const type = WINDOW_EVENT_TYPES.includes(event.type) ? event.type : null;
  if (!type) return null;
  const out = {
    v: WINDOW_PROTOCOL_VERSION,
    type,
    at: Number.isFinite(Number(event.at)) ? Number(event.at) : Date.now(),
  };
  if (type === 'message' || type === 'meta') {
    const role = String(event.role ?? (type === 'meta' ? 'meta' : 'assistant'));
    const text = String(event.text ?? '').slice(0, 4000);
    if (!text) return null;
    return {
      ...out, role, text,
      ...(Number.isFinite(Number(event.t)) ? { t: +Number(event.t).toFixed(2) } : {}),
    };
  }
  if (type === 'control') {
    const action = String(event.action ?? '').trim();
    if (!action) return null;
    return { ...out, action, value: event.value ?? null };
  }
  if (type === 'tts') {
    const text = String(event.text ?? '').slice(0, 4000);
    if (!text) return null;
    return { ...out, state: String(event.state ?? 'due'), text };
  }
  return out;
}

/** Append a plugin → window event. Returns the normalized event (or null). */
export function appendWindowEvent(event, env = process.env) {
  const normalized = normalizeWindowEvent(event);
  if (!normalized) return null;
  appendJsonLine(windowEventFile(env), normalized);
  return normalized;
}

/** Read plugin → window events (tests/diagnostics). */
export function readWindowEvents(env = process.env) {
  return readJsonLines(windowEventFile(env));
}

/** Append a user → plugin action from a window process. */
export function appendWindowAction(action, env = process.env) {
  const type = String(action?.type ?? '').trim();
  if (!WINDOW_ACTION_TYPES.includes(type)) return null;
  const out = {
    v: WINDOW_PROTOCOL_VERSION,
    type,
    at: Number.isFinite(Number(action.at)) ? Number(action.at) : Date.now(),
  };
  if (type === 'say') {
    const text = String(action.text ?? '').trim().slice(0, 500);
    if (!text) return null;
    out.text = text;
  }
  if (action.value !== undefined) out.value = action.value;
  return appendJsonLine(windowOutboxFile(env), out);
}

/** Read user → plugin actions (polled by the window service). */
export function readWindowActions(env = process.env) {
  return readJsonLines(windowOutboxFile(env));
}
