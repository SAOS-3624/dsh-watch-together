/**
 * transcript-track.test.mjs — 字幕轨 + 两段式投喂。
 *
 * 用户的诉求是"字幕先到就先给我词，别等图"。这条链有三处最容易做错，
 * 每一处都对应下面的一组用例：
 *
 *   1. **两轨必须共用同一个窗口**：各自算余量就会出现"它说 04:00 开始、实际建的是 03:00 那段"。
 *   2. **喂过的段不能再喂**，且喂过之后建图那次必须 `omitTranscript`（否则同一批台词发两遍，token +50%）。
 *   3. **拿不到词的时候不能标记成"喂过"** —— 否则那一段就永远没词了。
 */
process.env.DSH_WATCH_REQUIRE_LINES = '0';

import test from 'node:test';
import assert from 'node:assert/strict';

import { makePlan, windowFor } from '../src/batches.js';
import {
  isFedSegment, loopStatus, startWatchLoop, stopWatchLoop,
} from '../src/watch-loop.js';

const ctxStub = { sessionController: { prompt: async () => {} } };

/** 起一个用假钟驱动的循环；返回 { tick, woke, transcribed, feeds } */
async function boot(opts = {}) {
  let nowMs = 1_000_000;
  let tickFn = null;
  const ticker = (o) => { tickFn = o.tick; return { dispose() {} }; };
  const woke = [];
  const transcribed = [];
  const feeds = [];

  const r = startWatchLoop({
    ctx: ctxStub,
    sessionId: opts.sessionId ?? 's-tt',
    input: opts.input ?? 'tt.mp4',
    segment: 60,
    ramp: [],
    lookahead: 300,
    cursor: 10,
    browserPort: 1,
    wake: true,
    transcriptTrack: opts.transcriptTrack,
    feedTranscriptLeadMs: opts.feedTranscriptLeadMs,
    deps: {
      now: () => nowMs,
      ticker,
      // 位置随假钟推进（1:1），这样"余量窗口"会真的往前滚
      readBrowser: async () => ({ pos: 10 + (nowMs - 1_000_000) / 1000, dur: 3600, paused: false }),
      wake: async (c, o) => { woke.push(o); return { ok: true }; },
      probeEveryMs: 0,
      loadLatency: async () => null,
      transcribe: opts.transcribe === undefined
        ? async (from, to) => { transcribed.push({ from, to }); return { ok: true, source: 'asr', segments: [{ from, to, text: 'x' }] }; }
        : opts.transcribe,
      feedTranscript: opts.feedTranscript === undefined
        ? async (from, to) => { feeds.push({ from, to }); return { ok: true, source: 'asr', lines: 3, text: `[一起来看·台词] ${from}` }; }
        : opts.feedTranscript,
    },
  });
  assert.equal(r.ok, true, `循环起不来：${r.reason ?? ''}`);
  return {
    tick: () => tickFn(),
    advance: (ms) => { nowMs += ms; },
    woke, transcribed, feeds,
    stop: () => stopWatchLoop('test'),
  };
}

test('字幕轨和画面轨用同一个余量窗口（不各算一套常量）', async () => {
  const h = await boot();
  try {
    await h.tick();          // 第一拍建 anchor 并起两条轨
    await new Promise((r) => setTimeout(r, 30));

    const st = loopStatus();
    // 余量 300s / 段长 60s → 窗口 5 段（含当前段）
    assert.equal(st.bufferSec, 300, '余量口径来自 batches.makePlan，不该被改');
    assert.ok(h.transcribed.length >= 1, '字幕轨应该开工');

    // 字幕轨要的段都落在画面轨同一个窗口里（从当前位置起 300 秒内）
    const plan = makePlan({ segment: 60, ramp: [] });
    const win = windowFor(plan, 10, 300);
    const allowed = new Set(win.map((s) => s.from));
    for (const t of h.transcribed) {
      assert.ok(allowed.has(t.from), `字幕轨跑出窗口了：${t.from}（窗口 ${[...allowed].join(',')}）`);
      assert.equal(t.to - t.from, 60, '段长要和画面轨一致');
    }
  } finally {
    h.stop();
  }
});

test('跑到窗口边界自己停（find 返回 undefined，不需要额外判断）', async () => {
  const h = await boot();
  try {
    // 位置不动（假钟不走），先把窗口排满
    for (let i = 0; i < 12; i += 1) { await h.tick(); await new Promise((r) => setTimeout(r, 20)); }
    const filled = h.transcribed.map((x) => x.from);
    assert.ok(filled.length >= 5, `窗口里应已排满，实际 ${filled.join(',')}`);

    for (let i = 0; i < 5; i += 1) { await h.tick(); await new Promise((r) => setTimeout(r, 20)); }
    assert.deepEqual(
      h.transcribed.map((x) => x.from), filled,
      `余量满了还继续转：${h.transcribed.map((x) => x.from).join(',')}`,
    );
    assert.equal(loopStatus().transcript.inflight, null, '不该留一个卡住的在飞任务');
  } finally {
    h.stop();
  }
});

test('喂过的段只喂一次，且那一段之后建图带 omitTranscript', async () => {
  const h = await boot();
  try {
    await h.tick();
    await new Promise((r) => setTimeout(r, 40));
    // 字幕轨很快备好，后面的拍里应该开始喂"后面那些段"
    for (let i = 0; i < 8 && h.feeds.length === 0; i += 1) {
      await h.tick();
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(h.feeds.length >= 1, '字幕先到就该先喂台词');

    const fedFrom = h.feeds[0].from;
    // 一拍只喂一段
    assert.equal(h.feeds.length, 1, `一拍不该塞多条 followup，实际 ${h.feeds.length}`);
    // `feeds.push` 发生在 feedTranscript 内部，标记"已喂"在 await wake 之后 —— 等它落地
    for (let i = 0; i < 20 && !isFedSegment('tt.mp4', fedFrom); i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(isFedSegment('tt.mp4', fedFrom), '喂过的段要能被 isFedSegment 认出来');
    assert.equal(isFedSegment('tt.mp4', fedFrom + 60), false, '别把相邻段也算成喂过');

    // 继续拍：同一段不能喂第二次
    for (let i = 0; i < 10; i += 1) { await h.tick(); await new Promise((r) => setTimeout(r, 15)); }
    const dupes = h.feeds.filter((f) => f.from === fedFrom);
    assert.equal(dupes.length, 1, `同一段喂了 ${dupes.length} 次`);

    const st = loopStatus();
    assert.ok(st.transcript.fed >= 1, 'status 里要报告已喂几段');
  } finally {
    h.stop();
  }
});

test('当前段不喂（它要和图一起给，先喂等于同一批台词说两遍）', async () => {
  const h = await boot();
  try {
    await h.tick();
    for (let i = 0; i < 8; i += 1) { await h.tick(); await new Promise((r) => setTimeout(r, 20)); }
    for (const f of h.feeds) {
      assert.ok(f.from > 10, `喂了当前段（${f.from}）—— 会导致台词重复`);
    }
  } finally {
    h.stop();
  }
});

test('拿不到词时不标记已喂（下一拍还得再试，不能把这句吞了）', async () => {
  let calls = 0;
  const h = await boot({
    feedTranscript: async () => { calls += 1; return { ok: false, text: '', lines: 0, source: 'none' }; },
  });
  try {
    await h.tick();
    for (let i = 0; i < 6; i += 1) { await h.tick(); await new Promise((r) => setTimeout(r, 20)); }
    assert.ok(calls >= 2, `失败之后应该继续重试，实际只试了 ${calls} 次`);
    assert.equal(loopStatus().transcript.fed, 0, '失败不能算已喂');
  } finally {
    h.stop();
  }
});

test('feedTranscriptLeadMs 越大，喂得越晚', async () => {
  const quick = await boot({ sessionId: 'lead0', input: 'lead0.mp4', feedTranscriptLeadMs: 0 });
  let quickAt = 0;
  try {
    await quick.tick();
    for (let i = 0; i < 8 && quick.feeds.length === 0; i += 1) {
      quickAt += 1;
      await quick.tick();
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(quick.feeds.length >= 1, 'lead=0 应该很快喂');
  } finally {
    quick.stop();
  }

  const slow = await boot({ sessionId: 'lead1', input: 'lead1.mp4', feedTranscriptLeadMs: 60_000 });
  try {
    await slow.tick();
    for (let i = 0; i < 8; i += 1) { await slow.tick(); await new Promise((r) => setTimeout(r, 20)); }
    assert.equal(slow.feeds.length, 0, 'lead=60s 时一分钟内不该喂（假钟只走了不到 1 秒）');
  } finally {
    slow.stop();
  }
});

test('transcriptTrack: false 整条轨关掉：不转写、不喂', async () => {
  const h = await boot({ transcriptTrack: false });
  try {
    await h.tick();
    for (let i = 0; i < 5; i += 1) { await h.tick(); await new Promise((r) => setTimeout(r, 20)); }
    assert.equal(h.transcribed.length, 0, '关了字幕轨还在转写');
    assert.equal(h.feeds.length, 0, '关了字幕轨还在喂');
  } finally {
    h.stop();
  }
});

test('连续失败 3 次就拉黑这一段（10 分钟内不再空转）', async () => {
  let calls = 0;
  const bySeg = new Map();
  const h = await boot({
    transcribe: async (from) => {
      calls += 1;
      bySeg.set(from, (bySeg.get(from) ?? 0) + 1);
      throw new Error('ASR 挂了');
    },
  });
  try {
    for (let i = 0; i < 30; i += 1) { await h.tick(); await new Promise((r) => setTimeout(r, 10)); }
    // 每一段最多撞三次；撞满就换下一段，不会对同一段无限重试
    for (const [from, n] of bySeg) assert.ok(n <= 3, `段 ${from} 试了 ${n} 次（应该撞 3 次就拉黑）`);
    // 窗口里 6 段，全撞满之后这一轨就该停下来了
    assert.ok(calls <= 18, `拉黑之后还在空转，共 ${calls} 次`);
    assert.ok(loopStatus().transcript.bad >= 1, 'status 要报告拉黑了几段');
    assert.match(loopStatus().log.join('\n'), /transcribe/, '日志要能看出是转写失败');
  } finally {
    h.stop();
  }
});
