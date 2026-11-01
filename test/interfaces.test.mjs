import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRecognitionInterface } from '../src/recognition-interface.js';
import { createTtsInterface } from '../src/tts-interface.js';
import { createWindowInterface } from '../src/window-interface.js';
import {
  appendWindowEvent, appendWindowAction, readWindowEvents, readWindowActions,
  windowEventFile, windowOutboxFile,
} from '../src/window-protocol.js';
import { appendChat } from '../src/chat-store.js';

test('recognition interface only exposes segment/manifest/cues', async () => {
  const calls = [];
  const r = createRecognitionInterface({
    runStoryboard: async (args) => { calls.push(['segment', args]); return { ok: 1 }; },
    formatManifest: (result, options) => { calls.push(['manifest', result, options]); return 'M'; },
    cues: (input) => { calls.push(['cues', input]); return [{ text: 'hi', at: 1 }]; },
  });
  assert.deepEqual(await r.segment({ input: 'a.mp4' }), { ok: 1 });
  assert.equal(r.manifest({ ok: 1 }, { maxChars: 10 }), 'M');
  assert.deepEqual(r.cues('a.mp4'), [{ text: 'hi', at: 1 }]);
  assert.deepEqual(calls.map((c) => c[0]), ['segment', 'manifest', 'cues']);
  assert.throws(() => createRecognitionInterface({}), /runStoryboard/);
});

test('tts interface is a frozen event-bus surface', () => {
  const events = [];
  const bus = {
    onSpeech: (fn) => { events.push(['subscribe']); return () => events.push(['off']); },
    emitSpeech: (e) => { events.push(['emit', e]); return { seq: 1 }; },
    emitSpoken: (e) => { events.push(['spoken', e]); return true; },
    speechSubscribers: () => 2,
    lastSpeech: () => ({ text: 'last' }),
  };
  const t = createTtsInterface(bus);
  t.due({ text: 'a', at: 3 });
  t.spoken({ text: 'a', at: 3 });
  assert.equal(t.subscribers(), 2);
  assert.deepEqual(t.last(), { text: 'last' });
  assert.deepEqual(events.map((e) => e[0]), ['emit', 'spoken']);
  assert.throws(() => createTtsInterface({}), /onSpeech/);
});

test('window protocol writes/reads typed messages and actions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'win-proto-'));
  try {
    const env = { ...process.env, DSH_VIDEO_CACHE_DIR: dir };
    const m = appendWindowEvent({ type: 'message', role: 'assistant', text: 'hello', at: 10 }, env);
    assert.equal(m.text, 'hello');
    appendWindowEvent({ type: 'meta', text: 'meta line', at: 11 }, env);
    appendWindowAction({ type: 'say', text: 'user line', at: 12 }, env);
    appendWindowAction({ type: 'rename', value: '新名字', at: 13 }, env);

    assert.equal(windowEventFile(env), join(dir, 'window-events.jsonl'));
    assert.equal(windowOutboxFile(env), join(dir, 'window-outbox.jsonl'));
    const events = readWindowEvents(env);
    assert.equal(events.length, 2);
    assert.equal(events[0].role, 'assistant');
    assert.equal(events[1].type, 'meta');
    const actions = readWindowActions(env);
    assert.equal(actions.length, 2);
    assert.equal(actions[0].type, 'say');
    assert.equal(actions[1].value, '新名字');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('window interface uses the transport, not a hard-coded process', async () => {
  const seen = [];
  const w = createWindowInterface({
    transport: {
      open: (o) => { seen.push(['open', o]); return { ok: true }; },
      hide: () => { seen.push(['hide']); return true; },
      show: () => { seen.push(['show']); return true; },
      alive: () => true,
      hidden: () => false,
    },
  });
  assert.deepEqual(w.open({ force: true }), { ok: true });
  assert.equal(w.hide(), true);
  assert.deepEqual(w.status(), { alive: true, hidden: false });
  assert.deepEqual(seen.map((s) => s[0]), ['open', 'hide']);
});

test('chat-store mirrors entries into the window protocol', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'win-chat-'));
  try {
    const env = { ...process.env, DSH_VIDEO_CACHE_DIR: dir };
    appendChat('assistant', 'mirrored', { t: 42 }, env);
    const events = readWindowEvents(env);
    assert.equal(events.length, 1);
    assert.equal(events[0].role, 'assistant');
    assert.equal(events[0].text, 'mirrored');
    assert.equal(events[0].t, 42);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
