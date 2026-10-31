#!/usr/bin/env node
/**
 * install-dev — 把本包同步进 DSH 的 desktop profile。
 *
 *   node scripts/install-dev.mjs              # 只更新本包
 *   node scripts/install-dev.mjs --with-dep   # 连 dsh-video-storyboard 一起更新
 *   node scripts/install-dev.mjs --remove     # 卸载本包（还原 package.json 里本包的条目）
 *   node scripts/install-dev.mjs --check      # 只检查当前状态，不改动
 *
 * 为什么要手动做这件事：desktop profile 由 Electron 应用独占管理，
 * `dsh plugin --profile desktop ...` 会被拒绝（"managed exclusively by the Electron application"）。
 *
 * 为什么是复制而不是软链：Node 解析裸包名（`@deepseek-ai/dsh-tools`）时用的是真实路径，
 * 软链会让它从源码目录向上找、找不到宿主的包。复制到 profile 的 node_modules 里，
 * 解析链才是 profiles/desktop/node_modules → profiles/node_modules。
 * （本机还有第二层原因：这台机器穿不过任何重解析点，见 scripts/sync-dep.mjs。）
 *
 * **和 storyboard 的关系**：本包 `import 'dsh-video-storyboard/xxx'` 用的是裸包名，所以
 * profile 的 node_modules 里必须**存在** dsh-video-storyboard，否则陪看一加载就
 * ERR_MODULE_NOT_FOUND —— 这是 Node 的模块解析，不是两个包绑在一起。
 * 它存在就行；**不跟着本包一起更新**（`--with-dep` 才更新），因为两者是独立仓库、独立版本线，
 * 各有各的发版节奏。早期这里无条件覆盖，结果是"改一句陪看的文案，顺手把别人正在改的
 * 分镜算法也同步进了宿主"。
 */

import { cp, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(dirname(fileURLToPath(import.meta.url)));
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const PROFILE = process.env.DSH_PROFILE || 'desktop';
const PROFILE_DIR = join(DSH_HOME, 'profiles', PROFILE);
const MODULES = join(PROFILE_DIR, 'node_modules');
const PKG_NAME = 'dsh-watch-together';
const DEP_NAME = 'dsh-video-storyboard';

// 依赖从哪来：优先环境变量，其次同级目录（开发时两个仓库并排放）
const DEP_SRC = process.env.DSH_STORYBOARD_SRC
  || resolve(HERE, '..', DEP_NAME);

// `.tmp` 必须跳过：里面有调试输出、Edge 的一次性 profile（Cookies 文件被占用时 cp 会直接失败）
const SKIP = new Set(['node_modules', '.git', 'test', '.tmp']);

const mode = process.argv.includes('--remove') ? 'remove'
  : process.argv.includes('--check') ? 'check' : 'install';

if (!existsSync(PROFILE_DIR)) {
  console.error(`profile 不存在：${PROFILE_DIR}`);
  process.exit(2);
}
const pkgPath = join(PROFILE_DIR, 'package.json');

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

/** 往 profile 的 package.json 里加/删一个包（幂等；首次安装会先备份） */
async function editProfile({ add, name, src }) {
  const pkg = await readJson(pkgPath);
  const bundles = pkg.dsh?.profile?.bundles ?? [];
  const hasDep = Object.hasOwn(pkg.dependencies ?? {}, name);

  if (add) {
    if (!hasDep) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backup = join(PROFILE_DIR, `package.json.bak-${stamp}-preinstall`);
      await writeFile(backup, await readFile(pkgPath), 'utf8');
      console.log(`已备份 package.json → ${backup}`);
    }
    pkg.dependencies = { ...(pkg.dependencies ?? {}), [name]: `file:${src.replace(/\\/g, '/')}` };
    if (!bundles.includes(name)) pkg.dsh.profile.bundles = [...bundles, name];
  } else {
    if (pkg.dependencies) delete pkg.dependencies[name];
    if (pkg.dsh?.profile?.bundles) {
      pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b) => b !== name);
    }
  }
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
}

async function syncFiles(src, target) {
  await rm(target, { recursive: true, force: true });
  await cp(src, target, {
    recursive: true,
    filter: (s) => !SKIP.has(s.split(/[\\/]/).pop()),
  });
}

async function report() {
  const pkg = await readJson(pkgPath);
  const bundles = pkg.dsh?.profile?.bundles ?? [];
  const self = join(MODULES, PKG_NAME);
  const dep = join(MODULES, DEP_NAME);
  const installed = existsSync(self);
  const depInstalled = existsSync(dep);
  const registered = bundles.includes(PKG_NAME);
  const depRegistered = bundles.includes(DEP_NAME);
  console.log(`profile      : ${PROFILE_DIR}`);
  console.log(`${PKG_NAME.padEnd(21)}: ${installed ? '已安装' : '未安装'}  bundles ${registered ? '已注册' : '未注册'}`);
  console.log(`${DEP_NAME.padEnd(21)}: ${depInstalled ? '已安装' : '未安装'}  bundles ${depRegistered ? '已注册' : '未注册'}`);
  return {
    installed, registered, depInstalled, depRegistered,
  };
}

if (mode === 'check') {
  await report();
  process.exit(0);
}

if (mode === 'remove') {
  // **只卸自己**：storyboard 可能是你单独装的，不该被陪看的卸载脚本顺手删掉
  await rm(join(MODULES, PKG_NAME), { recursive: true, force: true });
  await editProfile({ add: false, name: PKG_NAME });
  console.log('已卸载陪看。storyboard 保持原样。重启 DSH 生效（tool 会消失）。');
  await report();
  process.exit(0);
}

// 1) 自己
await syncFiles(HERE, join(MODULES, PKG_NAME));
await editProfile({ add: true, name: PKG_NAME, src: HERE });

// 2) 依赖（本包裸包名 import 的那一半）
//
// **默认只在缺失时补**。两个包是独立的仓库、独立的版本线，各有各的发版节奏：
// profile 里那份 storyboard 只要能解析到，陪看就能跑，没必要跟着 watch 一起更新 ——
// 无条件覆盖等于"改一句陪看的文案，顺手把别人正在改的分镜算法也同步进宿主"。
// 要强制一起更新（首次安装，或你确认过 storyboard 那边也一起上）：加 `--with-dep`。
const depInstalled = existsSync(join(MODULES, DEP_NAME));
const forceDep = process.argv.includes('--with-dep');

if (!existsSync(join(DEP_SRC, 'package.json'))) {
  console.warn(`\n⚠️  找不到 ${DEP_NAME} 的源码：${DEP_SRC}`);
  console.warn('   陪看在宿主里会 ERR_MODULE_NOT_FOUND。');
  console.warn('   解决：把两个仓库并排放，或设 DSH_STORYBOARD_SRC=<它的路径>。\n');
} else if (!depInstalled || forceDep) {
  await syncFiles(DEP_SRC, join(MODULES, DEP_NAME));
  await editProfile({ add: true, name: DEP_NAME, src: DEP_SRC });
  console.log(`依赖 ${DEP_NAME} 已同步（来自 ${DEP_SRC}）${forceDep && depInstalled ? '（--with-dep 强制）' : ''}`);
} else {
  console.log(`依赖 ${DEP_NAME} 已在 profile 里，保持不动（要一起更新加 --with-dep）`);
}

await report();
console.log('\n完成。重启 DSH Desktop 后生效（插件树在进程启动时组合）。');
