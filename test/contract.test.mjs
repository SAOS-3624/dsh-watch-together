/**
 * contract.test.mjs — 用**宿主真实的** defineTool / validateArgs 校验 `watch_together` 的定义。
 *
 * 为什么要这一步：单测里的桩件永远可能"复刻错"。而 schema 用了宿主不认的
 * 关键字时，不是"工具不好用"，而是 `ctx.tools.register()` 在 apply() 期间抛错
 * —— 整棵插件树连带应用一起起不来。
 *
 * 这条测试原来在 `dsh-video-storyboard` 的 `test/contract.test.mjs` 里，随工具一起搬过来。
 * 找不到宿主包时自动 skip（CI 里没有本地 DSH 安装是正常的）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { validateWatchArgs, watchToolSpec } from '../src/tool-spec.js';

const HOST_TOOLS = join(homedir(), '.dsh/profiles/node_modules/@deepseek-ai/dsh-tools/lib/index.js');

/**
 * `~/.dsh/profiles/node_modules/@deepseek-ai/dsh-tools` 是个 **symlink**（npm 装的），
 * 而本机穿不过任何重解析点 —— Node 的 stat/readlink/import 一律返回 `UNKNOWN`，
 * 于是"路径明明在那儿"却读不到。这是本机环境的事实，不是没装 DSH。
 *
 * 所以再加一条：去 npx 缓存里找链接的真实目标（`_npx/<hash>/node_modules/…`）。
 * 哈希每次 npx 都可能变，所以不写死，直接扫。
 */
function npxCandidates() {
  const roots = process.platform === 'win32'
    ? [join(homedir(), 'AppData/Local/npm-cache/_npx')]
    : [join(homedir(), '.npm/_npx')];
  const out = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    try {
      for (const h of readdirSync(root)) out.push(join(root, h, 'node_modules/@deepseek-ai/dsh-tools/lib/index.js'));
    } catch { /* 读不了就跳过 */ }
  }
  return out;
}

const CANDIDATES = [
  process.env.DSH_TOOLS_PATH,
  HOST_TOOLS,
  '/usr/local/lib/node_modules/@deepseek-ai/dsh-tools/lib/index.js',
  ...npxCandidates(),
].filter(Boolean);

let host;
let hostPath;
for (const candidate of CANDIDATES) {
  // 符号链接存在性也判不出来（UNKNOWN），所以直接试 import，失败就换下一个
  try {
    host = await import(pathToFileURL(candidate).href);
    hostPath = candidate;
    break;
  } catch {
    /* 换个候选 */
  }
}

test('contract: watch_together schema 暴露文档里写了的 browserPort / loop / say', async (t) => {
  if (!host) {
    return t.skip('host @deepseek-ai/dsh-tools 读不到：没装，或者本机穿不过那条 symlink'
      + '（用 DSH_TOOLS_PATH 指向真实的 lib/index.js）');
  }
  t.diagnostic(`host: ${hostPath}`);
  const spec = watchToolSpec();
  const tool = host.defineTool({ ...spec, execute: async () => ({ images: [], text: '' }) });
  assert.equal(tool.name, 'watch_together');
  assert.equal(spec.parameters.browserPort.type, 'integer');
  assert.deepEqual(host.validateArgs(spec.parameters, { browserPort: 9333, statusOnly: true }), []);
  assert.deepEqual(validateWatchArgs({ browserPort: 9333, statusOnly: true }), []);
  assert.ok(validateWatchArgs({ browserPort: 0 }).length > 0);
  assert.ok(validateWatchArgs({ browserPort: 1.5 }).length > 0);
  assert.ok(validateWatchArgs({ browserPort: 65536 }).length > 0);
  // loop:false 是"别起后台循环"的开关。它以前不在 schema 里，于是永远关不掉。
  assert.equal(spec.parameters.loop.type, 'boolean');
  assert.deepEqual(host.validateArgs(spec.parameters, { loop: false }), []);
  assert.deepEqual(validateWatchArgs({ loop: false }), []);
  assert.ok(validateWatchArgs({ loop: 'no' }).length > 0);
  // say：模型插话那句写进统一文本流（插件读不到正常回复）
  assert.equal(spec.parameters.say.type, 'string');
  assert.deepEqual(host.validateArgs(spec.parameters, { say: '这句' }), []);
  assert.ok(validateWatchArgs({ say: '  ' }).length > 0);
  // lines[].at 允许直接写字幕原文片段（字符串）—— 真实秒数要查转写才知道，这里不该拦；
  // 但空字符串要拦，数字仍要 >= from。这条以前把字符串一律拒，模型照着文档传片段就报错。
  assert.deepEqual(validateWatchArgs({ lines: [{ from: 0, at: '富士康工厂组装出来的', text: 'x' }] }), []);
  assert.ok(validateWatchArgs({ lines: [{ from: 0, at: '   ', text: 'x' }] }).length > 0);
  assert.ok(validateWatchArgs({ lines: [{ from: 60, at: 30, text: 'x' }] }).length > 0);
  // stop 是 stopLoop 的别名：用户说"停止一起看"时模型会敲 stop
  assert.equal(spec.parameters.stop.type, 'boolean');
  assert.deepEqual(validateWatchArgs({ stop: true }), []);
  // 图与字幕分开返回：`transcriptOnly` 只给句子（+真实秒数），必须带 input/from
  assert.equal(spec.parameters.transcriptOnly.type, 'boolean');
  assert.equal(spec.parameters.from.type, 'number');
  assert.equal(spec.parameters.size.type, 'number');
  assert.deepEqual(validateWatchArgs({ transcriptOnly: true, input: 'u', from: 360 }), []);
  assert.ok(validateWatchArgs({ transcriptOnly: true, from: 360 }).length > 0, '缺 input 要拦');
  assert.ok(validateWatchArgs({ transcriptOnly: true, input: 'u' }).length > 0, '缺 from 要拦');
  assert.ok(validateWatchArgs({ transcript: 'bogus' }).length > 0, 'transcript 只认 auto/off');
  // 语音参数已经从核心移除
  for (const gone of ['tts', 'voice', 'rate', 'listVoices', 'speakAloud', 'text']) {
    assert.equal(spec.parameters[gone], undefined, `${gone} 应该已从 watch_together 移除`);
  }
});
