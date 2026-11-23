/**
 * tts-policy.test.mjs — 语音引擎的**数据去向**默认必须是本机。
 *
 * 守的是用户感受得到的那件事：`say` 念的文本默认不出机器（本地 SAPI），
 * 只有显式配置才把文本发给微软的 edge-tts 在线合成。
 * 两条 wiring 用例守 speak() 真的问了策略 —— 策略函数对了、speak() 不用它，一样漏文本。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { speak, ttsPolicy } from '../bin/tts.mjs';

async function homeWith(tts) {
  const dir = await mkdtemp(join(tmpdir(), 'tts-home-'));
  if (tts !== undefined) await writeFile(join(dir, 'tts.json'), JSON.stringify(tts));
  return dir;
}

test('安全：默认没有任何配置 → 本地 SAPI，文本不出机器', async () => {
  const home = await homeWith(undefined);
  try {
    assert.equal(ttsPolicy({ DSH_HOME: home }), 'sapi');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('安全：tts.json {"engine":"edge"} 才开云端（显式选择）', async () => {
  const home = await homeWith({ engine: 'edge' });
  try {
    assert.equal(ttsPolicy({ DSH_HOME: home }), 'edge');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('安全：点名 edgeTts 可执行文件 = 明确要云端', async () => {
  const home = await homeWith({ edgeTts: 'C:/tools/edge-tts.exe' });
  try {
    assert.equal(ttsPolicy({ DSH_HOME: home }), 'edge');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('安全：engine:"sapi" 显式本地 —— 即使配了 edgeTts 也不偷跑', async () => {
  const home = await homeWith({ engine: 'sapi', edgeTts: 'C:/tools/edge-tts.exe' });
  try {
    assert.equal(ttsPolicy({ DSH_HOME: home }), 'sapi');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('安全：DSH_TTS_ENGINE 环境变量同语义（edge 开 / sapi 关）', async () => {
  const home = await homeWith(undefined);
  try {
    assert.equal(ttsPolicy({ DSH_HOME: home, DSH_TTS_ENGINE: 'edge' }), 'edge');
    assert.equal(ttsPolicy({ DSH_HOME: home, DSH_TTS_ENGINE: 'sapi' }), 'sapi');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('wiring：speak() 默认走本地 SAPI（dryRun 报的就是策略的决定）', async () => {
  const home = await homeWith(undefined);
  try {
    const r = await speak('你好', { dryRun: true, env: { DSH_HOME: home } });
    assert.equal(r.engine, 'sapi', 'speak 必须真的问策略，不能自己另搞一套');
    assert.match(r.command, /SAPI\.SpVoice/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('wiring：显式开云端后 speak() 才把文本交给 edge-tts', async () => {
  const home = await homeWith(undefined);
  const fake = join(home, 'fake-edge-tts.exe');
  try {
    await writeFile(fake, 'not really an exe', 'utf8');
    await writeFile(join(home, 'tts.json'), JSON.stringify({ engine: 'edge', edgeTts: fake }));
    const r = await speak('你好', { dryRun: true, env: { DSH_HOME: home } });
    assert.equal(r.engine, 'edge-tts');
    assert.equal(r.exe, fake);
    assert.ok(Array.isArray(r.args) && r.args.includes('--text'), 'edge-tts 那条路的命令要能看见');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('wiring：engine:"sapi" 参数强制本地，压过显式开的云端', async () => {
  const home = await homeWith({ engine: 'edge', edgeTts: 'C:/tools/edge-tts.exe' });
  try {
    const r = await speak('你好', { dryRun: true, engine: 'sapi', env: { DSH_HOME: home } });
    assert.equal(r.engine, 'sapi');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
