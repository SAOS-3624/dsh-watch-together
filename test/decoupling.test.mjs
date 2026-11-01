import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendChat, appendSpoken } from '../src/chat-store.js';
import { getTtsPort, installPorts, resetPorts } from '../src/runtime-ports.js';

test('chat and speech use the installed ports, not the bundled implementations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ports-chat-'));
  const seen = [];
  const env = { ...process.env, DSH_VIDEO_CACHE_DIR: dir };
  const window = {
    message(entry, gotEnv) { seen.push(['message', entry.text, gotEnv]); },
    meta(text, extra, gotEnv) { seen.push(['meta', text, gotEnv]); },
  };
  const tts = {
    due(event) { seen.push(['due', event.text, event.origin]); },
  };
  installPorts({ window, tts });
  try {
    appendChat('assistant', 'hello', { t: 3 }, env);
    appendSpoken('assistant', 'spoken', { t: 4, env });
    assert.deepEqual(seen.filter((x) => x[0] === 'message').map((x) => x[1]), ['hello', 'spoken']);
    assert.deepEqual(seen.find((x) => x[0] === 'due'), ['due', 'spoken', 'chat']);
    assert.equal(seen[0][2], env);
  } finally {
    resetPorts();
    await rm(dir, { recursive: true, force: true });
  }
});

test('the default tts port still exposes the adapter loader', () => {
  resetPorts();
  const tts = getTtsPort();
  assert.equal(typeof tts.attachConfigured, 'function');
  assert.equal(typeof tts.configured, 'function');
  assert.equal(typeof tts.attached, 'function');
});
