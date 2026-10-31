/**
 * watch-run.js — `watch_together` 的一次调用（不含宿主胶水，便于直接测）。
 *
 * 一次调用的全部逻辑：
 *   1. 拿到用户的播放位置（宿主给 / 从浏览器读）
 *   2. 算出所在段，**先把这一段算出来**（用户的播放时间就是我们的计算时间）
 *   3. 还没到交付点 → 只回一行状态（几乎不花 token）
 *      到了交付点 → 回这一段的格子图 + 清单 + 陪看行为约束
 *
 * 关键取舍：交付点定在**段末前 lead 秒**，不是段末。用户正看着的时候插一句"这段快完了"，
 * 比卡在两段交界处更自然，也不打断。
 *
 * 本文件只留"一次调用按什么顺序做什么"。四块已经各自独立：
 *   watch-source.js   "用户在看什么"（第 0 步，四条候选路）
 *   watch-modes.js    三种替代入口（waitUntil / waitForRefill / nextLine）
 *   watch-browser.js  陪看浏览器在不在、要不要拉起、怎么说清状态
 *   batches.js        批次表（段边界只在那里定义一次）
 */

import {
  deliveryState, loadWatch, pruneSlot, readSlot, saveWatch,
  sessionKey, WATCH_LEAD,
} from './watch.js';
import { floatingWindowAlive } from './floating-window.js';
import { markMaterial, materialNote, materialState } from './watch-material.js';
import { speechEvents } from './voice.js';
import { appendSpoken } from './chat.js';
import { describeLatency, recordLatency } from './latency.js';
import { DEFAULT_LOOKAHEAD, DEFAULT_SEGMENT, makePlan, windowFor } from './batches.js';
import { raceChat, sleepWithChat, chatWatcherShared, enterChatWait } from './interrupt.js';
import { probeBrowser, readBrowserPosition } from 'dsh-video-storyboard/browser-time';
import { boardOptions, charsForDetail } from 'dsh-video-storyboard/board';

import { mmss } from './time.js';
import { saveLines } from './watch.js';
import { pinTimes } from './watch-lines.js';
import { cachedCues } from './lines-util.js';
import { describeBrowser, readPositionOrNull } from './watch-browser.js';
import { resolveWatchSource } from './watch-source.js';
import { runWatchMode } from './watch-modes.js';

/**
 * 给循环用的建段函数：传一次参数，返回 `build(from) => Promise`。
 * 循环负责"什么时候建"，这里只管"怎么建"。
 */
export function makeBuilder({ input, args = {}, runStoryboard, formatManifest, cache }) {
  return (from) => buildSegment({
    input, segStart: from, size: Number(args.segment) > 0 ? Number(args.segment) : DEFAULT_SEGMENT,
    args, runStoryboard, formatManifest, cache,
  });
}

/**
 * 陪看的清单总预算（字符）。**每格多少字**由 detail 决定（和 storyboard 同一个口径，
 * 见 board.js 的 DETAIL_CHARS），这里只决定"整份最多读多少"——
 * 陪看是反复调用，一次塞两万字会把上下文吃光。
 */
const WATCH_MANIFEST_BUDGET = { low: 1600, med: 2600, high: 6000 };

/**
 * **正在建的段**（key → promise）。同一段只允许有一个建图任务在跑。
 *
 * 为什么必须有这张表：插话的设计是"建图不取消，留在后台建完"（`raceChat` 的 `pending`），
 * 用户回一句、模型再调一次工具，就很可能对着**同一段**再发起一次建图 ——
 * 两个 yt-dlp / ffmpeg 落在同一个临时目录上，于是其中一个撞到
 * `yt-dlp exited 1: ERROR: [WinError 2] 系统找不到指定的文件`，
 * 而调用方最后只看到 `null.png`。实测就发生在 14:03:51（7 秒后同一段自己又建成了）。
 *
 * 现在第二个调用直接**等第一份**，不重开：既省掉一次完整建图，也不会互相踩文件。
 *
 * key 里只有 `input|from`，没带 `detail`/`segment`（那一份是按先到者的参数建的）：
 * 同一次陪看里这些参数是稳定的，换参数等于换需求，宁可复用也不要同时开两个。
 */
const inflight = new Map();

/**
 * **每条视频一条串行链**：同一个 input 的建图任务排队，不许同时跑。
 *
 * 为什么按 input 而不是按段：`watch-*` 共用 `%TEMP%\dsh-video-storyboard\media\<每次输入一个hash>\`
 * 这个目录，而且每段的流程都是"yt-dlp 先下 video/audio，再改名合并"。
 * 同一条视频的两段同时开始，就会有两个 yt-dlp 在同一目录里下载和改名 ——
 * 实测 15:50 的报错正是这一条：
 *
 *   yt-dlp exited 1: ERROR: Unable to rename file: [WinError 32]
 *   另一个程序正在使用此文件，进程无法访问: '…\a1c51b21f7ea02b6a3df\video.f30280.m4a.part'
 *
 * （那之后目录里确实留着一个 11 MB 的 `.part` —— 改名被另一个进程顶住了。）
 *
 * 代价是同一视频的多段预取变成排队完成，跨视频仍然并行。
 */
const inputChains = new Map();

function withInputLock(inputKey, fn) {
  const prev = inputChains.get(inputKey) ?? Promise.resolve();
  // 前一个失败也必须让后面的继续 —— 否则一次失败会把这条视频永久堵死
  const run = prev.then(fn, fn);
  inputChains.set(inputKey, run.then(() => {}, () => {}));
  return run;
}

/** 这类错误是"文件被另一个进程占着"，串行化之后仍然可能撞上残留的 .part，允许重试一次 */
function looksLikeFileLock(e) {
  const m = String(e?.message ?? e);
  return /WinError 32|Unable to rename|being used by another process|另一个程序正在使用此文件/i.test(m);
}

/**
 * 建一段：分镜 + 清单，放进缓存。
 * 抽出来是为了"当前段"和"下一段的预取"用同一条代码路径（预取跑偏了就是白烧 CPU）。
 */
async function buildSegment({ input, segStart, size, args, runStoryboard, formatManifest, cache }) {
  const key = `${sessionKey(input)}|${segStart}`;
  const hit = cache.get(key);
  if (hit?.png) return hit;

  const running = inflight.get(key);
  if (running) return running;

  const job = withInputLock(sessionKey(input), () => buildWithRetry({
    input, segStart, size, args, runStoryboard, formatManifest, cache, key,
  }))
    // 无论成功失败都要摘掉，否则下一段永远等一个已经结束的 promise
    .finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

/** 文件占用导致的失败自动重试一次（第二次是在持锁状态下跑的，不会再被别人抢） */
async function buildWithRetry(o) {
  try {
    return await buildOnce(o);
  } catch (e) {
    if (!looksLikeFileLock(e)) throw e;
    await new Promise((r) => setTimeout(r, 1500));
    return buildOnce(o);
  }
}

async function buildOnce({
  input, segStart, size, args, runStoryboard, formatManifest, cache, key,
}) {
  const detail = args.detail ?? 'med';
  const r = await runStoryboard({
    // 参数默认值只有一处定义（src/board.js）：陪看以前自己抄了一份，
    // 于是 storyboard 有 detail、陪看没有 —— 同一个"仔细程度"在两条路上是两个值。
    ...boardOptions({ ...args, input, from: segStart, to: segStart + size }, { kind: 'watch' }),
    // 陪看是持续调用：让本地 ASR 活过整段，别每段都冷启动一次（实测每段多 5 s）
    asrIdleMs: size * 1000 + 30_000,
  });
  const entry = {
    png: r.sheets?.[0]?.png ?? null,
    manifest: formatManifest(r, {
      maxChars: WATCH_MANIFEST_BUDGET[detail] ?? WATCH_MANIFEST_BUDGET.med,
      maxCellChars: charsForDetail(detail),
    }),
    cells: r.sheets?.[0]?.cells?.length ?? 0,
  };
  cache.set(key, entry);
  // 每段一张 PNG，一部电影会有几十段。只留最近 8 段，别把内存吃掉。
  while (cache.size > 8) cache.delete(cache.keys().next().value);
  return entry;
}

// 模块级：latencyNote() 需要知道"这一轮从什么时候开始"
let tStartForNote = Date.now();

async function latencyNote() {
  const st = await recordLatency(Date.now() - tStartForNote);
  // 标定完成后就不再占 token 了
  return st.samples > 3 ? '' : `\n${describeLatency(st)}`;
}

/**
 * @param {object} args  工具参数
 * @param {object} deps  { saveImage, resolveInput, runStoryboard, formatManifest, cache }
 */
export async function runWatchPass(args, deps) {
  const {
    saveImage, runStoryboard, formatManifest, cache = new Map(),
    readBrowser = readBrowserPosition,
    /** "浏览器到底在不在"—— 只用于**如实汇报**，位置仍走 readBrowser（可注入） */
    probeBrowserState = probeBrowser,
    browserPort = undefined,
    /** 宿主的取消信号：真的阻塞时**必须**看它，否则"停止"按了也没用 */
    signal = null,
    /** 进入阻塞前的准备（起聊天服务 + 开悬浮窗）。只有真要走 wait 才回调它 */
    prepareWait = null,
    /** 窗口"还开着吗"（可注入；默认 pid 判活） */
    windowAlive = floatingWindowAlive,
    /** 这次真的开过窗吗 —— 只有开过才知道"关掉"是什么意思 */
    expectWindow = false,
  } = deps;
  // 关窗即收工：等待期间用户把悬浮窗关了，就别再挂着（他没有插话入口了）
  const windowGone = () => expectWindow === true && windowAlive() !== true;
  // 从"开始读进度"到"结果返回"的耗时 —— 这就是本机延迟的实测值，用来做提前量标定
  const tStart = Date.now();
  tStartForNote = tStart;
  // 批次表：开头短、逐段加长、最后稳定。段边界由它统一提供，
  // 否则"说的是哪一段"和"建的是哪一段"会各算各的。
  const plan = makePlan({
    segment: Number(args.segment) > 0 ? Number(args.segment) : DEFAULT_SEGMENT,
    ramp: args.ramp === undefined ? null : args.ramp,
  });
  const lead = args.lead !== undefined ? Number(args.lead) : WATCH_LEAD;
  // 余量：进入阻塞前要备好的时长（秒）。默认 5 分钟，和循环用的是同一个口径。
  const lookahead = args.lookahead === undefined
    ? DEFAULT_LOOKAHEAD
    : Math.max(0, Number(args.lookahead) || 0);


  // ---- 0. 源：没给 input 就从浏览器里那个 <video> 所在的页面反推
  const src = await resolveWatchSource({
    input: args.input, args, readBrowser, browserPort,
  });
  // `ok: false` 是"这次调用到此为止"的完整结果（没视频 / 等超时）
  if (src.ok === false) return src;
  const { resolved } = src;
  const { input } = src;

  // 已经交付过的段：wait 模式不能把同一段反复交出来
  const state0 = await loadWatch();
  const sk0 = sessionKey(input);
  const lastDelivered = Number(state0[sk0]?.lastDelivered);


  // ---- 0.4 / 0.5 三种替代入口：命中就直接返回，不再往下走
  const mode = await runWatchMode({ args, input, plan, browserPort, readBrowser, signal });
  if (mode) return mode;

  // ---- 1. 播放位置
  // 用户很可能直接说"12:30"，数字里带冒号解析成 NaN 就白跑一次探测，这里先认一下
  const parseCursor = (v) => {
    if (typeof v === 'number') return v;
    if (typeof v !== 'string') return NaN;
    const m = v.trim().match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/);
    if (m) return Number(m[1]) * 60 + Number(m[2]);
    return Number(v);
  };
  let cursor = parseCursor(args.cursor);
  let note = '';
  let confidence = Number.isFinite(cursor) ? 'given' : null;

  // ---- 1.0 浏览器在不在：**每次调用都查**，哪怕这一次不需要它给位置。
  // 以前读不到就 `.catch(() => null)` 静默掉，于是"关着"和"开着但没视频"在模型眼里
  // 都是"没有位置"，它只能拿位置去倒推浏览器 —— 猜错就对着空气写台词。
  //
  // 这里**不再自动拉起浏览器**（2026-10-31 删）：位置主通道是浏览器扩展，
  // 它每秒钟把 `currentTime` 报过来；插件自己再开一个 Edge 只会在用户眼前多一个窗口。
  const browserState = browserPort
    ? await probeBrowserState({ port: browserPort }).catch(() => ({ state: 'error', port: browserPort }))
    : { state: 'unconfigured', port: null };
  if (!Number.isFinite(cursor)) {
    // 位置仍然走**可注入**的 readBrowser（测试/仿真靠它喂位置，别改成直接调 CDP）
    const b = await readPositionOrNull(readBrowser, browserPort);
    if (b && Number.isFinite(b.pos)) {
      cursor = b.pos;
      confidence = 'browser';
      note = ` (browser, ${b.paused ? 'paused' : 'playing'})`;
    }
  }
  const browserLine = describeBrowser(browserState);
  if (!Number.isFinite(cursor)) {
    // 位置只有两条来路：浏览器扩展上报 / CDP 调试端口。都读不到就**问**，不猜 ——
    // 以前这里还有一条"读系统媒体控件（SMTC）"的兜底，2026-10-30 删了：
    // 它只在事件发生时刷新（实测隔过 143、216 秒），拿它当实时位置必须外推，
    // 外推就会猜错，而猜错一次后面每一段都是错的。
    // 也不再自己拉起浏览器（2026-10-31 删）：多开一个窗口并不能让用户正在看的那一页报出位置。
    return {
      ok: false,
      browser: browserState.state,
      text: `${browserLine}\n`
        + 'cannot read your playback position — neither from the browser extension '
        + 'nor from a debug port.\n'
        + 'Tell me how far you are (e.g. "我看到 12:30 了") and call again with cursor: 750. '
        + 'I will not guess — a wrong cursor makes every later segment wrong too.',
      images: [],
    };
  }

  const cur = plan.segmentAt(cursor);
  const segStart = cur.from;
  const size = cur.size;
  const d = deliveryState({ cursor, segment: segStart, size, lead });
  const key = `${sessionKey(input)}|${segStart}`;

  // **返回形态只在这一处定义**。这个函数有十一个出口（读不到位置、建图失败、插话 ×2、
  // 取消、空闲、插话、已交付、没到点、已说过、交付），以前每个出口各拼一份十字段对象，
  // 加一个字段要改十一处，漏一处就是"某个分支少报 status"——测试看得见，线上看不见。
  //
  // 注意宿主**只取 text 和 images**（`tool-spec.js` 的 output.schema 是
  // `additionalProperties: false`，只声明了这两个）；其余字段是给测试和 handler 用的：
  //   input / size / cursor   handler 起循环要用（段长、锚点、源）
  //   ok / speaking / reason  测试与 handler 的判断依据
  //   segment / measuredAt    状态行与日志
  // `measuredAt` 在算段那一刻就定下来，之后所有分支共用它 —— 它就是"这一次测量的时刻"。
  const measuredAt = new Date().toTimeString().slice(0, 8);
  const pass = (extra = {}) => ({
    ok: true,
    speaking: false,
    images: [],
    confidence,
    input,
    size,
    cursor,
    measuredAt,
    segment: segStart,
    ...extra,
  });

  // ---- 1.5 预设台词：传了就存，到点由循环直接念
  if (Array.isArray(args.lines) && args.lines.length > 0) {
    const n = await saveLines(input, args.lines).catch(() => 0);
    if (n > 0) note += ` · saved ${n} line(s)`;
  }

  // ---- 2. 预取这一段
  let entry = cache.get(key);
  let builtMs = 0;
  if (!entry?.png) {
    const t0 = Date.now();
    try {
      // **一边建图一边听插话**：建一段要 8–10 秒（带 ASR 更久），这段时间干等没意义。
      // 注意不是"掐掉它" —— 图让它继续建完（结果会落进缓存），我们先回去回应用户；
      // 用户回完再调一次工具，缓存里已经有了，立刻就拿到。
      const built = await raceChat(
        buildSegment({ input, segStart, size, args, runStoryboard, formatManifest, cache }),
        { watcher: chatWatcherShared() },
      );
      if (built.kind === 'interrupted') {
        return pass({
          chat: { text: built.text, at: built.at },
          building: true,
          text: `[一起看] 用户插话 @${measuredAt}：`
            + `「${built.text}」\n`
            + '先回这一句 —— 但如果还有段欠台词，**台词优先**，先写 lines 再回。'
            + '这一段的图还在后台建（不用等它），回完**再调一次我就把图和清单给你** —— 已经在缓存里了，不会再重跑。',
        });
      }
      // 建图失败要在这里就转成"说人话的 build-failed"，不能把 null 带到下面去 ——
      // 以前 `raceChat` 失败时返回 `{kind:'done', value:null}`，于是几百行之后的
      // `entry.png` 抛 `Cannot read properties of null (reading 'png')`，
      // 真正的错误（ffmpeg 报错、地址不是视频页、网络断）全被埋掉了。
      if (built.kind === 'error' || !built.value) {
        throw built.error ?? new Error('build returned nothing');
      }
      entry = built.value;
    } catch (e) {
      // 取流失败（比如地址是"首页"、站点 yt-dlp 不支持）不该把栈抛给宿主：
      // 说清楚是哪一步、什么地址、下一步怎么办。
      return pass({
        ok: false,
        reason: 'build-failed',
        text: `could not build this segment for "${String(input).slice(0, 80)}".\n`
          + `${String(e?.message ?? e).slice(0, 200)}\n\n`
          + 'If that is a page URL, make sure it is the video page itself (not a homepage or a search page); '
          + 'otherwise pass the direct file path or a supported link.',
      });
    }
    builtMs = Date.now() - t0;
  }

  // ---- 2.4 余量：把"当前位置之后 lookahead 秒"内的段全部备好
  //
  // **这是进入阻塞等待的前提**：等待期间用户还在看，没有人能再建图；所以阻塞之前，
  // 未来那段窗口必须已经在缓存里。以前这里只预取"下一段"，而且是后台异步 ——
  // 于是等到用户在段末要图时，图常常还没建好（或者词根本来不及写）。
  // 两条路径分开处理：
  //   · 本次就要交付（already due）→ 别为了预取拖慢返回，丢后台串行建
  //   · 本次要阻塞等待 → **先把窗口建完再进入等待**，这样醒来时下一批已就绪
  // 视频时长只有浏览器知道（`probeBrowser` 的 watching 状态带回来）。
  // 拿不到就当无限长 —— 多排几段无害，反正窗口会被 lookahead 截住。
  const videoDur = Number.isFinite(browserState?.dur) ? browserState.dur : null;
  const winSegs = windowFor(plan, cursor, lookahead)
    .filter((s) => videoDur === null || s.from < videoDur);
  const willWait = !d.due && args.wait === true;
  const pending = winSegs
    .filter((s) => s.from !== segStart)
    .filter((s) => !cache.get(`${sessionKey(input)}|${s.from}`)?.png);
  const buildOne = (s) => buildSegment({
    input, segStart: s.from, size: s.size, args, runStoryboard, formatManifest, cache,
  });
  // 一次调用最多补 4 段：再多就是"用户其实不在看"，别把一次工具调用拖成几分钟
  const toBuild = pending.slice(0, 4);
  if (willWait) {
    // 补余量是**串行**的（一次只建一段，别把 CPU 打满），最多 4 段 —— 三十秒往上。
    // 这段时间也要听得见插话：图让它接着建完，我们先回去回应用户。
    const fill = (async () => {
      for (const s of toBuild) {
        try {
          await buildOne(s);
        } catch { /* 备不上就算了，到点再建 */ }
      }
    })();
    const race = await raceChat(fill, { watcher: chatWatcherShared() });
    if (race.kind === 'interrupted') {
      return pass({
        chat: { text: race.text, at: race.at },
        building: true,
        text: `[一起看] 用户插话 @${measuredAt}：`
          + `「${race.text}」\n`
          + '先回这一句 —— 但如果还有段欠台词，**台词优先**，先写 lines 再回。'
          + '余量还在后台补（不用等它），回完**再调一次我就接着陪** —— 已经建好的都在缓存里，不会重跑。',
      });
    }
  } else if (args.prefetch !== false && toBuild.length > 0) {
    setTimeout(() => {
      void (async () => {
        for (const s of toBuild) {
          try {
            await buildOne(s);
          } catch { /* 后台失败不响 */ }
        }
      })();
    }, 0).unref?.();
  }

  // **报实数，不报计划**：以前这里写的是"打算建到哪"，于是出现"说 5 分钟余量、
  // 实际只有 3 分钟"——用户一眼就看穿了。现在以缓存里真的有图为准。
  const builtWin = winSegs.filter((s) => s.from === segStart
    || cache.get(`${sessionKey(input)}|${s.from}`)?.png);
  const coverTo = builtWin.length > 0 ? builtWin[builtWin.length - 1].to : segStart + size;
  const stillBuilding = winSegs.length > builtWin.length;
  const bufferHint = (winSegs.length > 1)
    ? `\n[buffer] 图已备到 ${mmss(coverTo)}（${builtWin.length}/${winSegs.length} 段，约 `
      + `${Math.max(0, Math.round((coverTo - cursor) / 60))} 分钟余量`
      + `${stillBuilding ? '，剩下的在后台补' : ''}）。`
      + '词就写这个区间：' + winSegs.map((s) => `${mmss(s.from)}–${mmss(s.to)}`).join('、')
    : '';

  const found = resolved ? ` · source: ${resolved.matchedBy} → ${String(input).split(/[\\/]/).pop()}` : '';
  // **进度必须带"什么时候测的"**：用户看到这句话时可能已经过了几分钟。
  // 之前只写 `watch 08:28`，用户五分钟后再看会以为算错了——那是我把"测量时刻"说成了"现在"。
  const head = `watch ${mmss(cursor)} @ ${measuredAt}${note}${found} `
    + `· segment ${mmss(segStart)}–${mmss(segStart + size)}`
    + ` · ${Math.max(0, d.remaining)}s left`
    + (builtMs ? ` · built in ${(builtMs / 1000).toFixed(1)}s` : ' · ready')
    + `\n${browserLine}`;

  // ---- 2.4 高频模式（speakNow）：循环按固定节奏叫醒时，不必等到段末才交付
  if (args.speakNow === true) d.due = true;

  // ---- 2.5 阻塞等待（wait: true）
  // 用户的思路：与其"结束这轮、等定时器把我叫醒"，不如**让这次调用一直挂着**，
  // 就像等 npm 上传结果一样 —— 到点了工具自己返回，对话根本没断过。
  // 好处：完全不依赖 sessionController.prompt（那个能不能用还没验证过）。
  // 代价：等待期间这个会话被占着，用户插话要等它返回。
  let waitedSec = 0;
  const tWaitStart = Date.now();
  let alreadyDelivered = false;
  // **空闲自关**：位置两倍最长分段都没动过，就当用户已经不看了，主动收工。
  // 为什么是两倍：一段 5 分钟，正常播放最慢也会在一段内推进一次；两段都没动静，
  // 只能是页签挂起/缓冲卡死/人走了 —— 继续挂着只会把会话占死。
  const idleSec = Number(args.idleTimeoutSec) > 0
    ? Number(args.idleTimeoutSec)
    : Math.max(60, 2 * Number(plan.segment));
  const idleMs = idleSec * 1000;
  let idleHit = false;
  if (!d.due && args.wait === true) {
    // 真要阻塞了 → 把输入框支起来（第一次会起服务 + 开悬浮窗，之后是空操作）。
    // **放在这里而不是工具入口**：没视频、没到阻塞就没必要弹窗。
    await Promise.resolve(prepareWait?.()).catch(() => {});
    const capSec = Math.min(600, Math.max(5, Number(args.maxWaitSec)
      || Math.round(idleMs / 1000)));
    const deadline = Date.now() + capSec * 1000;
    let lastSeenPos = cursor;
    let lastMoveAt = Date.now();
    // 外部聊天框：宿主输入框在阻塞期间不会把话送到这里（实测事后补写），
    // 但 chat.jsonl 是我们自己 append 的，写盘即时 —— 这是唯一"边等边能听见"的通道。
    // 用**共享**的那个：每次等待都新建的话，模型思考期间用户说的话
    // 会落在两次等待的缝隙里，谁都不报，永远丢掉。
    const chatPoll = chatWatcherShared();
    // **告诉循环"这条通道现在归我"**：它每 2 秒也在 poll，一旦它把那句插话消费掉，
    // 这里就永远看不见了（见 interrupt.js 的 chatWaiters）。阻塞等待是唯一能让人
    // 从"等结果"里出来的一条路，所以它优先。
    const leaveChatWait = enterChatWait();
    try {
      while (Date.now() < deadline && !signal?.aborted && !windowGone()) {
        const chatHit = chatPoll();
        if (chatHit) { d.chatNow = chatHit; break; }
        // 位置来源：浏览器（准）> 上次测得的 SMTC 快照（凑合能用来判断"到没到"）
        const np = await readPositionOrNull(readBrowser, browserPort);
        const posNow = np ? np.pos : (Number.isFinite(cursor) ? cursor + waitedSec : null);
        if (posNow !== null) {
          cursor = posNow;
          // 按真实经过时间算，不按"每拍 +2 秒"——轮询频率改了，拍数就不等于秒数
          waitedSec = +((Date.now() - tWaitStart) / 1000).toFixed(1);
          const nd = deliveryState({ cursor, segment: segStart, size, lead });
          // 同一段已经交过一次就别再交：用户刚看完 00:00–01:00，
          // 再等到 00:59 把同一段塞给他一次，看起来像卡住了。
          if (nd.due) {
            if (segStart !== lastDelivered) {
              d.due = true;
              d.remaining = nd.remaining;
            } else {
              // 已经交过的段：不能干等到封顶（那会让会话挂着好几分钟）。
              // 直接结束这次等待，下面回一句"这段已经给过了"。
              alreadyDelivered = true;
            }
            break;
          }
          if (cursor < segStart) break;            // 用户倒回到上一段去了，别干等
          if (np?.paused) break;                   // 暂停了就别挂着了，让用户能说话
          // 位置有没有真的在走？（播放中但一秒都不动 = 缓冲卡死/页签挂起）
          if (Math.abs(posNow - lastSeenPos) >= 0.5) {
            lastSeenPos = posNow;
            lastMoveAt = Date.now();
          } else if (Date.now() - lastMoveAt >= idleMs) {
            idleHit = true;
            break;
          }
        }
        // 每拍歇 500ms —— 但**歇的时候也要听插话**，不然用户的话要等半秒才被发现。
        const said = await sleepWithChat(500, { watcher: chatPoll, everyMs: 150 });
        if (said) { d.chatNow = said; break; }
        waitedSec = +((Date.now() - tWaitStart) / 1000).toFixed(1);   // 没有浏览器读数也按墙钟推进
      }
    } finally {
      leaveChatWait();
    }
  }

  // 用户把悬浮窗关了（等待期间）：这是"我不看了"最直接的信号，立即收工。
  if (!d.due && windowGone()) {
    return pass({
      stopped: true,
      waitedSec,
      text: `${head}
[stopped] 悬浮窗被关掉了 —— 陪看结束，我不再挂着。`
        + '要接着看就再调一次 watch_together，我会把窗口重新开起来。',
    });
  }

  // 宿主把这一轮取消了（用户按了停止 / 会话被中断）：立刻收工，别继续挂着。
  // 以前不看 signal，于是"停止"之后循环还在读浏览器 —— 最长要等到封顶才自己退出。
  if (signal?.aborted && !d.due) {
    return pass({
      stopped: true,
      waitedSec,
      text: `${head}\n[stopped] 这一轮被取消了（宿主中断），等待已停止。`
        + '要接着陪看就再调一次 watch_together。',
    });
  }

  // **这里不能记 lastDelivered**：这一行以前写在"还没到点就返回"之前，于是每一次
  // "not yet" 的调用都会把当前段标成"已交付"。下一次调用在等待途中真到了交付点，
  // 去重判断 `segStart !== lastDelivered` 就会把它挡掉，一直挂到封顶也不交 ——
  // 表现是这一段被推迟到**再下一次**调用才交出去（迟到一段，而不是重复一段）。
  // 记账必须发生在真正交付的那条分支里（见下方第 4 步）。
  const waitNote = waitedSec > 0 ? ` · waited ${Math.round(waitedSec)}s` : '';

  // 位置长时间没动：收工，并把"停在哪儿、多久"说清楚，别让会话悄无声息地占着
  if (!d.due && idleHit) {
    return pass({
      ok: false,
      reason: 'idle',
      waitedSec,
      text: `${head}${waitNote}\nplayback has not moved for ${Math.round(idleMs / 60_000)} minutes `
        + `(${mmss(cursor ?? 0)}). Nothing to watch right now - stopping the wait. `
        + 'Call again when they are watching again.',
    });
  }

  // 用户在外部聊天框里说话了：先把这句给他，别等段末
  if (!d.due && d.chatNow) {
    return pass({
      chat: d.chatNow,
      text: `${head}${waitNote}\n**用户插话**：「${d.chatNow.text}」\n`
        + '先回这一句（除非还有段欠台词——那种情况台词优先），回完立刻再调一次 wait:true 继续陪看。',
    });
  }

  // 这一段已经交过一次（lastDelivered 命中）：不重复塞，也不继续挂着等
  if (!d.due && alreadyDelivered) {
    return pass({
      text: `${head}${waitNote}\nalready delivered this segment — not sending it again. `
        + 'Say something of your own, or call again after it moves past '
        + `${mmss(segStart + size)}.`,
    });
  }

  // ---- 3. 还没到交付点：保持安静
  if (!d.due) {
    return pass({
      status: note.includes('paused') ? 'paused' : 'playing',
      text: `${head}${waitNote}\nnot yet — keep watching. I will speak near ${mmss(segStart + size - lead)}.`
        + await latencyNote() + bufferHint,
    });
  }

  // ---- 4. 到点：交付（同一段不重复说）
  const st = await loadWatch();
  const sk = sessionKey(input);
  // 旧格式是数组，新格式是 {segStart: 说得有多久了}。倒回去重看同一段时，
  // 隔了 10 分钟以上允许重说一次 —— 否则"我刚才没听清，再看一遍"就永远得不到回应。
  const rawSpoken = st[sk]?.spoken ?? {};
  const spoken = Array.isArray(rawSpoken)
    ? Object.fromEntries(rawSpoken.map((k) => [k, Date.now() - 11 * 60_000]))
    : rawSpoken;
  const REPEAT_AFTER_MS = 10 * 60_000;
  if (spoken[segStart] && Date.now() - spoken[segStart] < REPEAT_AFTER_MS) {
    return pass({ text: `${head}\nalready spoke for this segment — not repeating it.` });
  }
  const nextSpoken = { ...spoken };
  // ---- 4.0 交付门槛：**这一段得有台词**（用户要求：台词优先于回插话）
  //
  // "看完 → 交付" 以前只发图和清单，台词是可选的。于是模型可以一直只交图、
  // 一条台词都不写（实测就这样跑了整场，用户的评价是"你为什么不说台词"）。
  // 现在的口径：**没有台词的交付不算完成** —— 不推进 `lastDelivered`，
  // 下一次调用仍然会落到这一段，并且开头就把"缺台词"顶到最前面。
  const segLines = await readSlot(input, segStart).catch(() => []);
  // 门槛可以关掉：`DSH_WATCH_REQUIRE_LINES=0`（写测别的行为的老用例时用；线上默认开）
  const requireLines = process.env.DSH_WATCH_REQUIRE_LINES !== '0';
  const hasLines = !requireLines || (Array.isArray(segLines) && segLines.length > 0);
  const missing = { ...(st[sk]?.missingLines ?? {}) };
  if (hasLines) delete missing[segStart];
  else missing[segStart] = Date.now();
  // 只留最近 40 条欠账，别让状态文件无限长
  const keptMissing = Object.keys(missing).sort((a, b) => missing[b] - missing[a]).slice(0, 40);
  if (hasLines) nextSpoken[segStart] = Date.now();
  // 只留最近 60 段，别让状态文件无限长
  const keptKeys = Object.keys(nextSpoken)
    .sort((a, b) => nextSpoken[b] - nextSpoken[a])
    .slice(0, 60);
  st[sk] = {
    ...(st[sk] ?? {}),
    // **没台词就不算说过**：不写进 spoken，也不推进 lastDelivered —— 这一段的交付没完成
    spoken: hasLines ? Object.fromEntries(keptKeys.map((k) => [k, nextSpoken[k]])) : spoken,
    lastDelivered: hasLines ? segStart : (st[sk]?.lastDelivered ?? null),
    missingLines: Object.fromEntries(keptMissing.map((k) => [k, missing[k]])),
    at: Date.now(),
  };
  await saveWatch(st);

  const images = entry?.png ? [await saveImage({ data: entry.png, name: `watch-${segStart}.png` })] : [];

  // ---- 素材账本：把"这次交出了哪一半"记下来
  //
  // 台词要两半素材才写得出来：**图**（画面发生了什么）+ **字幕**（句子和它的真实秒数）。
  // 以前两半在同一次返回里；现在允许拆开（`transcript: true` 单独取字幕），
  // 所以必须显式记账 —— 结果里才敢说"现在该写台词了"，也才知道缺哪一半。
  let material = await materialState(input, segStart).catch(() => null);
  try {
    if (images.length > 0) material = await markMaterial(input, segStart, 'image');
    // 清单里带逐格转写长这样：行首缩进 + 引号。用清单判断而不是猜上游来源 ——
    // 字幕轨 / ASR / 静音 三种情况的清单文案不一样，猜错会把"没字幕"记成"有字幕"。
    const hasTranscriptText = /^\s{2,}"/m.test(String(entry?.manifest ?? ''));
    if (hasTranscriptText) material = await markMaterial(input, segStart, 'transcript');
  } catch { /* 记账失败不影响交付 */ }
  const materialLine = material ? materialNote(material) : '';

  // **文字流那一半**：这一段的稿子连同 `at` 一起交出去，谁接了声音谁就能照着念。
  // 核心自己不发声，也不因此多加载任何东西（见 voice.js）。
  // **台词什么时候念，只由 `at` 决定** —— 交付这一下**不许**把整段稿子一次性吐出去。
  //
  // 实测踩过（用户投诉："代码不是让你只有到达时间区域内的台词才输出吗，你一次性输出三条
  // 干什么，还是过去那么久的"）：这里以前把这一段所有台词一次 `appendSpoken` 全写进流，
  // 语音适配器就按顺序全念一遍 —— 三条一起冒出来，`at` 早已过去的也当场补念。
  //
  // 现在：过去（早于 cursor-6s）的**丢掉并清出稿子**；其余交给钟按位置逐句念
  // （consumeLine + appendSpoken 才是"到点才说话"）；这里只报"还剩几句、最早几点念"。
  const PAST_GRACE_SEC = 6;
  // 没写 `at` 的句子，先**预演**钟会把它钉到哪（和 `dueLine` 同一套算法）。
  //
  // 为什么必须预演：不预演时它们只能拿段首当替身（`speechEvents` 的 fallbackAt），于是
  //   ① 报给模型的"最早 mm:ss 念"是假的；
  //   ② 下面那个过期判断会拿 `Number(null) === 0` 去比，"没写 at" 一律算作 0 秒、
  //      永远算过去 —— **整批好词在交付这一刻被删掉**（写的时候就丢了，钟再没机会念）。
  const hasBare = segLines.some((l) => l?.at === null || l?.at === undefined);
  const planned = hasBare
    ? pinTimes(segLines, segStart, size, cachedCues(input))
    : segLines;
  const speech = speechEvents(planned, { fallbackAt: segStart, segment: segStart });
  const isPast = (at) => Number.isFinite(at) && at < cursor - PAST_GRACE_SEC;
  const pastLines = speech.filter((l) => isPast(l.at));
  const upcoming = speech.filter((l) => !isPast(l.at));
  let linesNote = '';
  if (pastLines.length > 0) {
    // 按**正文**挑掉过期的那些（预演后的时刻没存盘，库里还是不带 at 的原样）。
    // 不带 at 的句子不在 pastLines 里 —— 它们的时刻是刚算的，不能因为"没写"就被删。
    const drop = new Set(pastLines.map((l) => String(l.text ?? '')));
    await pruneSlot(input, segStart, (l) => !drop.has(String(l?.text ?? ''))).catch(() => 0);
    linesNote = `
[lines] 丢弃 ${pastLines.length} 句：它们对应的时间点早于当前进度 ${mmss(cursor)}，`
      + '再念就对不上画面。写台词要挑**还没播到**的时间点。';
  }
  if (upcoming.length > 0) {
    const ats = upcoming.map((l) => Number(l.at)).filter((x) => Number.isFinite(x));
    const gap = ats.length > 1 ? (ats[ats.length - 1] - ats[0]) / (ats.length - 1) : 0;
    linesNote += `
[lines] 这一段已写好 ${upcoming.length} 句，最早 ${mmss(upcoming[0].at)} 念`
      + '（钟按 at 逐句念，不会一次全吐出来）。';
    // **把真实落点摊给模型看**：它看不见时刻就不知道自己在写连珠炮。
    if (ats.length > 1) {
      const list = ats.slice(0, 10).map((t) => mmss(t)).join(' / ')
        + (ats.length > 10 ? ` … 共 ${ats.length} 句` : '');
      linesNote += `\n[lines] 落点：${list}`;
      if (gap < 6) {
        linesNote += `\n[lines·太密] 平均每 ${gap.toFixed(1)} 秒一句，会跑在画面前面 —— `
          + '删掉几句，或者把 at 明确写到你真的要说的那一秒。';
      }
    }
  }

  // **交付门槛的提示**：没台词 = 交付未完成，这段话顶在最前面（优先级高于任何插话回复）
  const owed = Object.keys(st[sk]?.missingLines ?? {}).map(Number).sort((a, b) => a - b);
  const gate = hasLines
    ? ''
    : `\n[DELIVERY INCOMPLETE] 这一段 ${mmss(segStart)}–${mmss(segStart + size)} **还没有台词**，交付不算完成。\n`
      + '台词比回复插话高一级：先把这几句写进去 ——\n'
      + `  watch_together({ segment: ${size}, lines: [{ from: ${segStart}, at: <秒数或字幕原文>, `
      + 'text: "一句要念出来的话" }] })\n'
      + '`at` 优先传**画面上/转写里的原文片段**，代码会去查出真实秒数；凭印象写秒数整段会错。\n'
      + '写完再交付一次（图在缓存里，不重跑），那一次才推进进度。';
  const owedNote = owed.length > 0 && hasLines
    ? `\n[欠台词] 还有这些段没有台词：${owed.map((s) => mmss(s)).join('、')} —— 有空就补上。`
    : '';

  const guidance = [
    'PRIORITY ORDER (highest first): 1) write the segment lines (`lines`), 2) answer an interjection, '
      + '3) anything else. A delivery without lines is NOT finished.',
    `[together-watch] The user just watched ${mmss(segStart)}–${mmss(segStart + size)} (now at ${mmss(cursor)}).`,
    'They watched it themselves — do NOT retell the plot.',
    `**NO SPOILERS**: they are only at ${mmss(cursor)} — anything after that is still in your hands. `
      + 'Never say 接下来 / 下一分钟 / 后面会 / 正片才 / 等下注意看; write only about what is on their screen. '
      + 'The sheet shows the whole segment because you need it to write lines, NOT as permission to narrate ahead.',
    'Default: one sentence about what changed or what is worth noticing, then stop.',
    'Say more only if they ask, or if something genuinely deserves one callout.',
    'If nothing is worth saying, say almost nothing — silence is a valid answer,',
    'and so is watching two segments without commenting at all. There is no quota to fill.',
    'IMPORTANT: text you write in your normal reply is NOT visible in the floating window.',
    'To say something to the user there, pass it as `say` in the same call, e.g. '
      + 'watch_together({ segment: 60, say: "one sentence" }). It is written to the window and spoken.',
  ].join('\n');

  return pass({
    speaking: true,
    // 交付**发生了**（图已给），但"完成"要看有没有台词（门槛）；
    // 两者分开报：handler 用 speaking 决定要不要把台词交给声音，用 complete 判断是否推进。
    complete: hasLines,
    status: note.includes('paused') ? 'paused' : 'playing',
    speech,
    text: `${gate}${materialLine}${linesNote}${owedNote}${head}${waitNote}\n${guidance}${await latencyNote()}${bufferHint}\n\n${entry.manifest}`,
    images,
  });
}

