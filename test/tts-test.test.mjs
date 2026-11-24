/**
 * 试听（ACT.TTS_CN 的"测试"同款）的回归。
 *
 * 守的是用户感受得到的行为：
 *   1. 试听按面板当前参数出声，且**不落盘**；
 *   2. 选了什么引擎就走哪条链，不许静默换链；
 *   3. 设置 API 点 /tts-test 真的出声（SAPI 实播一句）；
 *   4. 两套设置 UI（组合包页表单 + 独立设置页）都接了声音设置与试听。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { effectiveTtsSettings, writeTtsSettings } from '../src/settings/config.js';
import { createSettingsPage } from '../src/settings/server.js';
import {
  acquireTtsTestStream, planTtsTest, runTtsTest, stopTtsTestStream, ttsTestStreamStats,
} from '../src/settings/tts-test.js';

const home = () => mkdtempSync(join(tmpdir(), 'watch-tts-test-'));
const envOf = (dir) => ({ DSH_HOME: dir });

/**
 * 这个文件守的链路里有一条**只在 Windows 上存在**：SAPI（`powershell -Command` 念系统嗓）。
 * Linux / macOS 上陪看根本没有这条链，硬跑会把 `spawn powershell ENOENT` 当成被测代码的 bug
 * —— CI（ubuntu）从 PR #65 合进来起就一直红在这两个用例上。
 *
 * 所以分两类：
 *   - **纯策略 / 文件探测**（planTtsTest、常驻合成器复用）：路径按平台取，两边都真跑，不 skip；
 *   - **真要 SAPI 出声**（`/tts-test` 实跑、新顶旧的掐断时序）：非 Windows 上没有可测的东西，
 *     skip 并把原因写出来，不假装通过。
 */
const WIN = process.platform === 'win32';
const VENV_DIR = WIN ? 'Scripts' : 'bin';
const EDGE_EXE = WIN ? 'edge-tts.exe' : 'edge-tts';
const PY_EXE = WIN ? 'python.exe' : 'python';
const needSapi = { skip: WIN ? false : 'SAPI 只在 Windows 上有；这里测的是系统嗓的实播与掐断时序' };

test('试听配置：面板当前值盖过已保存的 tts.json，且不落盘', () => {
  const dir = home();
  const env = envOf(dir);
  writeTtsSettings({
    engine: 'edge', voice: 'zh-CN-YunxiNeural', rate: 2, volume: 90,
  }, env);
  const cfg = effectiveTtsSettings({
    voice: 'zh-CN-XiaoxiaoNeural', rate: -1, pitch: '+3', volume: 80,
  }, env);
  assert.equal(cfg.voice, 'zh-CN-XiaoxiaoNeural');
  assert.equal(cfg.rate, -1);
  assert.equal(cfg.pitch, '+3');
  assert.equal(cfg.volume, 80);
  assert.equal(cfg.engine, 'edge', '没给的键沿用已保存值');

  const raw = JSON.parse(readFileSync(join(dir, 'tts.json'), 'utf8'));
  assert.equal(raw.voice, 'zh-CN-YunxiNeural', '试听不落盘：已保存的音色不该被动');
  assert.equal(raw.volume, 90, '试听不落盘：已保存的音量不该被动');

  assert.throws(() => effectiveTtsSettings({ volume: '好大声' }, env), /volume/, '校验口径要和保存一致');
});

test('试听链路：选了什么引擎就走哪条，自动才逐级兜底', () => {
  const dir = home();
  const profile = home();
  // venv 目录名和可执行名都按平台取（Linux 是 bin/edge-tts、Scripts 那条在那边根本不存在）
  const venv = join(profile, '.dsh', 'tts-venv', VENV_DIR);
  mkdirSync(venv, { recursive: true });
  writeFileSync(join(venv, EDGE_EXE), '');
  const env = { DSH_HOME: dir, USERPROFILE: profile, PATH: '' };

  // 显式 Edge + 有 python.exe：常驻通道打头阵，不悄悄退回系统嗓
  writeFileSync(join(venv, PY_EXE), '');
  let plan = planTtsTest({ engine: 'edge' }, env);
  assert.deepEqual(plan.chain, ['edge-stream', 'edge-tts']);

  // 没有 python.exe：只剩逐句兜底
  rmSync(join(venv, PY_EXE));
  plan = planTtsTest({ engine: 'edge' }, env);
  assert.deepEqual(plan.chain, ['edge-tts']);

  // 显式 Edge 但什么都没装：直接报错，不许静默换系统嗓蒙混
  rmSync(join(venv, EDGE_EXE));
  plan = planTtsTest({ engine: 'edge' }, env);
  assert.deepEqual(plan.chain, []);

  // 显式本地 SAPI：只走系统嗓
  assert.deepEqual(planTtsTest({ engine: 'sapi' }, env).chain, ['sapi']);

  // 自动：按 tts.json 的策略；默认（没配）是本地，不把文本悄悄送出去
  writeFileSync(join(dir, 'tts.json'), JSON.stringify({ engine: 'sapi' }));
  assert.deepEqual(planTtsTest({}, env).chain, ['sapi']);
  writeFileSync(join(dir, 'tts.json'), JSON.stringify({ engine: 'edge', edgeTts: join(venv, EDGE_EXE) }));
  writeFileSync(join(venv, EDGE_EXE), '');
  writeFileSync(join(venv, PY_EXE), '');
  assert.deepEqual(planTtsTest({}, env).chain, ['edge-stream', 'edge-tts', 'sapi']);
  rmSync(join(dir, 'tts.json'));
  assert.deepEqual(planTtsTest({}, env).chain, ['sapi'], '没配 engine = 默认本地');
});

test('常驻合成器：连点复用同一个，不许每次冷启动（延迟问题的根子）', () => {
  const dir = home();
  const profile = home();
  const venv = join(profile, '.dsh', 'tts-venv', VENV_DIR);
  mkdirSync(venv, { recursive: true });
  writeFileSync(join(venv, EDGE_EXE), '');
  writeFileSync(join(venv, PY_EXE), '');
  const env = { DSH_HOME: dir, USERPROFILE: profile, PATH: '' };

  stopTtsTestStream();
  const made = [];
  const fakeStart = (opts) => {
    made.push(opts);
    return {
      alive: true,
      say: async () => ({ first: 10, done: 20 }),
      prefetch: async () => ({}),
      interrupt() {},
      stop() { this.alive = false; },
    };
  };

  const first = acquireTtsTestStream(env, fakeStart);
  const second = acquireTtsTestStream(env, fakeStart);
  assert.ok(first, '有 edge-tts + python 就该起得来');
  assert.equal(second, first, '第二次必须复用同一个合成器');
  assert.equal(made.length, 1, '只许冷启动一次（每次都冷启动就是「延迟高」）');
  assert.equal(ttsTestStreamStats().starts >= 1, true);

  stopTtsTestStream();
  const third = acquireTtsTestStream(env, fakeStart);
  assert.notEqual(third, first, '停掉之后才允许重新起');
  assert.equal(made.length, 2);
  stopTtsTestStream();
});

/* ------------------------------------------------- 设置 API（真出声） */

function fakeWeb() {
  let handler = null;
  const webServer = {
    port: 3080,
    register(route) { handler = route.handler; return () => { handler = null; }; },
    getOrigin() { return 'http://127.0.0.1:3080'; },
  };
  const ctx = { get: () => webServer, on: () => () => {} };
  return { ctx, handler: () => handler };
}

function response() {
  const out = { status: 0, headers: {}, body: '' };
  return {
    out, headersSent: false,
    writeHead(status, headers) { out.status = status; out.headers = headers || {}; this.headersSent = true; },
    end(body = '') { out.body = String(body); },
  };
}

async function invoke(handler, { method = 'GET', url = '/', headers = {}, body } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
  req.method = method; req.url = url; req.headers = headers;
  const res = response();
  await handler(req, res);
  return res.out;
}

test('设置 API：/tts-test 走完整出声链路（SAPI 静音实跑）、文本上限、/state 带 tts 段', needSapi, async () => {
  const dir = home();
  const env = envOf(dir);
  const web = fakeWeb();
  const page = createSettingsPage({ ctx: web.ctx, env });
  assert.ok(page);
  const token = new URL(page.url).searchParams.get('token');
  const api = (action, options = {}) => invoke(web.handler(), {
    ...options,
    url: '/dsh-watch-together/settings/api' + action,
    headers: { 'x-settings-token': token, ...(options.headers || {}) },
  });

  // 点试听要走完整的出声链路：这里实跑一句最短的。
  // **volume: 0 静音跑**：断言的是链路行为（ok / 引擎 / 掐断时序），从不验证声波；
  // 每次跑测试都出声会在桌边冒随机语音碎片（用户真听到过一个"文"字）。
  const played = await api('/tts-test', {
    method: 'POST',
    body: JSON.stringify({ text: '嗯。', tts: { engine: 'sapi', volume: 0 } }),
  });
  assert.equal(played.status, 200);
  const out = JSON.parse(played.body);
  assert.equal(out.ok, true, 'SAPI 试听必须走完整链路：' + (out.reason || ''));
  assert.equal(out.engine, 'sapi');

  const bad = await api('/tts-test', {
    method: 'POST',
    body: JSON.stringify({ text: 'x'.repeat(300) }),
  });
  assert.equal(bad.status, 400);
  assert.match(JSON.parse(bad.body).error, /太长/);

  // /state 要带 tts 段（两套表单都从这里回填滑块）
  const state = JSON.parse((await api('/state')).body);
  assert.ok(state.tts, '/state 必须带 tts 段');
  assert.equal(state.tts.volume, 100);
  assert.equal(typeof state.tts.voice, 'string');
  assert.ok(state.paths.tts, '/state 的 paths 要给 tts.json 路径');
});

/* ------------------------------------------------- 两套设置 UI 都接 */

test('两套设置 UI：组合包页表单与独立页都接了声音设置与试听', () => {
  const clientSrc = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.match(clientSrc, /apiCall\(api, '\/tts-test',\s*\{[^}]*tts: ttsPayloadOf\(current\)/,
    '组合包页表单：试听要带面板当前 tts 参数调 /tts-test');
  assert.ok(clientSrc.includes("'朗读音量'") && clientSrc.includes("'人声选择'"),
    '组合包页表单：声音设置滑块要在');

  const pageSrc = readFileSync(new URL('../src/settings/page.html', import.meta.url), 'utf8');
  assert.ok(pageSrc.includes("id=\"ttsVolume\"") && pageSrc.includes("id=\"ttsVoice\""),
    '独立设置页：声音设置滑块要在');
  assert.match(pageSrc, /api\('\/tts-test', \{ text: \$\('ttsTestText'\)\.value, tts: ttsPayload\(\) \}/,
    '独立设置页：试听要带面板当前 tts 参数调 /tts-test');
});

test('试听入口：runTtsTest 对超长文本直接拒绝，不碰任何引擎', async () => {
  await assert.rejects(
    runTtsTest({ text: 'x'.repeat(201), tts: { engine: 'sapi' }, env: envOf(home()) }),
    /太长/,
  );
});

test('跑着的试听会被下一次立刻掐断（新顶旧，不许叠着响、不许干等）', needSapi, async () => {
  const env = envOf(home());
  const long = '这是一段比较长的试听文本，让第一次试听念上好几秒，用来验证重叠时的掐断。';
  // volume: 0 静音跑（耗时和出声一样，时序断言不受影响）：被掐断的半句会往外冒
  // 语音碎片，桌边听着像莫名其妙蹦出一个字
  const p1 = runTtsTest({ text: long, tts: { engine: 'sapi', volume: 0 }, env });
  await new Promise((r) => setTimeout(r, 150)); // 让第一次真的起进程念起来
  const t0 = Date.now();
  const p2 = runTtsTest({ text: '嗯。', tts: { engine: 'sapi', volume: 0 }, env });
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.ok, false, '旧的一次要被掐断，不是念完一整句');
  assert.equal(r1.reason, 'interrupted');
  assert.equal(r2.ok, true, '新的一次照常出声：' + (r2.reason || ''));
  // 计时只是辅助（铁证在上面的 interrupted）：上限取 9 秒 —— 真"干等旧的念完"是
  // 10.5 秒起步；5 秒的旧上限会在全量并行（别处狂起 powershell）时被挤爆。
  assert.ok(Date.now() - t0 < 9000, '新的一次不该排队等旧的念完');
});
