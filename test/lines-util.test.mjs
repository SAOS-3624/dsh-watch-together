/**
 * lines-util.test.mjs — "不看图写台词"的那套纯函数。
 *
 * 为什么要它：每段台词都靠看图写，一段要花一张 storyboard（400~700 vision token）。
 * 台词真正需要的信息只有"这段在说什么"和"那句话在第几秒"，字幕里都有。
 * 这个文件把字幕 → 句子的过程锁死，免得哪天 B 站字幕格式变了，
 * 切出"…也就是全球能造E"这种半截话还没人发现。
 */

process.env.DSH_WATCH_BRIDGE = '0';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  autoPick, cachedCues, pickCandidates, scoreSentence, sentencesBetween, sentencesIn,
} from '../src/lines-util.js';
import { linesOverview, readSlot, saveLines } from '../src/watch-lines.js';

/** B 站真实形态：连着的 cue、没有标点、一句话被拆两半 */
const CUES = [
  { from: 0.066, to: 3.213, text: '这里是中国河南郑州的航空港区' },
  { from: 3.213, to: 6.373, text: '苹果的第一台折叠屏手机iPhone Duo' },
  { from: 6.373, to: 8.274, text: '据报道首发的这一批' },
  { from: 8.274, to: 11.5, text: '全部是在这里的富士康工厂组装出来的' },
  { from: 12.9, to: 15.2, text: '开售才三天' },          // 前面有停顿
  { from: 15.2, to: 18.4, text: '就有用户发现屏幕沿着铰链破损了？' },
  { from: 40.0, to: 43.0, text: '那么问题来了' },        // 填充句
  { from: 43.0, to: 47.5, text: '这块屏幕到底是谁造的呢？' },
];

test('切句：不产生半截话（只在 cue 边界上断）', () => {
  const sents = sentencesIn(CUES);
  assert.ok(sents.length >= 3, `应切出几句，实得 ${sents.length}`);
  // 每一句都必须是某几条连续 cue 原文的拼接，不能凭空多字少字（空格在切句时被去掉）
  const flat = CUES.map((c) => c.text.replace(/\s+/g, '')).join('');
  for (const s of sents) {
    assert.ok(flat.includes(s.text), `句子不在原文里：${s.text}`);
  }
  // 不能出现"…能造E"这种在词中间硬切的结果
  for (const s of sents) {
    assert.ok(!/[A-Za-z]$/.test(s.text) || /[A-Za-z]{2,}$/.test(s.text), `别在词中间断：${s.text}`);
  }
});

test('切句：停顿处断开，逗号/问号处收句', () => {
  const sents = sentencesIn(CUES);
  const ats = sents.map((s) => Math.round(s.at));
  assert.ok(ats.includes(13), `12.9 秒那句应该单独成句（停顿），实得 ${ats}`);
  const question = sents.find((s) => s.text.includes('破损了？'));
  assert.ok(question, '问号应成为句尾');
});

test('句子带真实起始秒（at 用字幕时间，不是估计值）', () => {
  const sents = sentencesIn(CUES);
  const first = sents[0];
  assert.equal(first.at, 0.066);
  const q = sents.find((s) => s.text.includes('破损'));
  assert.ok(Math.abs(q.at - 12.9) < 0.01, `问句应该从 12.9 秒那组开始，实得 ${q.at}`);
});

test('候选：只出现在窗口内，数量受 max 限制，按时间排序', () => {
  const cands = pickCandidates(CUES, { from: 0, to: 20, max: 3 });
  assert.ok(cands.length > 0 && cands.length <= 3);
  for (const c of cands) assert.ok(c.at >= 0 && c.at < 20);
  const ats = cands.map((c) => c.at);
  assert.deepEqual(ats, [...ats].sort((a, b) => a - b), '候选要按时间排');
});

test('候选：填充句（"那么问题来了"）打不过信息句', () => {
  const filler = scoreSentence({ text: '那么问题来了' });
  const informative = scoreSentence({ text: '这块屏幕到底是谁造的呢？' });
  assert.ok(informative > filler, `信息句 ${informative} 应高于填充句 ${filler}`);
});

test('auto：按段时间均分挑 count 句，at 落在窗口内且递增', () => {
  const lines = autoPick(CUES, { from: 0, to: 60, count: 3 });
  assert.equal(lines.length, 3);
  for (let i = 1; i < lines.length; i += 1) assert.ok(lines[i].at >= lines[i - 1].at);
  for (const l of lines) {
    assert.ok(l.at >= 0 && l.at < 60);
    assert.ok(l.text.length >= 8, `太短了：${l.text}`);
  }
});

test('窗口内没句子时返回空数组，不抛错', () => {
  assert.deepEqual(sentencesBetween(CUES, 100, 200), []);
  assert.deepEqual(pickCandidates(CUES, { from: 100, to: 200 }), []);
  assert.deepEqual(autoPick(CUES, { from: 100, to: 200 }), []);
});

test('写进去的台词能读回来（saveLines ↔ readSlot 同一套 key）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lines-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    const input = 'https://example.com/v/1';
    const n = await saveLines(input, [
      { from: 60, at: 65.5, text: '第一句' },
      { from: 60, at: 88, text: '第二句' },
    ]);
    assert.equal(n, 2);
    const slot = await readSlot(input, 60);
    assert.equal(slot.length, 2);
    assert.equal(slot[0].at, 65.5);
    const ov = await linesOverview(input);
    assert.deepEqual(ov.map((o) => o.from), [60]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * 热路径：钟每 2 秒一拍都要问一次字幕（一拍拍好几次）。
 * 以前每次都 readFileSync + JSON.parse 整份字幕，而 `makeLagFn` 的 memo 因为每次都是
 * 新数组也一次都命不中。现在按 路径+大小+mtime 认缓存，返回的是同一个数组。
 */
test('cachedCues：文件没变就返回同一份，改了就重读', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cues-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    const file = join(dir, 'subs-memo.mp4.json');
    writeFileSync(file, JSON.stringify({ cues: [{ from: 0, to: 1, text: '一' }] }), 'utf8');
    const a = cachedCues('memo.mp4');
    assert.equal(cachedCues('memo.mp4'), a, '同一份文件 → 同一个数组（上层按身份做 memo）');

    writeFileSync(file, JSON.stringify({ cues: [{ from: 0, to: 1, text: '二' }, { from: 2, to: 3, text: '三' }] }), 'utf8');
    const c = cachedCues('memo.mp4');
    assert.notEqual(c, a, '文件变了就要重读');
    assert.equal(c.length, 2);
  } finally {
    delete process.env.DSH_VIDEO_CACHE_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});
