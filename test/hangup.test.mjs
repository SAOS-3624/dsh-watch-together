/**
 * hangup.test.mjs — 用户关掉悬浮窗 = 不看了，这件事必须被记住。
 *
 * 用户实报（2026-10-31）：「我每次关了悬浮窗，明明应该结束一起看模式然后结束对话了，
 * 他又重新拉起来悬浮窗，干嘛呢」。
 *
 * 关窗是他表达"我不看了"的方式；下一轮调用要是又按"新开一场"把窗口顶回来，
 * 等于把他的动作撤销掉。所以关窗时落一条 `hangup`，之后只有**用户明确要求重开**
 * （工具参数 `open: true`）或换了一支片子才清掉。
 */

process.env.DSH_WATCH_BRIDGE = '0';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clearHungUp, isHungUp, markHungUp } from '../src/watch-state.js';

test('关窗之后：同一支片子算"挂断"，别的片子不算', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hang-'));
  const env = { ...process.env, DSH_VIDEO_CACHE_DIR: dir };
  try {
    const url = 'https://www.bilibili.com/video/BV1abc123456/';
    await markHungUp(url, env);
    assert.equal(await isHungUp(url, env), true);

    // 带 trackid 的同一个视频也要认出来（sessionKey 会归一）
    assert.equal(await isHungUp(`${url}?trackid=web_pegasus_0.router&spm_id_from=333.1007`, env), true);

    assert.equal(await isHungUp('https://www.bilibili.com/video/BV1zzz999999/', env), false,
      '换一支片子不该被上一支的挂断挡住');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('明确要求重开之后，挂断记录要清掉', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hang2-'));
  const env = { ...process.env, DSH_VIDEO_CACHE_DIR: dir };
  try {
    const url = 'https://www.bilibili.com/video/BV1abc123456/';
    await markHungUp(url, env);
    assert.equal(await clearHungUp(env), true);
    assert.equal(await isHungUp(url, env), false, '清过之后就该允许重新开窗');
    assert.equal(await clearHungUp(env), false, '没有记录时不要报成功');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
