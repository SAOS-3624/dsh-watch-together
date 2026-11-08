/**
 * dep-contract.test.mjs — 本包到底从 storyboard 拿了什么。
 *
 * 依赖范围写的是 `^0.7.0`，意思是 `>=0.7.0 <0.8.0`（0.x 的 caret 只放小版本）。范围能成立的前提是
 * **"0.5.x 里这 15 个导出都还在、且还是函数"** —— 否则 range 再宽也只是自欺：
 * 少了导出的报错还算好看（`ERR_PACKAGE_PATH_NOT_EXPORTED`），
 * 更糟的是签名悄悄变了，本包不报错、只是行为不对。
 *
 * 所以这份清单是**唯一的事实来源**：删依赖就删这里一行，加依赖就加一行。
 * 它同时回答了"为什么版本不用和中台对齐"—— 对齐的从来不是版本号，是这张表。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const NEED = {
  // `runStoryboard` + `formatManifest`：一次陪看的全部产出
  pipeline: ['runStoryboard', 'formatManifest'],
  // `boardOptions` 决定几何（budget/need/cells），`charsForDetail` 决定每格给多少字
  board: ['boardOptions', 'charsForDetail'],
  // 清单的另一种组装方式（handler 单发路径用）
  format: ['formatManifest'],
  // 位置：配置端口、探浏览器、CDP 读数、判断是不是视频页
  'browser-time': [
    'configuredPort', 'probeBrowser', 'readBrowserPosition',
    'fileUrlToPath', 'hasDebugPort', 'looksLikeVideoUrl',
  ],
  // B 站登录态与字幕
  subtitles: ['checkBiliLogin', 'fetchRemoteSubtitles'],
  // 分镜缓存目录（watch.json / chat.jsonl / 段图都落在那里）
  cache: ['cacheDir'],
  // 段级别的"这段之前建过吗"
  locate: ['recallSegments'],
};

for (const [sub, names] of Object.entries(NEED)) {
  test(`storyboard/${sub} 仍然提供本包要的 ${names.length} 个导出`, async () => {
    let mod;
    try {
      mod = await import(`dsh-video-storyboard/${sub}`);
    } catch (e) {
      assert.fail(`dsh-video-storyboard/${sub} 解析失败（${e?.code ?? e?.message}）——`
        + '子路径被改名/删除，或装的版本低于 0.5.0');
    }
    for (const n of names) {
      assert.equal(typeof mod[n], 'function',
        `dsh-video-storyboard/${sub} 缺 ${n}（或被改成了非函数）`);
    }
  });
}

/**
 * 范围有没有覆盖"本仓库正对着的那个 storyboard"。
 *
 * 0.x 的 caret 不跨小版本：`^0.6.0` 解析成 `>=0.6.0 <0.7.0`，storyboard 一发 0.7.0
 * 就装不上了 —— 新装的人拿到 0.6.x，而本包是按 0.7 的导出写的（issue #60）。
 * 这条断言就是防它再悄悄烂掉：改版本号的人必须同时改这里。
 */
test('依赖范围覆盖同级 storyboard 的当前版本（0.x 的 caret 不跨小版本）', async () => {
  const { readFile } = await import('node:fs/promises');
  const { dirname, join, resolve } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const HERE = dirname(dirname(fileURLToPath(import.meta.url)));
  const sibling = resolve(HERE, '..', 'dsh-video-storyboard', 'package.json');

  let local;
  try {
    local = JSON.parse(await readFile(sibling, 'utf8')).version;
  } catch {
    return; // 并排仓库不在（从 npm 装的、CI 单独 checkout）—— 没得比，跳过
  }
  const range = JSON.parse(await readFile(join(HERE, 'package.json'), 'utf8'))
    .dependencies?.['dsh-video-storyboard'];
  if (!range) return;

  const m = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range.trim());
  assert.ok(m, `依赖范围只支持 caret 写法（收到 ${range}）`);
  const [, major, minor] = m.map(Number);
  const [lMajor, lMinor] = local.split('.').map(Number);
  if (major === 0) {
    assert.equal(lMinor, minor,
      `同级 storyboard 是 ${local}，而 package.json 写的是 ${range}`
      + `（0.x 下它只匹配 ${major}.${minor}.x）—— 发版前必须一起抬`);
  } else {
    assert.equal(lMajor, major, `同级 storyboard 是 ${local}，依赖范围是 ${range}`);
  }
});
