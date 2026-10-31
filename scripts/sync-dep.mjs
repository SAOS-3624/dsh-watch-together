#!/usr/bin/env node
/**
 * sync-dep — 把同级的 `dsh-video-storyboard` 复制进本包的 `node_modules`。
 *
 *   node scripts/sync-dep.mjs          # 同步
 *   node scripts/sync-dep.mjs --check  # 只看版本差，不改动
 *
 * 为什么是复制，不是 `npm link` / 软链：
 *   本机（Windows）上任何 junction / symlink 都会被判成"不受信任的装入点"，
 *   Node 的 stat/readdir 直接返回 UNKNOWN、`import 'dsh-video-storyboard/xxx'`
 *   报 ERR_MODULE_NOT_FOUND —— 连 TEMP 里 TEMP→TEMP 的 junction 都穿不过去，
 *   所以不是链接类型选错了，是这台机器穿不过重解析点。复制是唯一稳的做法。
 *   （`install-dev.mjs` 用复制还有第二个理由：宿主按真实路径解析裸包名。）
 *
 * 什么时候要跑：改完 storyboard 想在本包验证。`npm test` 的 pretest 会自动跑。
 */

import { cp, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(dirname(fileURLToPath(import.meta.url)));
const DEP = 'dsh-video-storyboard';
const SRC = process.env.DSH_STORYBOARD_SRC || resolve(HERE, '..', DEP);
const DEST = join(HERE, 'node_modules', DEP);

// 和 install-dev 同一套跳过规则：调试产物、一次性 profile、宿主副本都不要
const SKIP = new Set(['node_modules', '.git', 'test', '.tmp']);

const ver = async (dir) => {
  try {
    return JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
};

// **两个仓库并排是"开发期"的便利，不是前提**。
// 从 npm / GitHub 装下来的人没有那个同级目录，`npm test` 也得能跑 —— 所以：
//   有同级源码  → 覆盖进 node_modules（保证测的是你刚改的那份）
//   没有，但已经装好了依赖 → 什么都不做，直接测装好的那份
//   都没有      → 才报错（缺依赖，测试跑不起来）
if (!existsSync(join(SRC, 'package.json'))) {
  const installed = await ver(DEST);
  if (installed) {
    console.log(`没有同级 ${DEP} 源码（${SRC}），用 node_modules 里已装的 ${installed} 跑测试`);
    process.exit(0);
  }
  console.error(`找不到 ${DEP}：既没有同级源码 ${SRC}，node_modules 里也没有。`);
  console.error('先 `npm i`，或把两个仓库并排放 / 设 DSH_STORYBOARD_SRC=<它的路径>。');
  process.exit(2);
}

const srcVer = await ver(SRC);
const destVer = await ver(DEST);

if (process.argv.includes('--check')) {
  console.log(`源码 ${srcVer}  →  node_modules ${destVer ?? '（缺）'}`);
  process.exitCode = srcVer === destVer ? 0 : 1;
} else {
  await rm(DEST, { recursive: true, force: true });
  await cp(SRC, DEST, {
    recursive: true,
    filter: (s) => !SKIP.has(s.split(/[\\/]/).pop()),
  });
  if (srcVer !== destVer) console.log(`${DEP} ${destVer ?? '（缺）'} → ${srcVer}`);
}
