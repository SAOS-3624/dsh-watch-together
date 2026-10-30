/**
 * schema-audit.test.mjs — **宿主按 schema 过滤参数**：handler 读了、schema 没声明的参数，
 * 永远到不了 handler，而且**不报错、不告警**，只是安静地退回默认值。
 *
 * 这一类 bug 在这个插件的历史上出现过两次（`watch.browserPort` 被吞掉、
 * `watch.loop` 被吞掉，导致"传了 loop:false 也关不掉循环"）。靠人眼对两张表是挡不住的，
 * 所以这里做静态审计：
 *
 *   1. 扫每个 handler 模块里的 `args.X` → "它到底读哪些参数"；
 *   2. 断言这些名字都在 `watchToolSpec().parameters` 里（否则宿主会吞掉）；
 *   3. 断言 schema 里没有重复键（对象字面量的重复 key，后一个会静默覆盖前一个）；
 *   4. 断言 `dsh.plugin.json` 的版本和 `package.json` 一致；
 *   5. 断言注册入口真的用 `...watchToolSpec()` 展开，而不是自己又抄一份。
 *
 * 不需要宿主、不需要网络，纯文本审计 —— 所以它在 CI 里一定跑得起来。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { watchToolSpec } from '../src/tool-spec.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
// 读进来先归一换行：这个测试做的是**文本切分**，CRLF 会让所有 `\n` 匹配失效
const read = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const src = (name) => read(join(ROOT, 'src', name));

/**
 * `watch_together` 的 handler 由哪些模块组成。
 *
 * **必须精确到工具**：一个模块里塞两个 handler，扫出来的就是并集，审计立刻失效。
 * 这里只有一个工具，所以只要保证这个列表跟着 handler 一起长。
 */
const HANDLER_MODULES = [
  'handler.js',
  'watch-actions.js',
  'watch-run.js',
  'watch-modes.js',
  'watch-source.js',
];

/** 扫一个模块里所有 `args.X` / `args?.X` —— 这就是 handler 真正会读的参数名 */
function readArgNames(source) {
  const names = new Set();
  for (const m of source.matchAll(/\bargs\??\.([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  return names;
}

test('schema 审计：handler 读的 args 都在 watchToolSpec 的 parameters 里', () => {
  const declared = new Set(Object.keys(watchToolSpec().parameters ?? {}));
  const readNames = new Set();
  for (const mod of HANDLER_MODULES) {
    for (const name of readArgNames(src(mod))) {
      if (!declared.has(name)) readNames.add(name);
    }
  }
  const problems = [...readNames].sort();
  assert.deepEqual(problems, [],
    `\nhandler 读了但 schema 没声明 [${problems.join(', ')}]`
    + '（宿主会静默丢掉它们）\n');
});

test('schema 审计：parameters 里没有重复键（后者会静默覆盖前者）', () => {
  const all = src('tool-spec.js');
  const at = all.indexOf(`export function ${watchToolSpec.name}(`);
  assert.ok(at >= 0, '找不到 watchToolSpec 的定义');
  const fn = all.slice(at);
  const body = fn.slice(0, fn.indexOf('\n}\n') + 1);
  const from = body.indexOf('parameters: {');
  const to = body.indexOf('\n    output: {');
  assert.ok(from > 0 && to > from, '找不到 parameters → output 区间');

  const keys = [...body.slice(from, to).matchAll(/\n {6}([A-Za-z_$][\w$]*): /g)].map((m) => m[1]);
  assert.ok(keys.length > 0, 'parameters 一个键都没切到 —— 切片口径已经和代码对不上了');

  const problems = [];
  const seen = new Set();
  for (const k of keys) {
    if (seen.has(k)) problems.push(`参数 ${k} 定义了两次`);
    seen.add(k);
  }
  assert.deepEqual(problems, [], `\n${problems.join('\n')}\n`);
});

test('schema 审计：dsh.plugin.json 的版本和 package.json 一致', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const plugin = JSON.parse(readFileSync(join(ROOT, 'dsh.plugin.json'), 'utf8'));
  assert.equal(plugin.version, pkg.version,
    'dsh.plugin.json 的 version 落后会让人装到"看起来是旧版"的插件');
});

test('schema 审计：工具名和注册入口一致', () => {
  assert.equal(watchToolSpec().name, 'watch_together');
  const reg = src('register.js');
  assert.ok(reg.includes('...watchToolSpec()'),
    'register.js 应该用 ...watchToolSpec() 展开，而不是自己抄一份参数表');
});

test('schema 审计：入口只注册这一个工具', () => {
  const entry = src('index.js');
  assert.ok(entry.includes('watchTools('), 'index.js 应该调用 watchTools()');
  assert.ok(!/video_storyboard|video_zoom|video_probe|video_locate/.test(entry),
    'video_* 是 dsh-video-storyboard 的工具，不该由本插件注册');
});
