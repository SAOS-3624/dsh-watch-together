/**
 * line-lag.test.mjs — 台词要比字幕**晚一点**开口。
 *
 * 用户实报（2026-10-31）：「你的台词快了一点，我之前不是做了台词延迟吗？被你删了吗」。
 *
 * 延迟本身没删（`speechLag` + `makeLagFn` 一直在 `dueLine` 里），但它依赖
 * `recallSegments(input)` 那份 **in-memory 字幕记忆** —— 建分镜的进程和念台词的进程
 * 未必是同一个，新进程里它是空的，于是 lag 恒为 0：台词一句不差地卡在 `at` 上，
 * 和原声抢话。
 *
 * 这个文件锁两件事：
 *   1. 拿不到字幕记忆时，**按台词自己的字数**估后延（长句子等更久）；
 *   2. 显式 `lagSec: 0` 时完全不加延迟（测试/调试要确定性）。
 */

process.env.DSH_WATCH_BRIDGE = '0';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dueLine, saveLines } from '../src/watch-lines.js';
import { speechLag } from '../src/speech.js';

test('拿不到字幕记忆时，按台词长度后延：at 那一刻不给，晚一点才给', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lag-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    const text = '这一句大概有二十来个字吧所以要多等一会儿';   // 21 字
    const lag = speechLag(text.length);
    assert.ok(lag > 1, `长句子应该有明显的后延，实得 ${lag}`);
    await saveLines('lag.mp4', [{ from: 0, at: 100, text }]);

    assert.equal(await dueLine('lag.mp4', 100, { size: 120 }), null, 'at 那一刻不许开口（会跟原声抢话）');
    assert.equal(await dueLine('lag.mp4', 100 + lag - 0.2, { size: 120 }), null, '差一点点也还没到');
    assert.equal(await dueLine('lag.mp4', 100 + lag + 0.1, { size: 120 }), text, '过了后延才念');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('lagSec: 0 → 完全不加延迟（调试/测试用）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lag2-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    await saveLines('lag2.mp4', [{ from: 0, at: 100, text: '这一句要多等一会儿才念得出来' }]);
    assert.equal(await dueLine('lag2.mp4', 99, { size: 120, lagSec: 0 }), null);
    assert.equal(await dueLine('lag2.mp4', 100, { size: 120, lagSec: 0 }), '这一句要多等一会儿才念得出来');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('后延按字数递增：短句比长句早开口', () => {
  assert.ok(speechLag(4) < speechLag(30), '长句要等更久');
  assert.ok(speechLag(30) <= 3, '但别夸张到三五秒，最多两秒上下');
});
