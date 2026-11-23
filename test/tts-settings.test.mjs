/**
 * tts-settings.test.mjs — 声音调节面板背后的三件事。
 *
 * 背景（2026-11-21）：把 ACT.TTS_CN 那块「引擎设置」面板（声调/音量/速度/人声）
 * 搬进一起看的设置页。锁：
 *   ① tts.json 读写语义：默认值、合并不覆盖引擎策略键、非法值拒绝、越界收敛、未知键忽略；
 *   ② 音量换算口径（0-100 → edge 相对百分比），和语速/音调一样只写一份；
 *   ③ 常驻合成器（daemon.py）同口径：音量进 TTSConfig、每请求参数覆盖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { readTtsSettings, writeTtsSettings } from '../src/settings/config.js';
import { edgeCliArgs, edgeVolumeArg, buildSpeakCommand } from '../bin/tts.mjs';

const run = promisify(execFile);

function freshEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'tts-cfg-'));
  return { dir, env: { DSH_HOME: dir } };
}

test('tts 设置：默认值 + 写入读回', () => {
  const { dir, env } = freshEnv();
  try {
    const d = readTtsSettings(env);
    assert.equal(d.exists, false);
    assert.equal(d.rate, 0);
    assert.equal(d.volume, 100, '默认音量 100 = 不增不减');
    const w = writeTtsSettings({
      engine: 'edge', voice: 'zh-CN-XiaoxiaoNeural', rate: 2,
      pitch: '+2', volume: 80,
    }, env);
    assert.equal(w.engine, 'edge');
    assert.equal(w.voice, 'zh-CN-XiaoxiaoNeural');
    assert.equal(w.rate, 2);
    assert.equal(w.pitch, '+2');
    assert.equal(w.volume, 80);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tts 设置：只改滑块不动引擎策略键（合并写入）', () => {
  const { dir, env } = freshEnv();
  try {
    writeTtsSettings({ engine: 'sapi', edgeTts: 'D:/tools/edge-tts.exe' }, env);
    const w = writeTtsSettings({ pitch: '-3', volume: 60 }, env);
    assert.equal(w.engine, 'sapi', '没提交的键不许动');
    assert.equal(w.edgeTts, 'D:/tools/edge-tts.exe');
    assert.equal(w.pitch, '-3');
    assert.equal(w.volume, 60);
    // pitch 归 0 = 删掉（和"从没配过"一个行为）
    const w2 = writeTtsSettings({ pitch: '' }, env);
    assert.equal(w2.pitch, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tts 设置：非法值要拒绝，越界要收敛，未知键忽略', () => {
  const { dir, env } = freshEnv();
  try {
    assert.throws(() => writeTtsSettings({ engine: 'azure' }, env), /engine/);
    assert.throws(() => writeTtsSettings({ pitch: '高一点' }, env), /pitch/);
    // 未知键（如旧配置里的 style/styleDegree）：不炸、也不落盘
    const w0 = writeTtsSettings({ style: 'cheerful', styleDegree: 2 }, env);
    assert.equal(w0.style, undefined, '未知键不进读回结果');
    assert.equal(w0.styleDegree, undefined);
    assert.equal(Object.hasOwn(JSON.parse(readFileSync(join(dir, 'tts.json'), 'utf8')), 'style'), false,
      '未知键不落盘');
    const w = writeTtsSettings({ rate: 99, volume: -5 }, env);
    assert.equal(w.rate, 10, '语速越界收到 ±10');
    assert.equal(w.volume, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('音量换算：0-100 → edge 相对百分比（100 不给参数）', () => {
  assert.equal(edgeVolumeArg(100), null);
  assert.equal(edgeVolumeArg(80), '-20%');
  assert.equal(edgeVolumeArg(120), '+20%');
  assert.equal(edgeVolumeArg(0), '-50%', '再低也只到 -50%');
  const args = edgeCliArgs({ text: 'x', voice: 'v', volume: 80, out: 'o.mp3' });
  assert.ok(args.includes('--volume=-20%'), `实得 ${args.join(' ')}`);
});

test('SAPI 命令：音量要落到 $v.Volume', () => {
  const cmd = buildSpeakCommand({ text: '测试', volume: 60, rate: 0 });
  assert.match(cmd, /\$v\.Volume = 60/);
});

test('daemon.py：音量进 TTSConfig，和 JS 同口径', async (t) => {
  const venvPy = join(homedir(), '.dsh', 'tts-venv', 'Scripts', 'python.exe');
  const py = existsSync(venvPy)
    ? venvPy
    : join(homedir(), 'AppData', 'Roaming', 'uv', 'python', 'cpython-3.12.13-windows-x86_64-none', 'python.exe');
  if (!existsSync(py)) return t.skip('找不到 python');
  const streamDir = join(process.cwd(), 'examples', 'voice-edge-tts', 'stream');
  const code = 'import sys; sys.path.insert(0, sys.argv[1]); import daemon;'
    + ' assert daemon.norm_volume("80") == "-20%", daemon.norm_volume("80");'
    + ' assert daemon.norm_volume(100) == "+0%";'
    + ' e = daemon.EdgeLink("zh-CN-XiaoxiaoNeural", "+0%", "+2Hz", daemon.norm_volume("80"));'
    + ' assert e.conf.volume == "-20%", e.conf.volume;'
    + ' print("py-ok")';
  const out = await run(py, ['-c', code, streamDir]);
  assert.match(out.stdout, /py-ok/, 'daemon 的音量换算必须和 JS 同口径');
});

test('daemon.py：say/prefetch 的每请求参数覆盖（试听用），口径与启动默认一致', async (t) => {
  const venvPy = join(homedir(), '.dsh', 'tts-venv', 'Scripts', 'python.exe');
  const py = existsSync(venvPy)
    ? venvPy
    : join(homedir(), 'AppData', 'Roaming', 'uv', 'python', 'cpython-3.12.13-windows-x86_64-none', 'python.exe');
  if (!existsSync(py)) return t.skip('找不到 python');
  const streamDir = join(process.cwd(), 'examples', 'voice-edge-tts', 'stream');
  const code = 'import sys; sys.path.insert(0, sys.argv[1]); import daemon;'
    + ' d = {"voice": "zh-CN-YunxiNeural", "rate": "+0%", "pitch": "+0Hz", "volume": "+0%"};'
    + ' p = daemon.job_params({}, d);'
    + ' assert p == ("zh-CN-YunxiNeural", "+0%", "+0Hz", "+0%"), p;'
    + ' p = daemon.job_params({"voice": "zh-CN-XiaoxiaoNeural", "rate": -10, "pitch": "+2", "volume": 80}, d);'
    + ' assert p[0] == "zh-CN-XiaoxiaoNeural", p;'
    + ' assert p[1] == "-30%", p[1];'
    + ' assert p[2] == "+2Hz", p[2];'
    + ' assert p[3] == "-20%", p[3];'
    + ' p = daemon.job_params({"pitch": "0"}, d);'
    + ' assert p[2] == "+0Hz", p;'
    + ' p = daemon.job_params({"voice": ""}, d);'
    + ' assert p[0] == "zh-CN-YunxiNeural", p;'
    + ' print("py-ok")';
  const out = await run(py, ['-c', code, streamDir]);
  assert.match(out.stdout, /py-ok/, '每请求参数的换算口径必须和启动默认一致（缓存键也含它）');
});
