#!/usr/bin/env node
/**
 * watch.mjs — 陪看（一起看视频）**唯一入口**。这个文件就是全部说明书。
 *
 *   node watch.mjs doctor              环境自检（插件 / ffmpeg / 端口 / 登录）
 *   node watch.mjs start [url]         把带 9333 调试端口的浏览器弄起来
 *   node watch.mjs login               从浏览器直读 cookie 落盘 + 验 B 站登录
 *   node watch.mjs wait [秒]           等"用户真的放起了视频"，返回地址/标题/时长/位置
 *   node watch.mjs status              当前位置 + 当前段 + 该跑什么（新会话先跑这个）
 *   node watch.mjs seg [auto|from to] [cells] [detail]   出宫格 + 清单 + 句子时间轴
 *   node watch.mjs subs [from to]      只拉字幕时间轴（不出图，1 秒）
 *   node watch.mjs say "文本"          立刻念一句（系统 TTS）
 *   node watch.mjs cue '[[at,"词"],…]' [lateSec]         到点念，晚了就丢
 *
 * 陪看循环（一次一段）：
 *   status → seg auto → 看图 + 读 TIMELINE 写台词 → cue 挂到未来时间点
 *   → 同时 seg 预取下一段（6–14 秒）→ 用户看完这段再 status
 *
 * **台词锚点规则（唯一一条会毁掉体验的）**：
 *   - 评论"画面" → at 用该格 `frame@`
 *   - 评论"某句话/信息点" → at 用那句字幕的 `from`（seg 输出的 TIMELINE 里就是）
 *   - 宁可晚 2 秒，不能早 2 秒。早了就是剧透，用户会当场抓。
 *
 * 环境：端口 9333（9222 被别的应用占着）；cookie 文件见 COOKIES；产物落 .tmp/watch。
 */
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync, closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync,
  readSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';



import {
  configuredPort, hasDebugPort, launchBrowser, listTargets, waitForPort, readBrowserPosition,
  readBrowserCookies, cookiesToNetscape, looksLikeVideoUrl, fileUrlToPath,
} from 'dsh-video-storyboard/browser-time';
import { checkBiliLogin, fetchRemoteSubtitles } from 'dsh-video-storyboard/subtitles';
import { runStoryboard, formatManifest } from 'dsh-video-storyboard/pipeline';
import { boardOptions, charsForDetail } from 'dsh-video-storyboard/board';
import { DEFAULT_LOOKAHEAD, makePlan, windowFor } from '../src/batches.js';
import { DEFAULT_CHAT_PORT, chatFile } from '../src/chat.js';
import { bridgeStatus, readHello } from '../src/position-bridge.js';
import { readPositionOrNull } from '../src/watch-browser.js';
import { lineNear, speechLag } from '../src/speech.js';
import {
  configuredDshTts, defaultEdgeTtsBin, speak, speakViaEdgeTts,
} from './tts.mjs';

export { speechLag };

// 陪看依赖的视频识别包。**按包名解析**，不要拼路径 —— 拼路径的话换个安装方式就断
// （实际踩过：这里的检查原来写死 `<仓库>/src/pipeline.js`，重构把 pipeline 挪进
//  `src/storyboard/` 之后，doctor 就一直报 FAIL plugin，而插件本身是好的）。
const STORYBOARD = (() => {
  try {
    // 特意解析 `pipeline` 这个子路径，而不是包根：子路径靠 package.json 的 `exports` 表，
    // 少了那一条 CLI 就起不来，而包根仍然能解析 —— 这才是真正会坏的地方。
    return fileURLToPath(import.meta.resolve('dsh-video-storyboard/pipeline'));
  } catch {
    return null;
  }
})();

// 下面这三个默认值**只有这个 CLI 用得到**，插件本体（watch_together）完全不依赖它们。
//
// 规矩：`WATCH_*` 环境变量最优先；没设就看作者本机那套布局在不在（在就沿用，别人机器上不存在，
// 自然落到 `~/.dsh/watch`）；最后才是 `~/.dsh/watch`。
// 以前这里写死 `D:/deepseek/3-Life`，别人装上会去一个不存在的目录里找 cookie、往那儿写图。
const LEGACY_WORK = 'D:/deepseek/3-Life';
const WORK = process.env.WATCH_WORK
  || (existsSync(LEGACY_WORK) ? LEGACY_WORK : join(homedir(), '.dsh', 'watch'));
const COOKIES = process.env.WATCH_COOKIES
  || (WORK === LEGACY_WORK ? `${LEGACY_WORK}/.secrets/bili-cookies.txt` : join(WORK, 'bili-cookies.txt'));
const OUT = process.env.WATCH_OUT
  || (WORK === LEGACY_WORK ? `${LEGACY_WORK}/.tmp/watch` : join(WORK, 'out'));
const PORT = Number(process.env.WATCH_PORT) || configuredPort() || 9333;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tc = (t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${(t % 60).toFixed(1).padStart(4, '0')}`;
const pad = (n) => String(Math.max(0, Math.round(n))).padStart(4, '0');

function ps(cmd) {
  try {
    return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd],
      { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  } catch (e) {
    return `ERR:${String(e?.message ?? e).slice(0, 160)}`;
  }
}

/**
 * 读播放位置。**只有一个来源**：浏览器调试端口里那个 `<video>` 的 `currentTime`。
 *
 * 这里以前还有一路"系统媒体控件（SMTC）"兜底 —— 2026-10-30 删了：
 * 它只在事件发生时刷新（实测两次刷新隔过 143、216 秒），拿它当实时位置必须外推，
 * 外推就会猜错，而猜错一次后面每一段都是错的。
 *
 * @returns {Promise<{pos:number,dur:number|null,title:string|null,paused:boolean,url:string|null}|null>}
 */
async function pos() {
  // 两条通道都试：CDP 优先，其次浏览器扩展上报的（见 position-bridge.js）。
  // CLI 是**另一个进程**，所以扩展上报的位置只能从磁盘上那个小 json 读。
  // 前提是有人起着 9377 服务（`node watch.mjs chat`，或者 DSH 里的插件）；
  // 否则扩展没地方上报，这条通道就是空的。
  const b = await readPositionOrNull(
    (o) => readBrowserPosition({ ...o, timeoutMs: 900 }), PORT,
  ).catch(() => null);
  return b;
}

/**
 * 从位置结果推出**这次在看什么** —— 页面地址就是源。
 *
 * 以前 SMTC 只给标题、不给地址，所以还有一条"按标题反查（本地文件名 → B 站搜索）"
 * 的路，最慢能到 90 秒，还会搜到同名的另一条片子。SMTC 删掉后这条路一起没了：
 * **没有地址就是没有源**，直接让用户给，不猜。
 */
const inputCache = new Map();
async function inputFor(s) {
  if (!s?.url) return null;
  const key = s.url;
  if (!inputCache.has(key)) inputCache.set(key, normalizeInput(s));
  return inputCache.get(key);
}

/**
 * 当前页是不是就是目标页（避免每次 start 都多开一个标签）
 */
function sameTarget(cur, url) {
  if (!cur?.url || !url) return false;
  try {
    const a = new URL(normalizeInput({ url: cur.url }));
    const b = new URL(url);
    const norm = (p) => p.replace(/\/+$/, '');
    return a.host === b.host && norm(a.pathname) === norm(b.pathname);
  } catch { return false; }
}

/**
 * 端口有三种状态，混为一谈会误杀正常在看视频的浏览器：
 *   alive  —— CDP 应 200，正常
 *   zombie —— TCP 能连上但 CDP 不应答（进程已死、socket 没释放，netstat 里 pid=0）
 *   down   —— 连都连不上
 * zombie 只能 Stop 掉任务再 Start，否则 Start 会因为"任务已在运行"被忽略。
 */
async function portState() {
  if (await hasDebugPort({ port: PORT })) return 'alive';
  const tcp = await new Promise((res) => {
    const s = net.connect({ port: PORT, host: '127.0.0.1' });
    const done = (v) => { try { s.destroy(); } catch { /* 已断开 */ } res(v); };
    s.setTimeout(700);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
  return tcp ? 'zombie' : 'down';
}

/**
 * 把浏览器弄起来。**默认就走计划任务**，不再"先失败两次再降级"。
 *
 * 旧顺序（先 schtasks.exe 再 spawn）的实测代价：schtasks.exe 在本机是程序黑名单程序，
 * 直接报 PROGRAM BLOCKED；退回 spawn 出去的 Edge 又被调用方的 Job Object 回收
 * —— 用户看到的就是"浏览器刚开就被关掉"。现在 launchBrowser 内部已经把
 * PowerShell 计划任务排到第一位，这里不再重复试错。
 */
async function ensureBrowser({ url = null } = {}) {
  const state = await portState();
  if (state === 'alive') {
    const cur = await pos();
    if (url && !sameTarget(cur, url)) await openTab(url);
    return { up: true, via: 'already-up' };
  }

  if (state === 'zombie') {
    // 只剩一个死 socket：先清掉任务状态，否则 Start 会被当成"已在运行"
    for (const t of [`DSH-Edge-Watch-${PORT}`, 'DSH-Edge-Watch']) {
      ps(`$ErrorActionPreference='SilentlyContinue'; Stop-ScheduledTask -TaskName '${t}'`);
    }
    await sleep(1200);
  }

  const r = launchBrowser({ port: PORT, url: url ?? '' });
  let up = await waitForPort(PORT, { timeoutMs: r.ok ? 15_000 : 4_000 });

  // 任务存在但上次是异常退出 → 停一次再起
  if (!up) {
    for (const t of [`DSH-Edge-Watch-${PORT}`, 'DSH-Edge-Watch']) {
      ps(`$ErrorActionPreference='SilentlyContinue'; Stop-ScheduledTask -TaskName '${t}'; Start-ScheduledTask -TaskName '${t}'`);
    }
    up = await waitForPort(PORT, { timeoutMs: 12_000 });
  }

  if (up && url) {
    // 启动时已经把 url 交给浏览器了（它自己会打开），但**页面加载完需要时间**。
    // 以前这里立刻判断一次：读到的是 about:blank，`sameTarget` 不成立，于是又 openTab 一次 ——
    // 同一个视频开两个标签，标签栏越用越乱。现在给它一点时间，确认真的没开再补。
    let opened = false;
    for (let i = 0; i < 10; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const cur = await pos();
      if (sameTarget(cur, url)) { opened = true; break; }
      // eslint-disable-next-line no-await-in-loop
      await sleep(400);
    }
    if (!opened) await openTab(url);
  }

  // 退到 spawn 说明计划任务这条路不通 —— 那它随时会被回收，别假装成功
  if (up && r.via === 'spawn') {
    await sleep(3000);
    if (!(await hasDebugPort({ port: PORT }))) {
      return {
        up: false, via: 'spawn-reclaimed',
        note: '计划任务不可用，spawn 出去的浏览器被 Job Object 回收了；检查 PowerShell 是否可用',
      };
    }
  }
  return { up, via: r.via ?? (up ? 'unknown' : 'failed'), task: r.task ?? null, note: r.reason ?? null };
}

/** 浏览器里是不是已经有这个地址的标签了（避免每次 start 都堆一个重复页） */
async function hasTab(url) {
  const ts = await listTargets({ port: PORT }).catch(() => null);
  return (ts ?? []).some((t) => t.type === 'page' && String(t.url ?? '').startsWith(url));
}

/** 在已在运行的调试浏览器里新开一个标签（任务里写死的 URL 不可靠，用这个补） */
async function openTab(url) {
  if (!url) return false;
  for (const init of [{ method: 'PUT' }, { method: 'GET' }]) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, init);
      if (res.ok) return true;
    } catch { /* 换下一种方法 */ }
  }
  return false;
}

/** 当前段 + 上一段/下一段（段边界来自插件自己的批次表，别在外面另算一套） */
function segmentInfo(p, dur) {
  const plan = makePlan({});
  const cur = plan.segmentAt(p);
  const total = Number.isFinite(dur) && dur > 0 ? dur : null;
  const remain = total ? Math.max(0, total - p) : null;
  // 离段末不足 20 秒时，出"下一段"更有用（当前段马上过完）
  // 阈值 30 秒：建图要十几秒，剩太少的段建完就过期了
  const target = cur.to - p < 30 && (!total || cur.to < total) ? plan.segmentAt(cur.to) : cur;
  return { plan, cur, target, remain };
}

/**
 * 把页面地址收敛成"稳定的源标识"。
 *
 * B 站视频页的 URL 后面挂着一串每次刷新都变的 trackid / spm_id_from / vd_source，
 * 直接拿它算指纹，同一个视频会算出几十个不同的 key，缓存永远命不中。
 * 所以只取到 BV 号为止；其他站点原样保留（YouTube 的 ?v= 就是视频本身，不能切）。
 */
function normalizeInput(s) {
  const raw = fileUrlToPath(s.url) || s.url;
  if (!/^https?:/i.test(raw)) return raw;
  const m = raw.match(/^(https?:\/\/(?:www\.)?bilibili\.com\/video\/[A-Za-z0-9]+)/i);
  return m ? m[1] : raw;
}

/**
 * 产物按**源**分目录命名。
 *
 * 为什么必须带源的指纹：文件名原来只有 `seg_0180-0360.png`，用户换一条视频后，
 * 同号段会被判成"已有 → 直接复用"，于是把上一条片子的画面端给下一条看。
 * 实测撞过：换片后 `seg 180 360` 拿回来的是上一支视频的图，字幕却是新视频的。
 */
function srcKey(input) {
  return createHash('md5').update(String(input ?? '')).digest('hex').slice(0, 6);
}

function segBase(input, from, to) {
  return `${OUT}/seg_${srcKey(input)}_${pad(from)}-${pad(to)}`;
}

// ---------------------------------------------------------------- 命令

// ---------------------------------------------------------------- 装扩展

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** 把扩展复制到一个**稳定的**位置：仓库挪走/删掉都不影响已经装好的扩展 */
function extensionTarget() {
  const base = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  return join(base, 'dsh-watch-together', 'extension');
}

/** 找浏览器。顺序和 launchBrowser 一致，别自己发明 */
function findBrowser() {
  const CANDIDATES = [
    ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'edge'],
    ['C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'edge'],
    ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'chrome'],
    ['C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', 'chrome'],
  ];
  for (const [exe, kind] of CANDIDATES) {
    if (existsSync(exe)) return { exe, kind };
  }
  return null;
}

/**
 * 装扩展：**能自动的都自动，剩下三下必须你点**。
 *
 * 为什么不能全自动：从 Chrome 137 起，正式版浏览器**移除了** `--load-extension`
 * （`--enable-unsafe-extension-debugging` 也救不回来），而扩展设置存在一个带 HMAC 的
 * 文件里，外部程序改不动。这是浏览器故意的 —— 能静默装扩展的通道就是恶意软件用的通道。
 * 所以最后"选文件夹 + 点确定"只能人来做。
 *
 * 这个命令负责把其它的都干掉：复制到固定路径、路径塞进剪贴板、帮你打开扩展管理页。
 */
const STEPS = [
  '  1. 打开浏览器的扩展管理页：Edge 输入 edge://extensions ，Chrome 输入 chrome://extensions',
  '     把「开发人员模式」/「开发者模式」的开关打开（Edge 在左下角，Chrome 在右上角）',
  '  2. 点「加载解压缩的扩展」/「加载已解压的扩展程序」',
  '  3. 弹出的选择框里，把上面「扩展位置」那条路径粘到地址栏 → 回车 → 点「选择文件夹」',
  '     ⚠ 那个框只显示文件夹，看不到 manifest.json 是正常的 —— 别因此以为文件丢了；',
  '     ⚠ 也别点进 icons 里面再选，要在 extension 这一层选。',
];

function printSteps(dst, { clipOk = false } = {}) {
  console.log('');
  console.log(`  扩展位置：${dst}`);
  console.log(`            ${clipOk ? '（已经复制到剪贴板，第 3 步直接 Ctrl+V）' : '（没能复制到剪贴板，请手动抄下这条路径）'}`);
  console.log('');
  // 别写死下标 —— 步骤文本一改就漏印（第一版就漏了第 3 步）
  for (const line of STEPS) console.log(line);
  console.log('');
  console.log('装完点工具栏上的蓝色图标：显示「已连上」就成。');
  console.log('');
  console.log('> 看不到图标？点右上角拼图图标 🧩，把「陪看位置桥」固定出来。');
  console.log('> 以前从仓库目录装过旧版的，先把那张旧卡片「移除」，否则会有两个。');
}

/**
 * 装完之后**一直等着**，直到能确认扩展真的装上了。
 *
 * 为什么要等：装扩展这件事有两个"没有反馈"的死角 ——
 *   ① 用户没点完就以为做完了；
 *   ② 点完了但扩展报错没加载，看起来和没装一样。
 * 两个死角都表现为"窗口没反应"。所以这里不猜、不催，就一直轮询到有证据为止：
 *   有心跳 = 扩展加载了；有位置 = 连视频都通了。
 * 窗口也因此**不会一闪就没** —— 它还在忙。
 */
async function waitUntilInstalled() {
  const { startChatServer, chatAlive } = await import('../src/chat.js');
  let srv = null;
  try {
    srv = await startChatServer({ port: DEFAULT_CHAT_PORT });
  } catch {
    if (!(await chatAlive(DEFAULT_CHAT_PORT))) {
      console.log('（提示：本机 9377 端口被别的程序占着，我没法确认。装完点一下扩展图标也能看。）');
    }
  }

  console.log('现在去浏览器里点那三下。这个窗口会一直等着，装好了它自己会说。');
  console.log('');

  const started = Date.now();
  const deadline = started + 10 * 60_000;
  let announcedHello = false;
  let lastNudge = started;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  while (Date.now() < deadline) {
    const bs = await bridgeStatus().catch(() => null);
    if (bs?.fresh) {
      console.log('');
      console.log('='.repeat(52));
      console.log('  ✅ 全部完成');
      console.log(`     正在读到：${bs.title ?? '(没有标题)'} @ ${tc(bs.pos)}`);
      console.log('     以后正常开浏览器就行，这个窗口可以关掉了。');
      console.log('='.repeat(52));
      if (srv) await srv.close().catch(() => {});
      return 0;
    }

    const h = await readHello().catch(() => null);
    if (h && !announcedHello) {
      announcedHello = true;
      console.log(`✓ 扩展装上了（v${h.version ?? '?'}）。`);
      console.log('  再打开一个视频、按播放 —— 通了我会立刻告诉你。');
      console.log('');
    } else if (!h && Date.now() - lastNudge > 30_000) {
      lastNudge = Date.now();
      console.log(`  还在等…（${Math.round((Date.now() - started) / 1000)} 秒）如果已经点完了还是这里没动静，`);
      console.log('  看扩展管理页上那张卡片有没有红色「错误」，或者把它的开关关掉再打开。');
    }
    await sleep(2000);
  }

  console.log('');
  console.log('10 分钟没等到。要么还没装，要么装的时候出错了。');
  console.log('重新看一遍步骤：node bin/watch.mjs install-extension --steps');
  if (srv) await srv.close().catch(() => {});
  return 1;
}

/** 扩展必须有这些（少一个浏览器就会报"清单文件缺失"） */
const REQUIRED = ['manifest.json', 'content.js', 'background.js'];

/**
 * 逐个文件复制并**立刻核对落地的结果**。
 *
 * 为什么不用一句 `cpSync(src, dst, {recursive:true})`：那样一旦中途失败（杀毒软件
 * 把 .js 拦掉、文件被占用、权限不够），要么整体抛错、要么留下一个不完整的目录，
 * 而用户看到的症状是"浏览器说清单文件缺失" —— 根本不知道少了什么。
 * 这里逐个 copy、逐个核对大小，缺哪个就报哪个。
 */
function copyExtension(src, dst) {
  const rows = [];
  mkdirSync(dst, { recursive: true });
  for (const ent of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, ent.name);
    const to = join(dst, ent.name);
    try {
      cpSync(from, to, { recursive: true, force: true });
      const size = statSync(to).size;
      if (size === 0 && ent.isFile()) throw new Error('文件是空的（多半被杀毒软件清掉了）');
      rows.push({ name: ent.name, ok: true, size });
    } catch (e) {
      rows.push({ name: ent.name, ok: false, err: String(e?.message ?? e) });
    }
  }
  return rows;
}

/**
 * 检查一个目录是不是"能装"的扩展目录。
 * 之所以能单独跑（`--verify`）：用户手上那个文件夹到底缺什么，得有一个不猜的答案。
 */
function inspectExtension(dir) {
  if (!existsSync(dir)) return { ok: false, reason: '目录不存在', rows: [] };
  const names = readdirSync(dir);
  const rows = names.map((n) => {
    const full = join(dir, n);
    try {
      const st = statSync(full);
      // 目录的 size 在 Windows 上经常是 0 —— 不能拿它判断"空"。
      // 目录要看里面有没有东西。
      if (st.isDirectory()) {
        const inner = readdirSync(full).length;
        return { name: `${n}/`, ok: inner > 0, size: inner, dir: true };
      }
      return { name: n, ok: st.size > 0, size: st.size };
    } catch {
      return { name: n, ok: false, size: 0 };
    }
  });
  const missing = REQUIRED.filter((r) => !names.includes(r));
  const empty = rows.filter((r) => !r.ok).map((r) => r.name);
  return { ok: missing.length === 0 && empty.length === 0, missing, empty, rows };
}

function reportInspect(dir, info) {
  console.log(`  检查目录：${dir}`);
  if (!existsSync(dir)) {
    console.log('  ✗ 这个目录不存在。先跑一次 install-extension（不带 --verify）。');
    return;
  }
  if (info.rows.length === 0) {
    console.log('  ✗ 目录是空的。');
  } else {
    const shown = info.rows.map((r) => `${r.ok ? '✓' : '✗'} ${r.name}${r.ok
      ? (r.dir ? ` (${r.size} 个文件)` : ` (${r.size} B)`)
      : ' (空/读不到)'}`);
    console.log(`  ${shown.join('\n  ')}`);
  }
  if (info.missing.length > 0) {
    console.log(`  ✗ 缺关键文件：${info.missing.join(', ')}`);
  }
  if (info.empty.length > 0) {
    console.log(`  ✗ 空的文件：${info.empty.join(', ')}`);
  }
  if (!info.ok) {
    console.log('');
    console.log('  这种情况 90% 是**杀毒软件把 .js 当脚本拦掉了**（扩展目录 + js，很像"可疑脚本"）。');
    console.log('  处理：把这个目录加进杀毒的信任区，然后重跑一次 install-extension。');
    console.log('  也可能只是没复制成功 —— 重跑一次通常就好。');
  }
}

async function cmdInstallExtension(opts = {}) {
  // --verify 可以带一个目录：检查**任意**一个文件夹（用户手上那个可能不在默认位置）
  const dst = opts.verifyDir || extensionTarget();

  // 只检查、不动文件：回答"我手上这个文件夹到底能不能装"
  if (opts.verifyOnly) {
    const info = inspectExtension(dst);
    reportInspect(dst, info);
    if (info.ok) {
      console.log('');
      console.log('  ✓ 这个目录是完整的，可以「加载解压缩的扩展」。');
      console.log('    提示：浏览器的文件夹选择框里**可能只列子文件夹**（看不到 manifest.json 是正常的），');
      console.log('    直接选中这个目录点「选择文件夹」就行，不用管列表里显示什么。');
    }
    return info.ok ? 0 : 1;
  }

  // 只打印步骤：用户随时可以再问一次"到底点哪"
  if (opts.stepsOnly) {
    printSteps(dst, { clipOk: false });
    console.log('');
    console.log('（这条路不会再复制文件。第一次装请不加 --steps 跑一遍。）');
    return 0;
  }

  const src = join(PKG_ROOT, 'extension');
  if (!existsSync(join(src, 'manifest.json'))) {
    console.log(`找不到扩展源码：${src}\n（这个命令得在装好的包里跑）`);
    return 1;
  }

  try {
    mkdirSync(dirname(dst), { recursive: true });
    rmSync(dst, { recursive: true, force: true });
  } catch (e) {
    console.log(`清理旧目录失败：${String(e?.message ?? e)}\n（目标：${dst}）`);
    return 1;
  }

  const rows = copyExtension(src, dst);
  const failed = rows.filter((r) => !r.ok);
  const info = inspectExtension(dst);
  // 两个路径都打出来：用户报障时，源和目标哪个不对一眼就能看出来
  console.log(`  来源：${src}`);
  console.log(`  目标：${dst}`);
  console.log(`  已复制 ${rows.length - failed.length}/${rows.length} 项`);
  if (failed.length > 0 || !info.ok) {
    console.log('');
    console.log('  ✗ 复制没完成，这个目录现在**装了也会报错**：');
    reportInspect(dst, info);
    return 1;
  }

  // 路径塞剪贴板：第 3 步要粘到"选择文件夹"的地址栏里
  let clipOk = true;
  try {
    execFileSync('clip', [], { input: dst, timeout: 5000 });
  } catch { clipOk = false; }

  const br = findBrowser();
  let opened = false;
  if (br && opts.open !== false) {
    try {
      spawn(br.exe, [`${br.kind}://extensions`], { detached: true, stdio: 'ignore' }).unref();
      opened = true;
    } catch { /* 开不开得起来都不影响后面 */ }
  }

  console.log('');
  console.log('文件准备好了。剩下三下必须你亲手点 ——');
  console.log('浏览器不允许任何程序偷偷装扩展（这是防恶意软件的，绕不过去）。');
  if (opened) {
    console.log(`（已经帮你打开了 ${br.kind}://extensions）`);
  }
  printSteps(dst, { clipOk });

  // 有交互终端就**接着等**到装好为止：窗口一直在忙，所以不会一闪而过，
  // 而且用户不需要自己判断"我装成了没有"。
  // 非交互（脚本/AI 调用）就到此为止，别把调用方挂住。
  const shouldWait = opts.wait === true || (process.stdin.isTTY && opts.wait !== false);
  if (!shouldWait) return 0;
  return await waitUntilInstalled();
}

/**
 * 只起"接位置"的那个服务，不陪看、不出图 —— 专门用来**验证扩展装好没有**。
 *
 * 为什么需要它：扩展是往 9377 上报的，而这个服务平时只在 DSH 陪看期间、
 * 或者 `watch.mjs chat` 时才有。用户刚装完扩展就点图标，看到的必然是"未连上"，
 * 然后以为自己装错了。这条命令把那个变量消掉：起服务、等一条上报、确认通了。
 */
async function cmdBridge(arg) {
  const port = Number(arg) || Number(process.env.WATCH_PORT) || DEFAULT_CHAT_PORT;
  const { startChatServer, chatAlive } = await import('../src/chat.js');

  let srv = null;
  try {
    srv = await startChatServer({ port });
  } catch (e) {
    if (await chatAlive(port)) {
      console.log(`端口 ${port} 上已经有一个服务在跑，直接用它。`);
    } else {
      console.log(`起不来（${String(e?.message ?? e)}）。端口被别的程序占了？换一个：node watch.mjs bridge 9378`);
      return 1;
    }
  }

  console.log(`接位置的服务已启动： http://127.0.0.1:${port}`);
  console.log('这个窗口别关。');
  console.log('');
  console.log('接下来的判断，全靠这个窗口自己说 —— 它每 3 秒检查一次，');
  console.log('会明确告诉你是"扩展没装"还是"扩展装了但没在播"。');
  console.log('（按 Ctrl+C 退出）');
  console.log('');

  let lastStage = null;
  let okOnce = false;

  const stage = async () => {
    const bs = await bridgeStatus().catch(() => null);
    if (bs?.fresh) return { kind: 'ok', bs };
    const h = await readHello().catch(() => null);
    if (h) return { kind: 'no-video', h };
    return { kind: 'no-extension' };
  };

  const explain = {
    ok: (x) => `✓ 收到上报：${x.bs.title ?? '(没有标题)'} @ ${tc(x.bs.pos)}`,
    'no-video': (x) => [
      `… 扩展已经连上了（版本 ${x.h.version ?? '?'}，${Math.round(x.h.ageMs / 1000)} 秒前打过招呼），`,
      '  但还没收到播放位置。三种可能：',
      '   · 当前标签页里没有正在播的视频 → 点开一个视频、按播放；',
      '   · 视频暂停着 → 陪看只在播放时更新位置（暂停时不动是正常的）；',
      '   · 播放器嵌在别人的网页里（iframe）→ 这种读不到，只能用 start-edge-debug.cmd。',
    ].join('\n'),
    'no-extension': () => [
      '… 还没收到扩展的任何消息。说明扩展**没有被加载**，不是位置的问题。',
      '  照这个顺序查：',
      '   1. 浏览器地址栏输入 edge://extensions —— 列表里有「陪看位置桥」吗？',
      '      没有 → 还没装，跑：node watch.mjs install-extension --steps',
      '   2. 有，但开关是灰的 → 点一下把它打开；',
      '   3. 有、也开着，但这里还是没消息 → 把扩展那张卡片上的「重新加载」点一下。',
    ].join('\n'),
  };

  const timer = setInterval(async () => {
    const st = await stage();
    if (st.kind === 'ok') {
      if (!okOnce) {
        okOnce = true;
        console.log(explain.ok(st));
        console.log('  通了。以后正常开浏览器就行，这个窗口可以关掉。');
      }
      lastStage = 'ok';
      return;
    }
    // 一旦通过就不再唠叨：位置文件 5 秒过期，用户暂停一下就会变回"没有位置"，
    // 这时候再刷一遍「三种可能」纯属添乱。
    if (okOnce) return;
    // 只在这一阶段第一次出现时说一遍，别每 3 秒刷一次同样的字
    if (st.kind !== lastStage) {
      lastStage = st.kind;
      console.log(explain[st.kind](st));
      console.log('');
    }
  }, 3000);

  await new Promise(() => {});
  clearInterval(timer);
  if (srv) await srv.close();
  return 0;
}

async function cmdDoctor() {
  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok, detail });

  add('plugin', Boolean(STORYBOARD), STORYBOARD ?? 'dsh-video-storyboard 没装（npm i dsh-watch-together 会带上它）');
  add('cookie-file', existsSync(COOKIES), COOKIES);

  let ff = '';
  try { ff = execFileSync('ffmpeg', ['-version'], { encoding: 'utf8', timeout: 8000 }).split('\n')[0]; } catch { /* 下面报 */ }
  add('ffmpeg', Boolean(ff), ff.slice(0, 60) || 'not on PATH (set DSH_FFMPEG_PATH)');

  /*
   * 位置只有**一条**路：浏览器调试端口里那个 `<video>` 的 `currentTime`。
   *
   * 它本身就是 ready 的硬条件 —— 没有端口就没有位置，没有位置就没有陪看。
   * Chromium 136+ 不允许在默认 profile 上开调试端口，所以那个窗口必然是独立的
   * （scripts/start-edge-debug.cmd 就是为它准备的，双击即可）。
   */
  const port = await hasDebugPort({ port: PORT });
  add('debug-port', port, `${PORT}${port ? '' : ' —— 没开（装了浏览器扩展就不用开）'}`);

  // 浏览器扩展那条通道：只要它在报，就不需要调试端口
  //
  // 三种情况必须分开说，否则用户没法判断该修什么：
  //   在报位置        → 全通
  //   只打过招呼      → 扩展装了、能连上服务，问题在"这个页面没视频"
  //   连招呼都没有    → 扩展根本没加载（没装 / 没启用 / 装错目录）
  const bs = await bridgeStatus().catch(() => null);
  const hello = await readHello().catch(() => null);
  add('extension', Boolean(bs?.fresh),
    bs?.fresh
      ? `正在上报 ${tc(bs.pos)} · ${bs.title ?? ''}`.trim()
      : (hello
        ? `扩展已加载（v${hello.version ?? '?'}，${Math.round(hello.ageMs / 1000)} 秒前连上），但还没有视频在播`
        : '扩展没加载 —— 没装 / 没启用，跑 install-extension --steps 看步骤'));

  let login = null;
  if (existsSync(COOKIES)) {
    login = await checkBiliLogin({ cookies: COOKIES }).catch(() => null);
    add('bili-login', Boolean(login?.ok), login?.ok ? login.uname : (login?.reason ?? 'unknown'));
  }

  const p = await pos();
  add('playing', Boolean(p),
    p ? `${p.title ?? '(没有标题)'} @${tc(p.pos)}`
      : '读不到：调试端口没开，或者页面里没有 <video>');

  const required = ['plugin', 'cookie-file', 'ffmpeg'];
  const hardOk = checks.filter((c) => required.includes(c.name)).every((c) => c.ok);
  // 位置只要有一条通就行：调试端口，或者浏览器扩展在报
  const canLocate = port || Boolean(bs?.fresh);

  console.log(checks.map((c) => `${c.ok ? 'OK  ' : 'FAIL'} ${c.name.padEnd(12)} ${c.detail}`).join('\n'));

  if (!hardOk) {
    console.log(`\nNOT READY — 先修 FAIL 项。${existsSync(COOKIES) ? '' : 'cookie 没有就跑: node watch.mjs login'}`);
    return 1;
  }
  if (!canLocate) {
    console.log('\nNOT READY — 两条位置通道都不通：\n'
      + '  · 装浏览器扩展（docs/BRIDGE.zh.md，一次就好），或者\n'
      + `  · 双击 scripts/start-edge-debug.cmd 起一个带调试端口的窗口（端口 ${PORT}）`);
    return 1;
  }
  console.log(`\nREADY — ${p ? `正在放 ${tc(p.pos)}（来源 ${p.source === 'bridge' ? '浏览器扩展' : '调试端口'}）` : '通道通了，但页面上还没有 <video>'}`
    + '，下一步: node watch.mjs wait 150');
  return 0;
}

async function cmdStart(url) {
  const r = await ensureBrowser({ url: url || 'https://www.bilibili.com/' });

  // 顺手把陪看页开出来：不然每次都得手动敲 127.0.0.1:9377
  let chatTab = 'service-down';
  if (r.up) {
    const alive = await fetch(`http://127.0.0.1:${CHAT_PORT}/`, { method: 'HEAD' })
      .then((x) => x.ok).catch(() => false);
    if (alive) {
      const tabUrl = `http://127.0.0.1:${CHAT_PORT}/`;
      chatTab = (await hasTab(tabUrl)) ? 'already-open' : (await openTab(tabUrl) ? 'opened' : 'failed');
    }
  }

  const p = r.up ? await pos() : null;
  console.log(JSON.stringify({
    ...r, port: PORT,
    chatTab,
    hint: chatTab === 'service-down'
      ? '聊天框服务没起：先用后台任务跑 node watch.mjs chat'
      : null,
    page: p ? { url: p.url, title: p.title, pos: +p.pos.toFixed(1), paused: p.paused } : null,
  }, null, 1));
  return r.up ? 0 : 1;
}

async function cmdLogin() {
  const raw = await readBrowserCookies({ port: PORT });
  if (!raw) { console.log('FAIL 读不到浏览器 cookie —— 浏览器没开或没开调试端口，先跑 start'); return 1; }
  const bili = raw.filter((c) => /bilibili|bilivideo/i.test(c.domain ?? ''));
  mkdirSync(COOKIES.replace(/[/\\][^/\\]+$/, ''), { recursive: true });
  writeFileSync(COOKIES, cookiesToNetscape(bili), 'utf8');
  const login = await checkBiliLogin({ cookies: COOKIES });
  console.log(JSON.stringify({ cookies: bili.length, path: COOKIES, login }, null, 1));
  return login?.ok ? 0 : 1;
}

async function cmdWait(maxSec = 120) {
  const until = Date.now() + Number(maxSec) * 1000;
  let last = '';
  while (Date.now() < until) {
    const s = await pos();
    if (s) {
      const isVideo = looksLikeVideoUrl(s.url) || Boolean(fileUrlToPath(s.url));
      const tag = `${s.url}|${isVideo}`;
      if (tag !== last) {
        last = tag;
        console.log(`${isVideo ? 'VIDEO' : 'page '} ${s.title}  pos=${tc(s.pos)} paused=${s.paused}`);
      }
      if (isVideo && (!s.paused || s.pos > 0.5)) {
        console.log(JSON.stringify({
          ready: true, url: s.url, file: fileUrlToPath(s.url), title: s.title,
          pos: +s.pos.toFixed(1), dur: s.dur, paused: s.paused,
        }, null, 1));
        return 0;
      }
    }
    await sleep(1500);
  }
  console.log(JSON.stringify({ ready: false, reason: 'timeout', waitedSec: Number(maxSec) }, null, 1));
  return 1;
}

async function cmdStatus() {
  const s = await pos();
  if (!s) { console.log('读不到位置。两条通道都没有：\n'
    + '  ① 浏览器扩展没在报（没装 / 没启用 / 陪看服务没在跑 → 见 docs/BRIDGE.zh.md）\n'
    + '  ② 调试端口也没开（双击 scripts/start-edge-debug.cmd 可以临时顶上）\n'
    + '  跑 doctor 能看到具体是哪一环断了。'); return 1; }
  const { plan, cur, remain } = segmentInfo(s.pos, s.dur);
  const nxt = plan.segmentAt(cur.to);
  const src = await inputFor(s);
  // src 可能为 null（页面地址不是视频页，比如 B 站首页）。
  // 这时候不能拿 null 去算产物文件名 —— md5("null") 会指向一个不存在的 key，
  // 于是"图已建好"永远为假。干脆如实说"不知道源"，别假装查过了。
  const have = (seg) => Boolean(src) && existsSync(`${segBase(src, seg.from, seg.to)}.png`);

  // 余量：从当前段往后，**连续**建好的段能覆盖到哪。
  // 这个指标是插件的 windowFor 定义的（DEFAULT_LOOKAHEAD = 300），CLI 以前完全没搬 ——
  // 结果模型只能一段一段补，余量长期停在 1.5–2.5 分钟，还误以为"预取过了"。
  // 窗口必须按**视频时长**截断：windowFor 不知道片子多长，会一直往片尾后面排，
  // 于是 5 分 31 秒的片子也会算出 "06:00–10:00" 这种不存在的段。
  const dur = Number.isFinite(s.dur) && s.dur > 0 ? s.dur : Infinity;
  // 查文件要用**原始**段（磁盘上就是 0180-0360），截断只用于算"还能撑多久"。
  const win = windowFor(plan, s.pos, DEFAULT_LOOKAHEAD).filter((seg) => seg.from < dur);
  let bufTo = s.pos;
  let ready = 0;
  for (const seg of win) {
    if (!have(seg)) break;
    bufTo = Math.min(seg.to, dur);
    ready += 1;
  }
  const buffer = Math.max(0, bufTo - s.pos);
  const atEnd = bufTo + 0.5 >= dur;
  const short = buffer + 0.5 < DEFAULT_LOOKAHEAD && !atEnd;
  const mmss = (x) => `${Math.floor(x / 60)}m${String(Math.round(x % 60)).padStart(2, '0')}s`;

  console.log([
    `title  ${s.title}`,
    `pos    ${tc(s.pos)}${s.paused ? '  (PAUSED)' : ''}   dur ${tc(s.dur ?? 0)}${remain !== null ? `   remain ${tc(remain)}` : ''}`,
    `src    ${src ?? '(未解析 — 页面地址不是视频页；可以让用户直接给 input)'}`,
    `seg    ${tc(cur.from)}–${tc(cur.to)}  (剩 ${Math.round(Math.max(0, cur.to - s.pos))}s)   图: ${have(cur) ? '已有' : '未建'}`,
    `next   ${nxt.from >= dur ? '—（已到片尾）' : `${tc(nxt.from)}–${tc(nxt.to)}   图: ${have(nxt) ? '已有' : '未建'}`}`,
    `buffer 就绪到 ${tc(bufTo)}（余 ${mmss(buffer)} / 目标 ${mmss(DEFAULT_LOOKAHEAD)}）${short ? `  ← 还差 ${win.length - ready} 段` : (atEnd ? '  已到片尾' : '  OK')}`,
  ].join('\n'));

  console.log('\n下一步：');
  if (short) {
    const miss = win.length - ready;
    console.log(`  node watch.mjs fill             # 一次补满余量（${miss} 段，约 ${miss * 10}s）—— 别一段一段挤`);
  }
  // 台词锚点必须晚于当前位置，否则 cue 会直接 SKIP
  console.log(`  node watch.mjs subs ${Math.round(s.pos)} ${Math.round(s.pos + 120)}    # 接下来的句子时间码（台词只挂在这些 from 上）`);
  return 0;
}

/**
 * 抓"用户插话"的信号 —— 脚本能拿到这个，是因为 WorkBuddy 把对话**实时写进磁盘**：
 *   ~/.workbuddy/projects/<项目>/<sessionId>.jsonl
 * 每行一条记录，用户发消息就是新增一行 `{type:'message', role:'user', content, timestamp}`。
 *
 * 所以阻塞期间只要盯着"文件新增的部分"，就能听见用户在说话 —— 不用等宿主把消息投递过来。
 * 只读 byte offset 之后的内容：历史消息一条都不会被误判成新插话。
 *
 * 换宿主（DSH 没有这个文件）时 findActiveSessionFile 返回 null，整体自动失效，不影响原有行为。
 */
const WB_PROJECTS = `${process.env.USERPROFILE ?? ''}/.workbuddy/projects`;

export function findActiveSessionFile() {
  try {
    if (!existsSync(WB_PROJECTS)) return null;
    let best = null;
    let bestM = 0;
    for (const dir of readdirSync(WB_PROJECTS)) {
      const abs = `${WB_PROJECTS}/${dir}`;
      let files;
      try { files = readdirSync(abs); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.jsonl') || f.endsWith('.file-rollback.ndjson')) continue;
        const full = `${abs}/${f}`;
        try {
          const m = statSync(full).mtimeMs;
          if (m > bestM) { bestM = m; best = full; }
        } catch { /* 读不到就跳过 */ }
      }
    }
    // 太久没动说明不是当前会话
    return best && Date.now() - bestM < 120_000 ? best : null;
  } catch { return null; }
}

export function makeInterruptWatcher(explicitFile = null) {
  const file = explicitFile ?? findActiveSessionFile();
  if (!file) return null;
  let offset = 0;
  try { offset = statSync(file).size; } catch { return null; }
  let tail = '';
  return {
    file,
    /** 有新用户消息就返回 {at, text}，否则 null */
    poll() {
      let size;
      try { size = statSync(file).size; } catch { return null; }
      if (size <= offset) return null;
      const len = size - offset;
      try {
        const fd = openSync(file, 'r');
        const buf = Buffer.alloc(len);
        readSync(fd, buf, 0, len, offset);
        closeSync(fd);
        offset = size;
        tail += buf.toString('utf8');
      } catch { offset = size; return null; }

      const lines = tail.split('\n');
      tail = lines.pop() ?? '';           // 最后一行可能写了一半，留到下次
      for (const line of lines) {
        if (!line.trim()) continue;
        let j;
        try { j = JSON.parse(line); } catch { continue; }
        if (j.type !== 'message' || j.role !== 'user') continue;
        const c = j.content;
        const text = typeof c === 'string'
          ? c
          : (Array.isArray(c) ? c.find((x) => x?.type === 'text')?.text : '') ?? '';
        return { at: j.timestamp ?? Date.now(), text: String(text).replace(/\s+/g, ' ').slice(0, 120) };
      }
      return null;
    },
  };
}

/* ------------------------------------------------------------ 外部聊天框 */

// 和插件共用同一个聊天记录（src/chat.js 的 chatFile）：两边读写同一份，插话才通
const CHAT = chatFile();

function chatRead() {
  try {
    return readFileSync(CHAT, 'utf8').trim().split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function chatAppend(role, text) {
  mkdirSync(OUT, { recursive: true });
  appendFileSync(CHAT, `${JSON.stringify({ role, text, at: Date.now() })}\n`, 'utf8');
}

/**
 * 阻塞中盯**我们自己的**聊天框。
 *
 * 为什么不是盯宿主的会话 jsonl：实测宿主不在阻塞期间落盘（用户 03:05:35 发的消息，
 * 写进文件时排在我 03:05:52 那条回复之后），所以那条路永远慢一拍。
 * 这个文件是我们自己写的，append 即落盘 —— 这才是真正"边等边能听见"的通道。
 */
function makeChatWatcher() {
  let seen = chatRead().length;
  return () => {
    const all = chatRead();
    if (all.length <= seen) return null;
    const fresh = all.slice(seen);
    seen = all.length;
    const u = fresh.find((m) => m.role === 'user' && String(m.text ?? '').trim());
    return u ? { text: u.text, at: u.at } : null;
  };
}

const CHAT_PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>陪看</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{background:#161616;color:#e0e0e0;font:16px/1.65 system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;padding:14px;max-width:680px}
#log{height:calc(100vh - 140px);overflow-y:auto;padding-bottom:8px}
.m{margin:8px 0;padding:9px 12px;border-radius:10px;white-space:pre-wrap;word-break:break-word}
.u{background:#26384a;margin-left:44px}
.a{background:#242424;margin-right:44px}
.t{font-size:11px;opacity:.45;margin-bottom:3px}
form{display:flex;gap:8px;margin-top:10px}
input{flex:1;padding:11px;background:#202020;border:1px solid #3a3a3a;color:#eee;border-radius:9px;font-size:16px;outline:none}
input:focus{border-color:#4a7ab5}
#send{padding:11px 18px;background:#3a6ea5;color:#fff;border:0;border-radius:9px;font-size:15px}
#pop{padding:11px 14px;background:#2f4a66;color:#dfe9f5;border:0;border-radius:9px;font-size:15px}
</style></head><body>
<div id="log"></div>
<form id="f"><input id="i" placeholder="说点什么…（回车发送）" autocomplete="off">
<button type="button" id="pop" title="浮到最上层（画中画小窗）">↑</button>
<button type="submit" id="send">发送</button></form>
<script>
(function(){
  var SEND="http://127.0.0.1:9377/api/say";
  var f=document.getElementById("f"), i=document.getElementById("i"), log=document.getElementById("log");
  function esc(s){return String(s).replace(/[<>&]/g,function(c){return {"<":"&lt;",">":"&gt;","&":"&amp;"}[c];});}
  function add(m){var d=document.createElement("div");d.className="m "+(m.role==="user"?"u":"a");
    d.innerHTML="<div class=t>"+(m.role==="user"?"我":"陪看")+"</div>"+esc(m.text);
    log.appendChild(d);log.scrollTop=log.scrollHeight;}
  function send(){var v=i.value.trim();if(!v)return;i.value="";
    fetch(SEND,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({text:v})}).catch(function(){});}
  f.addEventListener("submit",function(e){e.preventDefault();send();});
  var n=0;
  function poll(){
    fetch("http://127.0.0.1:9377/api/messages?since="+n+"&t="+Date.now()).then(function(r){return r.json();}).then(function(j){
      for(var k=0;k<j.msgs.length;k++)add(j.msgs[k]);
      n=j.total;setTimeout(poll,600);
    }).catch(function(){setTimeout(poll,1500);});
  }
  var pip=null;
  document.getElementById("pop").addEventListener("click",function(){
    if(pip){try{pip.focus();}catch(e){}return;}
    if(!("documentPictureInPicture" in window)){alert("这个浏览器不支持置顶小窗，需要 Edge/Chrome 116+");return;}
    documentPictureInPicture.requestWindow({width:440,height:92}).then(function(w){
      pip=w;
      var st=w.document.createElement("style");st.textContent=document.querySelector("style").textContent;
      w.document.head.appendChild(st);
      w.document.body.style.cssText="margin:0;height:100vh;overflow:hidden";
      w.document.body.appendChild(f);i.focus();
      w.addEventListener("pagehide",function(){document.body.appendChild(f);pip=null;i.focus();});
    }).catch(function(e){pip=null;alert("悬浮失败: "+e.message);});
  });
  poll();i.focus();
})();
</script></body></html>`;


// 胶囊版：只有一个输入框，配合独立小窗（--app）用，不挡视野
const WIDGET_PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>陪看</title>
<style>
html,body{margin:0;height:100%;background:#1b1b1b;overflow:hidden;font-family:system-ui,sans-serif}
form{height:100%;display:flex;align-items:center;padding:0 8px;gap:6px}
input{flex:1;height:42px;background:#262626;border:1px solid #3a3a3a;color:#eee;border-radius:21px;padding:0 16px;font-size:15px;outline:none}
input:focus{border-color:#4a8cd0;background:#2a2a2a}
input::placeholder{color:#666}
#pop{width:42px;height:42px;padding:0;border:0;border-radius:21px;background:#2f4a66;color:#dfe9f5;font-size:17px;cursor:pointer}
</style></head><body>
<form id="f"><input id="i" placeholder="说点什么…（回车发送）" autocomplete="off">
<button type="button" id="pop" title="浮到最上层（画中画小窗）">↑</button></form>
<script>
(function(){
  var SEND="http://127.0.0.1:9377/api/say";
  var f=document.getElementById("f"), i=document.getElementById("i");
  function send(){var v=i.value.trim();if(!v)return;i.value="";
    fetch(SEND,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({text:v})}).catch(function(){});}
  f.addEventListener("submit",function(e){e.preventDefault();send();});
  var pip=null;
  document.getElementById("pop").addEventListener("click",function(){
    if(pip){try{pip.focus();}catch(e){}return;}
    if(!("documentPictureInPicture" in window)){alert("这个浏览器不支持置顶小窗，需要 Edge/Chrome 116+");return;}
    documentPictureInPicture.requestWindow({width:440,height:92}).then(function(w){
      pip=w;
      var st=w.document.createElement("style");st.textContent=document.querySelector("style").textContent;
      w.document.head.appendChild(st);
      w.document.body.style.cssText="margin:0;height:100vh;overflow:hidden";
      w.document.body.appendChild(f);i.focus();
      w.addEventListener("pagehide",function(){document.body.appendChild(f);pip=null;i.focus();});
    }).catch(function(e){pip=null;alert("悬浮失败: "+e.message);});
  });
  i.focus();
})();
</script></body></html>`;

/** 起一个独立的聊天框（localhost），它才是插话入口 —— 不经过宿主，落盘即时 */
async function cmdChat(port = 9377) {
  const server = http.createServer((req, res) => {
    let u;
    try { u = new URL(req.url, 'http://127.0.0.1'); } catch { res.writeHead(400); res.end(); return; }

    if (u.pathname === '/' || u.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(CHAT_PAGE);
      return;
    }
    if (u.pathname === '/widget') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(WIDGET_PAGE);
      return;
    }
    if (u.pathname === '/api/messages') {
      const since = Math.max(0, Number(u.searchParams.get('since')) || 0);
      const all = chatRead();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ total: all.length, msgs: all.slice(since) }));
      return;
    }
    if (u.pathname === '/api/say' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 8000) req.destroy(); });
      req.on('end', () => {
        try {
          const j = JSON.parse(body);
          const text = String(j?.text ?? '').trim().slice(0, 500);
          if (text) { chatAppend('user', text); console.log(`[用户] ${text}`); }
        } catch { /* 坏请求就算了 */ }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  console.log(`聊天框已就绪 → http://127.0.0.1:${port}`);
  console.log('在这个页面里打字，阻塞中的 cue 会立刻收到（自己写盘，不经过宿主，没有延迟）');
  // 浏览器在的话顺手开一个标签，省得用户手动找地址
  const tabUrl = `http://127.0.0.1:${port}/`;
  if (await hasDebugPort({ port: PORT })) {
    const already = await hasTab(tabUrl);
    const ok = already || await openTab(tabUrl);
    console.log(ok ? (already ? '（浏览器里已经开着这个页面）' : '（已在浏览器里打开）') : '（没找到调试浏览器，手动打开上面的地址）');
  }
  await new Promise(() => {});   // 常驻，直到被 kill
}

/** 把模型的话写进聊天框（页面轮询就能看到） */
async function cmdReply(text) {
  const t = String(text ?? '').trim();
  if (!t) { console.log('用法: node watch.mjs reply "要说的话"'); return 2; }
  chatAppend('assistant', t.slice(0, 2000));
  console.log(JSON.stringify({ ok: true, text: t.slice(0, 60) }));
  return 0;
}

const CHAT_PORT = 9377;
const PENDING = `${OUT}/pending.json`;
const QUIET = `${OUT}/quiet-until.json`;

/**
 * 插话语音的"静音窗口"。
 *
 * Windows 音频是混音的：两个 SAPI 实例（台词一个、插话回复一个）同时念会叠在一起，
 * 听起来像两个人抢话。所以插话开口前先把窗口占住，念完再往后延 3 秒 ——
 * 这段时间里的台词直接跳过，不延后（延后会跟画面脱节）。
 */
function setQuiet(until) {
  try { writeFileSync(QUIET, JSON.stringify({ until, at: Date.now() }), 'utf8'); } catch { /* 写不了就算了 */ }
}

function quietUntil() {
  try { return Number(JSON.parse(readFileSync(QUIET, 'utf8'))?.until) || 0; } catch { return 0; }
}
const CUE_STATE = `${OUT}/cue-state.json`;

/**
 * 记下"这次阻塞是怎么结束的"。
 *
 * 为什么要落盘：阻塞有五种死法，其中**最狠的一种是外部 kill**（用户点停止 / 关窗口）——
 * 进程被直接掐掉，一行代码都跑不到，日志里什么都没有。
 * 所以每次进入阻塞先写 `phase:'blocking'`，正常结束才改成 `phase:'end'`。
 * 下次启动看见还停在 `blocking`，就知道上次是被外面掐的。
 */
function markCueState(obj) {
  try {
    writeFileSync(CUE_STATE, JSON.stringify({ ...obj, at: Date.now(), pid: process.pid }, null, 1), 'utf8');
  } catch { /* 写不了就算了，不影响念词 */ }
}

/** 上次那条命是怎么没的 */
function describeLastDeath() {
  try {
    const j = JSON.parse(readFileSync(CUE_STATE, 'utf8'));
    if (j?.phase === 'blocking') {
      const ago = Math.max(0, Math.round((Date.now() - j.at) / 1000));
      return `上次阻塞在 ${ago}s 前被**外部中止**（点停止 / 窗口关闭），不是台词念完、也不是计时到点`;
    }
  } catch { /* 没有历史 */ }
  return null;
}

/** 上次 cue 超时没念完的台词（只接同一支片子的） */
function loadPending(src) {
  try {
    const j = JSON.parse(readFileSync(PENDING, 'utf8'));
    return j?.src === src && Array.isArray(j.cues) ? j.cues : [];
  } catch { return []; }
}

function savePending(src, cues) {
  try {
    writeFileSync(PENDING, JSON.stringify({ src, cues, at: Date.now() }, null, 1), 'utf8');
  } catch { /* 落盘失败不该影响念 */ }
}

/** 建一段（图 + 清单 + 句子时间轴）。seg / fill 共用这一条路径。 */
async function buildSeg(input, from, to, cells = 5, detail = 'med') {
  mkdirSync(OUT, { recursive: true });
  const base = segBase(input, from, to);
  const png = `${base}.png`;
  const mdFile = `${base}.md`;
  const linesFile = `${base}.lines.json`;
  const metaFile = `${base}.meta.json`;

  // 复用要连**参数**一起核对：同一段换了格数/细节档，图就不一样了，不能假装命中
  let meta = null;
  try { meta = JSON.parse(readFileSync(metaFile, 'utf8')); } catch { meta = null; }
  const reuse = existsSync(png) && existsSync(linesFile)
    && meta?.cells === cells && meta?.detail === detail;

  const t0 = Date.now();
  let sheet = null;
  let manifest = '';
  if (!reuse) {
    const opts = boardOptions({ input, from, to, cells, detail, cookies: COOKIES }, { kind: 'watch' });
    const r = await runStoryboard({ ...opts, asrIdleMs: 180_000 });
    sheet = r.sheets?.[0];
    if (sheet?.png) writeFileSync(png, sheet.png);
    manifest = formatManifest(r, { maxChars: 2600, maxCellChars: charsForDetail(detail) });
    writeFileSync(mdFile, manifest, 'utf8');
    writeFileSync(metaFile, JSON.stringify({ input, from, to, cells, detail, at: Date.now() }, null, 1), 'utf8');
  } else {
    manifest = readFileSync(mdFile, 'utf8');
  }

  // 句子级时间轴：台词唯一可信的锚点。复用时直接读盘 —— 就算图已有，也必须能看到时间轴。
  let lines = [];
  if (reuse) {
    try { lines = JSON.parse(readFileSync(linesFile, 'utf8')); } catch { lines = []; }
  }
  if (lines.length === 0 && /^https?:/i.test(input)) {
    const subs = await fetchRemoteSubtitles({ url: input, cookies: COOKIES }).catch(() => null);
    if (subs?.ok) {
      lines = (subs.segments ?? []).filter((x) => x.to >= from && x.from <= to)
        .map((x) => ({ from: +x.from.toFixed(1), to: +x.to.toFixed(1), text: x.text }));
      writeFileSync(linesFile, JSON.stringify(lines, null, 1), 'utf8');
    }
  }
  return { base, png, mdFile, linesFile, sheet, manifest, lines, reuse, ms: Date.now() - t0, from, to };
}

async function cmdSeg(args) {
  const s = await pos();
  if (!s && (!args[0] || args[0] === 'auto')) { console.log('auto 需要能读到播放位置，先跑 status。'); return 1; }

  let from; let to; let cells; let detail;
  if (!args[0] || args[0] === 'auto') {
    const { target } = segmentInfo(s.pos, s.dur);
    ({ from, to } = target);
    cells = Number(args[1]) || 5;
    detail = args[2] || 'med';
  } else {
    from = Number(args[0]); to = Number(args[1]);
    cells = Number(args[2]) || 5;
    detail = args[3] || 'med';
  }
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    console.log('用法: node watch.mjs seg auto | seg <from> <to> [cells] [detail]');
    return 2;
  }
  if (s?.dur && from > s.dur) { console.log(`段起点 ${from}s 超过视频时长 ${Math.round(s.dur)}s`); return 1; }

  const input = await inputFor(s);
  if (!input) { console.log('没有输入源：先让用户在陪看浏览器里打开视频（scripts/start-edge-debug.cmd）。'); return 1; }

  const r = await buildSeg(input, from, to, cells, detail);
  console.log(JSON.stringify({
    ok: r.reuse || Boolean(r.sheet?.png), png: r.png, reuse: r.reuse, ms: r.ms,
    window: [from, to],
    cells: r.sheet ? (r.sheet.cells?.length ?? 0) : 'from cache',
    frames: (r.sheet?.cells ?? []).map((c) => ({
      cell: c.i, frame_at: Number.isFinite(c.t_frame) ? +c.t_frame.toFixed(2) : null,
    })),
    lines: r.lines.length, linesFile: r.linesFile,
  }, null, 1));

  console.log('=== TIMELINE (评论某句话 → at 用这里的 from；评论画面 → 用 frame_at) ===');
  for (const l of r.lines) console.log(`[${tc(l.from)}] ${l.text}`);
  if (!r.reuse) {
    console.log('=== MANIFEST ===');
    console.log(r.manifest);
  } else {
    console.log(`（图和清单之前建过，直接复用；要重出就删掉 ${r.png}）`);
  }
  return 0;
}

/**
 * 按"余量"一次补齐：把 pos + lookahead 以内的段全部建好。
 *
 * 为什么要这个命令：段长是 1/2/3/4/5 分钟的阶梯，首段只有 60 秒 ——
 * **一段一段补，余量在结构上永远到不了 5 分钟**。以前 SKILL 里写的"趁念台词时预取下一段"
 * 就卡在这儿：每次只补一段，补的速度刚好等于消耗的速度。
 */
async function cmdFill(args) {
  const s = await pos();
  if (!s) { console.log('读不到位置，先跑 status。'); return 1; }
  const lookahead = Number(args[0]) || DEFAULT_LOOKAHEAD;
  const cells = Number(args[1]) || 5;
  const detail = args[2] || 'med';
  const input = await inputFor(s);
  if (!input) { console.log('没有输入源：先让用户在播放器里打开视频。'); return 1; }

  const plan = makePlan({});
  const dur = Number.isFinite(s.dur) && s.dur > 0 ? s.dur : Infinity;
  // **建图 + 思考要十几秒**：当前段如果只剩不到 30 秒，建出来等你看完就作废了。
  // 所以直接从下一段开始铺（段边界是 ramp 定的，不能挪，只能跳过）。
  const RESERVE = 30;
  const curSeg = plan.segmentAt(s.pos);
  const anchor = Math.min(curSeg.to, dur) - s.pos < RESERVE && curSeg.to < dur ? curSeg.to : s.pos;
  if (anchor !== s.pos) {
    console.log(`SKIP 从 ${tc(s.pos)} 起的那段只剩 ${Math.round(Math.min(curSeg.to, dur) - s.pos)}s，建了也用不上；改从 ${tc(anchor)} 开始`);
  }
  // 只滤掉片尾之外的段；to 保持原值，否则文件名和已有产物对不上
  const win = windowFor(plan, anchor, lookahead).filter((seg) => seg.from < dur);
  let built = 0;
  const t0 = Date.now();
  for (const seg of win) {
    const r = await buildSeg(input, seg.from, seg.to, cells, detail);
    if (!r.reuse) built += 1;
    console.log(`${r.reuse ? 'HAVE ' : 'BUILD'} ${tc(seg.from)}–${tc(seg.to)}${r.reuse ? '' : `  ${r.ms}ms`}`);
  }
  const bufTo = win.length ? Math.min(win[win.length - 1].to, dur) : s.pos;
  console.log(JSON.stringify({
    ok: true, lookahead,
    built, total: win.length,
    bufferSec: Math.round(bufTo - s.pos), readyTo: tc(bufTo),
    ms: Date.now() - t0,
  }, null, 1));
  return 0;
}

async function cmdSubs(from = 0, to = 1e9) {
  const s = await pos();
  const input = await inputFor(s);
  if (!input || !/^https?:/i.test(input)) { console.log('需要正在放一个 B 站视频（字幕只从 B 站接口取）。'); return 1; }
  const r = await fetchRemoteSubtitles({ url: input, cookies: COOKIES }).catch(() => null);
  if (!r?.ok) { console.log(JSON.stringify({ ok: false, reason: r?.reason })); return 1; }
  const segs = (r.segments ?? []).filter((x) => x.to >= from && x.from <= to);
  console.log(JSON.stringify({ ok: true, lang: r.lang, total: r.segments?.length ?? 0, shown: segs.length }));
  for (const x of segs) console.log(`[${tc(x.from)}] ${x.text}`);
  return 0;
}

async function cmdSay(text, engine = 'auto') {
  if (!text) { console.log('用法: node watch.mjs say "文本" [dsh|sapi]'); return 2; }
  const t0 = Date.now();
  // 先占住窗口（大值），念完再收紧到"结束后 3 秒"——
  // 中间那几秒如果不占，cue 会趁这段时间把台词念进来，正好叠在一起
  setQuiet(t0 + 120_000);

  let r = null;
  let via = 'sapi';
  // 1) edge-tts（神经音色，最好）—— 装了就用，不用等任何服务
  if (engine !== 'sapi') {
    const cfg = configuredDshTts();
    const bin = defaultEdgeTtsBin();
    if (bin) {
      const e = await speakViaEdgeTts(text, { bin, voice: cfg?.voice || 'zh-CN-XiaoxiaoNeural' });
      if (e.ok) { r = e; via = 'edge-tts'; }
      else if (engine === 'dsh') console.log(`NOTE edge-tts 失败（${e.reason}）`);
    }
  }
  if (!r) r = await speak(text, { rate: 0 });

  setQuiet(Date.now() + 3000);
  console.log(JSON.stringify({
    ...r, via, text, ms: Date.now() - t0,
    quietUntil: new Date(Date.now() + 3000).toLocaleTimeString('zh-CN', { hour12: false }),
  }));
  return r.ok ? 0 : 1;
}

/**
 * 念台词。参数：`cue '<json>' [lateSec] [off] [check] [max-wait=秒]`
 *
 * - `check`     只核对不开口：报当前位置、计划、能念几句、余量 —— 进阻塞之前先看一眼
 * - `max-wait=N` 最多阻塞 N 秒，超时把没念的存进 pending，下次 `cue` 自动接上
 * - `off`       关掉按字数自动后延
 *
 * 为什么要 max-wait：阻塞等待期间模型什么都做不了，而这段时间本该拿去补余量或跟用户说话。
 * 有了它，"等台词念完"和"用户回话/备料完成"就变成**谁先到算谁**的关系。
 */
async function cmdCue(json, args = []) {
  let cues;
  try { cues = JSON.parse(json); } catch { console.log('用法: node watch.mjs cue \'[[at,"台词"],…]\''); return 2; }
  // 允许传空数组：那表示"只把上次超时剩下的接着念完"
  if (!Array.isArray(cues)) { console.log('cue 需要一个数组'); return 2; }

  const strArgs = args.map(String);
  const nums = strArgs.filter((x) => /^\d+(\.\d+)?$/.test(x)).map(Number);
  const late = nums[0] ?? 3;   // 默认只容 3 秒：晚了就丢，顺延会让后面的词全跟着漂
  const lagOff = strArgs.includes('off');
  const checkOnly = strArgs.includes('check');
  const maxWait = Number((strArgs.find((x) => x.startsWith('max-wait=')) ?? '').split('=')[1]) || 0;

  const s0 = await pos();
  const src0 = await inputFor(s0);

  // 上次超时没念完的，接着念（只接同一支片子，换片就作废）
  const carried = src0 ? loadPending(src0) : [];
  if (carried.length) {
    console.log(`RESUME 上次有 ${carried.length} 句没念完，接着来`);
    cues = [...carried, ...cues];
  }
  if (cues.length === 0) { console.log('没有要念的台词（也没有 pending）。'); return 0; }
  cues.sort((a, b) => a[0] - b[0]);

  // ---- 台词后延：字幕的 from 是这句话"开始"的时刻，在那一刻开口就是抢话。
  const lagLines = lagOff ? [] : await (async () => {
    if (!src0 || !/^https?:/i.test(src0)) return [];
    const subs = await fetchRemoteSubtitles({ url: src0, cookies: COOKIES }).catch(() => null);
    return subs?.ok ? (subs.segments ?? []) : [];
  })();

  const planned = cues.map(([at, text]) => {
    let realAt = Number(at);
    let tag = '';
    // **关键词锚点**：at 传字符串就去字幕表里找那句、取它的 from。
    // 为什么要这个：手写秒数会整段提前一分钟（实测过 —— 凭印象排了个 7 秒递增的序列，
    // 结果"1/4螺口"挂在 189 秒，字幕里它在 247 秒）。查表就永远不会错。
    if (typeof at === 'string') {
      const m = lagLines.find((l) => String(l.text ?? '').includes(at));
      if (m) { realAt = Number(m.from); tag = `⟨${at}⟩`; } else {
        console.log(`WARN 关键词「${at}」在字幕里没找到，这句跳过`);
        return null;
      }
    }
    if (!Number.isFinite(realAt)) return null;
    const hit = lagOff ? null : lineNear(lagLines, realAt);
    const lag = hit ? +speechLag(hit.text.length).toFixed(1) : 0;
    return { at: realAt, text, lag, speakAt: +(realAt + lag).toFixed(1), chars: hit?.text.length ?? null, tag };
  }).filter(Boolean);

  for (const p of planned) {
    console.log(`PLAN ${tc(p.at)}${p.tag ?? ''}${p.lag > 0 ? ` +${p.lag}s (${p.chars}字)` : ''} → ${tc(p.speakAt)} :: ${p.text}`);
  }

  // ---- 什么时候该回头
  // 不用固定心跳：固定 180 秒会在不需要的时候把模型叫醒，白烧 token。
  // 回到**段边界**上来：念到"本段该交付的时刻"（seg.to - lead）就返回，
  // 让模型去看下一段。节奏和 video_watch 的阻塞交付完全一致，一段只醒一次。
  // max-wait 仍可显式覆盖（调试、或想让模型提前回来时用）。
  const plan = makePlan({});
  const LEAD = 15;
  // 交付点也要按视频时长截断，否则 5 分 30 秒的片子会算出"05:45 再回头"这种等不到的时刻
  const durCap = Number.isFinite(s0?.dur) && s0.dur > 0 ? s0.dur : Infinity;
  const now0 = s0?.pos ?? 0;
  let deliverAt = Math.min(plan.segmentAt(now0).to, durCap) - LEAD;
  if (deliverAt <= now0) {
    // 已经在段尾了：还有下一段就等它，到片尾就等到结束
    const nextFrom = Math.min(plan.segmentAt(now0).to, durCap);
    const cand = Math.min(plan.segmentAt(nextFrom).to, durCap) - LEAD;
    deliverAt = cand > now0 ? cand : durCap;
  }
  // 插话监听：用户发消息 → 会话 jsonl 立刻多一行 → 阻塞中也能听见，不用等宿主投递
  const interrupt = makeInterruptWatcher();
  const chatPoll = makeChatWatcher();   // 自己的聊天框：落盘即时，不受宿主延迟影响

  const death = describeLastDeath();
  if (death) console.log(`NOTE ${death}`);
  console.log(interrupt
    ? `NOTE 插话监听 → ${interrupt.file}`
    : 'NOTE 插话监听不可用（没找到当前会话的 jsonl，插话只能等阻塞结束）');
  markCueState({ phase: 'blocking', deliverAt: +deliverAt.toFixed(1), pos0: +(s0?.pos ?? 0).toFixed(1), planned: planned.length });
  const deadline = maxWait > 0 ? Date.now() + maxWait * 1000 : Infinity;
  // ---- 可选的时间核对：进阻塞之前先看一眼，别闷头等
  if (checkOnly) {
    const now = s0?.pos ?? 0;
    const ahead = planned.filter((p) => p.speakAt >= now).length;
    const behind = planned.length - ahead;
    console.log([
      `CHECK pos=${tc(now)}${s0?.paused ? ' (PAUSED)' : ''}  ${s0?.title ?? 'no-video'}`,
      `      plan ${planned.length} 句：可念 ${ahead}，已过点 ${behind}`,
      `      首句 ${planned.length ? tc(planned[0].speakAt) : '—'}，末句 ${planned.length ? tc(planned[planned.length - 1].speakAt) : '—'}`,
      `      退出点 ${tc(deliverAt)}（本段交付点：念到这里就回去看下一段）${maxWait > 0 ? `；另设 max-wait ${maxWait}s` : ''}`,
    ].join('\n'));
    return 0;
  }

  let miss = 0;
  let i = 0;
  let brokeOnEnded = false;
  while (i < planned.length) {
    // 用户插话：唯一"边等边能听见"的通道。必须每次迭代**最先**检查 ——
    // 以前它放在 SKIP/SAY 之后，念词那几秒成了盲区，实测漏掉过一次。
    const hitNow = chatPoll() ?? interrupt?.poll();
    if (hitNow) {
      const restNow = planned.slice(i).map((p) => [p.at, p.text]);
      if (src0) savePending(src0, restNow);
      console.log(`INTERRUPT 用户插话 @${new Date(hitNow.at).toLocaleTimeString('zh-CN', { hour12: false })}「${hitNow.text}」`);
      console.log(`          剩 ${restNow.length} 句已存 pending，回去接话`);
      markCueState({ phase: 'end', reason: 'interrupt（用户插话，脚本监听到）' });
      return 0;
    }

    const { at, text, lag, speakAt } = planned[i];
    const s = await pos();
    if (!s) {
      miss += 1;
      if (miss >= 30) {
        console.log(`连续 ${miss} 次读不到播放位置 —— 浏览器被关了或调试端口掉了，剩下的台词放弃。先跑 start。`);
        markCueState({ phase: 'end', reason: 'no-position（读不到播放位置）' });
        return 1;
      }
      await sleep(1000);
      continue;
    }
    miss = 0;
    // 迟到的容差按**实际开口时刻**算，不然加了延以后全都会被误判成 SKIP
    if (s.pos >= speakAt + late) {
      console.log(`SKIP ${tc(at)}${lag > 0 ? ` (+${lag}s)` : ''} (已在 ${tc(s.pos)}，晚了)`);
      i += 1;
      continue;
    }
    if (s.pos >= speakAt) {
      // 插话语音还没让开就跳过这句（不延后：延后就跟画面脱节了）
      const qu = quietUntil();
      if (Date.now() < qu) {
        const left = ((qu - Date.now()) / 1000).toFixed(1);
        console.log(`SKIP ${tc(at)}（插话语音占用中，还剩 ${left}s，跳过这句）`);
        i += 1;
        continue;
      }
      console.log(`SAY  ${tc(at)}${lag > 0 ? ` (+${lag}s)` : ''} @${tc(s.pos)} :: ${text}`);
      const r = await speak(text, { rate: 0 });
      console.log(`     ${r.ok ? 'ok' : `fail ${r.reason}`}`);
      i += 1;
      // 每念完一句就把**剩下的**存盘。用户随时可能打断（他发消息 = 这个进程被 kill），
      // 只在超时那一条路上存是不够的：被强杀时一句话都不会留下。
      if (src0) savePending(src0, planned.slice(i).map((p) => [p.at, p.text]));
      continue;
    }
    if (s.ended) { brokeOnEnded = true; break; }
    // 到本段该交付的时刻：返回，让模型看下一段（这才是唯一该叫醒它的理由）
    if (s.pos >= deliverAt) {
      const rest = planned.slice(i).map((p) => [p.at, p.text]);
      if (src0) savePending(src0, rest);
      console.log(`SEG-END 已到 ${tc(deliverAt)}（本段交付点），剩 ${rest.length} 句存 pending；回去 status/seg`);
      markCueState({ phase: 'end', reason: 'seg-end（到段交付点，计时触发）', deliverAt });
      return 0;
    }
    // 显式的等待上限（一般不传）
    if (Date.now() > deadline) {
      const rest = planned.slice(i).map((p) => [p.at, p.text]);
      if (src0) savePending(src0, rest);
      console.log(`TIMEOUT 已等 ${maxWait}s，剩 ${rest.length} 句存进 pending；下一轮 cue 会自动接上`);
      markCueState({ phase: 'end', reason: 'timeout（max-wait 显式上限）' });
      return 0;
    }
    await sleep(500);
  }
  if (src0) savePending(src0, []);
  console.log('DONE');
  markCueState({ phase: 'end', reason: brokeOnEnded ? 'video-ended（片子播完了）' : 'all-spoken（台词全部念完）' });
  return 0;
}

function usage() {
  console.log(`陪看唯一入口 —— 所有能力都在这一个文件里。

  node watch.mjs install-extension     装浏览器扩展（把它复制到固定位置 + 打开扩展页）
  node watch.mjs bridge [port]         只起"接位置"的服务，用来验证扩装好没有
  node watch.mjs doctor                环境自检（先跑这个）
  node watch.mjs start [url]           起调试浏览器（9333）—— 备用通道，装了扩展就不用
  node watch.mjs login                 读 cookie + 验登录
  node watch.mjs wait [秒]             等用户放起视频
  node watch.mjs status                位置 / 当前段 / 该跑什么
  node watch.mjs seg auto [cells] [detail]     出当前（或下一）段的图 + 句子时间轴
  node watch.mjs seg <from> <to> [cells] [detail]
  node watch.mjs fill [lookahead] [cells] [detail]  一次补满余量（默认 300s = 5 分钟）
  node watch.mjs subs [from] [to]      只看字幕时间轴
  node watch.mjs say "文本" [dsh|sapi]  立刻念一句（dsh = 用 DSH 那个 edge-tts 插件的声音）
  node watch.mjs chat [port]           起独立聊天框（默认 9377）—— 插话入口
  node watch.mjs reply "文本"           把话说进聊天框（页面能看到）
  node watch.mjs voices               列可选音色 —— 改 ~/.dsh/tts.json 的 voice 就换声
  node watch.mjs cue '[[at,"词"],…]' [lateSec] [off] [check] [max-wait=秒]
        到点念；按字数自动后延 0.4–2.0s。
        默认念到**本段交付点**（seg.to-15s）就返回，让模型去看下一段 —— 一段只醒一次。
        check=只核对不念；max-wait=额外加一个硬上限（一般不用）

台词锚点：评论画面用 frame_at；评论某句话用 TIMELINE 里的 from。
宁可晚 2 秒，不能早 2 秒。

插话：chat 起的那个页面才是插话入口 —— 它自己写盘，阻塞中的 cue 600ms 内就能收到。
      宿主的输入框做不到（实测阻塞期间不落盘，消息要等这轮结束才写进文件）。
余量：status 里的 buffer 行是"还能撑多久"。不足 5 分钟就 fill，别一段一段挤。
阻塞不靠固定心跳（白烧 token）：cue 到段交付点自然返回。用户随时发消息就是打断。
产物在 ${OUT}`);
}

// ---------------------------------------------------------------- 分发

// 只有"直接执行"才跑 CLI。被 import（比如只想要 speechLag）时不该打印 usage —
// 实测过：别的脚本 import 一下，终端先被一屏帮助刷掉。
const invokedDirectly = Boolean(process.argv[1])
  && import.meta.url === pathToFileURL(process.argv[1]).href;

async function cli() {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    let code = 0;
    switch (cmd) {
      case 'doctor': code = await cmdDoctor(); break;
      case 'start': code = await cmdStart(rest[0]); break;
      case 'login': code = await cmdLogin(); break;
      case 'wait': code = await cmdWait(rest[0] ?? 120); break;
      case 'status': case 'now': code = await cmdStatus(); break;
      case 'seg': code = await cmdSeg(rest); break;
      case 'fill': code = await cmdFill(rest); break;
      case 'subs': code = await cmdSubs(rest[0] ? Number(rest[0]) : 0, rest[1] ? Number(rest[1]) : 1e9); break;
      case 'say': {
        const last = rest[rest.length - 1];
        const eng = (last === 'dsh' || last === 'sapi') ? rest.pop() : 'auto';
        code = await cmdSay(rest.join(' '), eng);
        break;
      }
      case 'chat': code = await cmdChat(rest[0] ? Number(rest[0]) : 9377); break;
      case 'bridge': code = await cmdBridge(rest[0]); break;
      case 'install-extension': case 'install-ext':
        code = await cmdInstallExtension({
          open: !rest.includes('--no-open'),
          stepsOnly: rest.includes('--steps'),
          verifyOnly: rest.includes('--verify'),
          verifyDir: rest.find((x) => !x.startsWith('--')) || null,
          // --no-wait / --install-only：复制完就返回，不在这里等（脚本、AI 用）
          wait: rest.includes('--wait') ? true
            : (rest.includes('--no-wait') || rest.includes('--install-only') ? false : undefined),
        });
        break;
      case 'reply': code = await cmdReply(rest.join(' ')); break;
      case 'voices': code = await cmdVoices(); break;
      case 'cue': code = await cmdCue(rest[0], rest.slice(1)); break;
      case 'help': case '--help': case '-h': case undefined: usage(); break;
      default: console.log(`未知命令: ${cmd}\n`); usage(); code = 2;
    }
    process.exit(code);
  } catch (e) {
    console.error(`ERR ${String(e?.message ?? e)}`);
    process.exit(1);
  }
}

if (invokedDirectly) await cli();
