/**
 * interject-reply.test.mjs — 插话的两条硬要求（2026-10-31 晚用户实报）。
 *
 * ① **先说话，再干活**：用户看不见普通回复，只有 `say` 进悬浮窗。模型插话后
 *    "一声不吭先去 zoom" 的观感，就来自这条规则没被说清楚 —— 所以措辞必须带上它，
 *    而且没回的时候要能**追问**（`[未回应]`）。
 *
 * ② **回话和脚本台词不许挤在一起**：两句挨着念，声音引擎串行 → 后一句排队太久
 *    被适配器直接丢掉（连字都不出现）。所以要把那段时间里的词**取走交给模型重写**。
 *
 * 另外钉住换片判据：`dur` 为 null 不能被当成 0 秒（`Number(null) === 0` 这个坑）。
 */
process.env.DSH_WATCH_BRIDGE = '0';
process.env.DSH_WATCH_REQUIRE_LINES = '0';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { interjectNote, replyReminder, __resetInterject } from '../src/interject.js';
import {
  __resetReplyGuard, lastReply, pullLinesNear, pulledLinesNote, noteReply, replyBusyUntil,
} from '../src/reply-guard.js';
import { sourceSwitched } from '../src/watch-loop.js';
import { runWatchPass } from '../src/watch-run.js';
import { saveLines } from '../src/watch.js';

// ---------------------------------------------------------------- ① 先说话再看画面

test('插话的话术：必须点名 `say`，并说清"字先出、画面后到"', () => {
  __resetInterject();
  const t = interjectNote('你看到这个水果了吗', { at: Date.now() });
  assert.match(t, /用户插话/);
  assert.match(t, /你看到这个水果了吗/);
  assert.match(t, /先说话/, '要明说先说话');
  assert.match(t, /say/, '要给出具体参数');
  assert.match(t, /speakNow: true/, '要给出"回了再看一眼"的一次调用写法');
  assert.match(t, /台词优先/, '欠台词时不该因此沉默（lines 和 say 可以同一次给）');
});

test('没回就追问：`[未回应]` 一直挂到真的用 say 回过', () => {
  __resetInterject();
  interjectNote('这段什么意思');
  const r1 = replyReminder({ answered: false });
  assert.match(r1, /未回应/);
  assert.match(r1, /这段什么意思/);

  const r2 = replyReminder({ answered: true });   // 这次调用带了 say
  assert.equal(r2, '', '回过了就别再念叨');
  assert.equal(replyReminder({ answered: false }), '', '回执清掉之后也不该再冒出来');
});

// ---------------------------------------------------------------- ② 回话占住的那段时间

test('回话之后：声音引擎的占用时长按字数算（循环靠它别抢话）', () => {
  __resetReplyGuard();
  assert.equal(replyBusyUntil(), 0, '没说过话时不该占着');
  noteReply('我看一眼', { pos: 100, now: 1000 });
  assert.ok(replyBusyUntil() > 1000, '说完这句话之后引擎是忙的');
  assert.equal(lastReply().pos, 100, '要记住说话时的播放位置');
});

test('把回话后面 12 秒里的脚本台词取走，并交给模型按刚说的重写', async () => {
  __resetReplyGuard();
  const dir = await mkdtemp(join(tmpdir(), 'reply-guard-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    await saveLines('r.mp4', [
      { from: 120, at: 124, text: '这句在窗口里' },
      { from: 120, at: 118, text: '这句已经过去' },
      { from: 120, at: 160, text: '这句离得远' },
      { from: 126, at: 129, text: '下一段开头也挨得近' },
      { from: 180, at: 186, text: '下一段里的' },
    ]);

    const near = await pullLinesNear('r.mp4', { pos: 120, guardSec: 12 });
    const texts = near.pulled.map((x) => x.text);
    assert.deepEqual(texts, ['这句在窗口里', '下一段开头也挨得近'],
      `只该取走区间内的，实得 ${JSON.stringify(texts)}`);

    const note = pulledLinesNote({ ...near, pos: 120 });
    assert.match(note, /太近/);
    assert.match(note, /重写/, '要让它改词，而不是默默删掉');
    assert.match(note, /这句在窗口里/);

    // 没有位置就不许动别人的词（宁可照常念，也不能按错的时间段删台词）
    const none = await pullLinesNear('r.mp4', { pos: null });
    assert.equal(none.pulled.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 换片判据

test('换片判据：`dur: null` 不是"0 秒的片子"', () => {
  assert.equal(sourceSwitched({ dur: null, url: null }, { dur: 600 }), null, '还不知道时长 → 不是换片');
  assert.equal(sourceSwitched({ dur: 600 }, { dur: 601 }), null, '差 1 秒以内不算');
  assert.ok(sourceSwitched({ dur: 600 }, { dur: 900 }), '时长变了就是另一支');
  assert.ok(
    sourceSwitched(
      { url: 'https://www.bilibili.com/video/BV1aa' },
      { url: 'https://www.bilibili.com/video/BV1bb' },
    ),
    '两个视频页互相切换要认出来',
  );
  assert.equal(
    sourceSwitched({ url: 'file:///a.mp4' }, { url: 'devtools://devtools/bundled/x.html' }),
    null,
    '宿主自己的界面不能被当成换片',
  );
});

test('阻塞等待期间换片 → 立刻返回 video-changed，不等到旧片的交付点', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'switch-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    let n = 0;
    const deps = {
      cache: new Map(),
      saveImage: async ({ data }) => data,
      runStoryboard: async () => ({ sheets: [{ png: Buffer.from('x'), cells: [] }] }),
      formatManifest: () => 'm',
      browserPort: 1,
      // 前两次读的是旧片（600 秒），之后换成新片（900 秒）
      readBrowser: async () => {
        n += 1;
        const dur = n <= 2 ? 600 : 900;
        return { pos: 20, dur, paused: false, url: `https://www.bilibili.com/video/BV1n${dur}` };
      },
    };
    const t0 = Date.now();
    const r = await runWatchPass(
      { input: 'a.mp4', cursor: 0, wait: true, maxWaitSec: 30, segment: 120, lead: 15 },
      deps,
    );
    const sec = (Date.now() - t0) / 1000;
    assert.equal(r.reason, 'video-changed');
    assert.equal(r.speaking, false, '换片了就别再交旧片的那一段');
    assert.match(r.text, /video-changed/);
    assert.ok(sec < 15, `不该等满封顶，实得 ${sec}s`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
