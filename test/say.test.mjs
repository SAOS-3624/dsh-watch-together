/**
 * say.test.mjs — `watch_together({ say: "…" })` 这条路的入口。
 *
 * `chat.test.mjs` 测的是 `appendAssistantSay` 本身（写一次、广播、空的不写）。
 * 这里补的是**工具参数到那一层之间的接线**：模型说"这句现在就说"，
 * 会不会真的落进流、交给声音、并且**不碰任何陪看状态**。
 *
 * 这条之所以要单独钉住：`say` 是唯一"不读位置、不出图、不推进段"的调用。
 * 如果哪天有人把它挪到主流程后面，它就会变成"说一句话要先抽一次帧"——
 * 界面上还是能看到那句话，只是每次都要等十秒。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readChat } from '../src/chat.js';
import { __resetSpeech, onSpeech } from '../src/voice.js';
import { runWatchAction } from '../src/watch-actions.js';

test('say：立刻写进流 + 交给声音，不进主流程', async () => {
  __resetSpeech();
  const dir = await mkdtemp(join(tmpdir(), 'say-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    const heard = [];
    const off = onSpeech((e) => heard.push(e));

    const r = await runWatchAction({ say: '这段镜头晃得有点意思' }, {
      ctx: null, sessionId: null, browserPort: 1,
    });
    off();

    assert.ok(r, 'say 是单发命令，必须当场返回（返回 null 就会被当成没命中、继续走主流程）');
    assert.deepEqual(JSON.parse(r.text), { ok: true, said: '这段镜头晃得有点意思', inChat: true });
    assert.deepEqual(r.images, [], '不出图');

    const rows = readChat();
    assert.equal(rows.length, 1, `流里应该只有这一条，实得 ${rows.length}`);
    assert.equal(rows[0].role, 'assistant');
    assert.equal(rows[0].text, '这段镜头晃得有点意思');
    assert.equal(rows[0].say, true, '`say: true` 才会被念');

    assert.equal(heard.length, 1, '声音那一侧要收到一次');
    assert.equal(heard[0].text, '这段镜头晃得有点意思');
    assert.equal(heard[0].origin, 'chat', 'origin=chat 表示"已经写进流了"，展示层不再写第二遍');
  } finally {
    delete process.env.DSH_VIDEO_CACHE_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});

test('say 是空白：不命中单发命令，交给主流程', async () => {
  __resetSpeech();
  const dir = await mkdtemp(join(tmpdir(), 'say-empty-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    const r = await runWatchAction({ say: '   ' }, { ctx: null, sessionId: null, browserPort: null });
    assert.equal(r, null, '空白不该被当成"说了一句"');
    assert.equal(readChat().length, 0);
  } finally {
    delete process.env.DSH_VIDEO_CACHE_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});
