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
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { validateWatchArgs, watchToolSpec } from '../src/tool-spec.js';

const HOST_TOOLS = join(homedir(), '.dsh/profiles/node_modules/@deepseek-ai/dsh-tools/lib/index.js');
const CANDIDATES = [
  process.env.DSH_TOOLS_PATH,
  HOST_TOOLS,
  '/usr/local/lib/node_modules/@deepseek-ai/dsh-tools/lib/index.js',
].filter(Boolean);

let host;
let hostPath;
for (const candidate of CANDIDATES) {
  if (!existsSync(candidate)) continue;
  try {
    host = await import(pathToFileURL(candidate).href);
    hostPath = candidate;
    break;
  } catch {
    /* 换个候选 */
  }
}

test('contract: watch_together schema 暴露文档里写了的 browserPort / loop / say', async (t) => {
  if (!host) return t.skip('host @deepseek-ai/dsh-tools not found');
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
  // 语音参数已经从核心移除
  for (const gone of ['tts', 'voice', 'rate', 'listVoices', 'speakAloud', 'text']) {
    assert.equal(spec.parameters[gone], undefined, `${gone} 应该已从 watch_together 移除`);
  }
});
