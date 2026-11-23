/**
 * tts-pitch.test.mjs — 音调（pitch）三处接线的口径。
 *
 * 背景（2026-11-21）：用户在游戏里用的 ACT.TTS_CN 有音调/情感参数，决定给陪看
 * 的 TTS 也加上 pitch。两个引擎单位不同（edge-tts 要 "+2Hz"，SAPI 要 `<pitch
 * absmiddle="2">` XML 标签），口径只写一份（bin/tts.mjs），这里锁住换算和拼参。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  normPitch, edgePitchArg, sapiPitchWrap, edgeCliArgs, buildSpeakCommand, speakViaEdgeTts,
} from '../bin/tts.mjs';

const run = promisify(execFile);

test('normPitch：ACT 口径（"+0"/"+2"）和带单位写法都认；0/不配/乱写 → null', () => {
  assert.deepEqual(normPitch('+2'), { hz: '+2Hz', mid: 2 });
  assert.deepEqual(normPitch('-3Hz'), { hz: '-3Hz', mid: -3 });
  assert.deepEqual(normPitch(2), { hz: '+2Hz', mid: 2 });
  assert.equal(normPitch('+0'), null, '0 就是"没调"，不该带参数');
  assert.equal(normPitch(undefined), null);
  assert.equal(normPitch('abc'), null);
  assert.equal(normPitch('99').hz, '+50Hz', '越界要收敛，别把参数打飞');
});

test('edgeCliArgs：有 pitch 才拼 --pitch；语速照旧换算百分比', () => {
  const a = edgeCliArgs({ text: '你好', voice: 'zh-CN-XiaoxiaoNeural', rate: 2, pitch: '+2', out: 'x.mp3' });
  assert.ok(a.includes('--pitch=+2Hz'), `实参里要有 pitch，实得 ${a.join(' ')}`);
  assert.ok(a.includes('--rate=+6%'));
  const b = edgeCliArgs({ text: '你好', voice: 'v', rate: 0, pitch: null, out: 'x.mp3' });
  assert.ok(!b.some((x) => x.startsWith('--pitch=')), '没配音调就不许拼这个参数');
});

test('sapiPitchWrap：SAPI 没有音调属性，要包 XML 标签并转义文本', () => {
  assert.equal(sapiPitchWrap('你好', '+2'), '<pitch absmiddle="2">你好</pitch>');
  assert.equal(sapiPitchWrap('你好', null), '你好', '没配音调保持原样');
  assert.equal(sapiPitchWrap('a<b>&c', '-3'), '<pitch absmiddle="-3">a&lt;b&gt;&amp;c</pitch>');
});

test('buildSpeakCommand：带 pitch 时命令里要出现 <pitch absmiddle=', () => {
  const cmd = buildSpeakCommand({ text: '测试', rate: 0, pitch: '+2' });
  assert.match(cmd, /<pitch absmiddle="2">测试<\/pitch>/);
  const plain = buildSpeakCommand({ text: '测试', rate: 0 });
  assert.doesNotMatch(plain, /<pitch /, '不配音调时命令保持原样');
});

test('speakViaEdgeTts：dryRun 的实参里带 --pitch（真引擎路径的拼参由 edgeCliArgs 保证）', async () => {
  const d = await speakViaEdgeTts('你好', { bin: 'fake-edge-tts', voice: 'zh-CN-XiaoxiaoNeural', pitch: '-2', dryRun: true });
  assert.equal(d.ok, true);
  assert.ok(d.args.includes('--pitch=-2Hz'), `实得 ${d.args.join(' ')}`);
});

test('daemon.py（常驻合成器）：norm_pitch 同口径，TTSConfig 收到 pitch', async (t) => {
  const venvPy = join(homedir(), '.dsh', 'tts-venv', 'Scripts', 'python.exe');
  const py = existsSync(venvPy)
    ? venvPy
    : join(homedir(), 'AppData', 'Roaming', 'uv', 'python', 'cpython-3.12.13-windows-x86_64-none', 'python.exe');
  if (!existsSync(py)) return t.skip('找不到 python');
  const streamDir = join(process.cwd(), 'examples', 'voice-edge-tts', 'stream');
  const code = 'import sys; sys.path.insert(0, sys.argv[1]); import daemon;'
    + ' e = daemon.EdgeLink("zh-CN-XiaoxiaoNeural", "+0%", daemon.norm_pitch("+2"));'
    + ' assert e.conf.pitch == "+2Hz", e.conf.pitch;'
    + ' assert daemon.norm_pitch("-3Hz") == "-3Hz";'
    + ' assert daemon.norm_pitch(None) == "+0Hz";'
    + ' print("py-ok")';
  const out = await run(py, ['-c', code, streamDir]);
  assert.match(out.stdout, /py-ok/, 'daemon 的 pitch 换算必须和 JS 同口径');
});
