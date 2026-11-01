/**
 * watch-loop.js — 陪看循环：起钟、读进度、到点叫醒。
 *
 * 进度这一层交给 `position.js`：**读数 + 读数时刻**必须一起看。
 * 我们每 15 秒才真读一次，中间 13 秒的位置是按时钟外推的；外推得有个上限，
 * 太久没刷新就承认不知道（那时该问用户），而不是继续线性推下去。
 *
 * 循环只做三件事，各自频率不同：
 *   每 2 秒   本地判定（纯算术，不调模型）
 *   每 15 秒  读一次浏览器里的 `video.currentTime`，更新锚点
 *   真到点    往会话投一条极短消息（这才贵）
 */

import { aheadSeconds, loadLatency } from './latency.js';
import {
  MAX_EXTRAPOLATE_MS, SAFETY_AFTER_MS, estimate, makeAnchor, shouldSpeak,
} from './position.js';
import { chatWatcherShared, chatWaiterCount } from './interrupt.js';
import { startTicker, wakeSession } from './timer.js';
import { DEFAULT_LOOKAHEAD, DEFAULT_SEGMENT, describePlan, makePlan, windowFor } from './batches.js';
import { readBrowserPosition, looksLikeVideoUrl } from 'dsh-video-storyboard/browser-time';
import { readBridge } from './position-bridge.js';
import { floatingWindowAlive } from './floating-window.js';
import { readPositionOrNull } from './watch-browser.js';
import { emitSpeech, speechSubscribers } from './voice.js';
import { speechSeconds } from './speech.js';
import { consumeLine, dueLine, hasLine, loadLine, WATCH_LEAD } from './watch.js';
import { mmss } from './time.js';
import { appendChat } from './chat-store.js';
import { markHungUp, sessionKey } from './watch-state.js';
import { interjectNote } from './interject.js';
import { __resetReplyGuard, replyBusyUntil } from './reply-guard.js';
import { isRetryableWakeFailure, wakeFailureGate, wakeFailureHint } from './wake-failure.js';

/**
 * 叫醒失败要**看得见**。
 *
 * 以前这里是 `void chatWake(...)`：`wakeSession` 回 `{ok:false, reason}` 也不会有人看，
 * 用户在悬浮窗里说的话就这么被吞掉了 —— 表现就是"突然不理我了"（2026-10-31 实报）。
 * 现在：只对偶发失败重试一次；确定性失败不空等。
 * 失败提示按 (session, reason) 节流，静默期内的次数折叠到下一次显示，
 * 避免持续故障把聊天流刷成几十条同样的 meta。
 */
export async function wakeWithRetry({
  ctx, sessionId, text, wake, note = () => {}, gate = wakeFailureGate,
  append = appendChat, sleep = (ms) => new Promise((res) => setTimeout(res, ms)),
}) {
  let r = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { r = await wake(ctx, { sessionId, text }); } catch (e) { r = { ok: false, reason: String(e?.message ?? e) }; }
    if (r?.ok) return r;
    if (attempt === 0 && isRetryableWakeFailure(r?.reason)) {
      await sleep(800);
      continue;
    }
    break;
  }
  const reason = String(r?.reason ?? 'unknown').slice(0, 120);
  const verdict = gate.admit(`${sessionId ?? 'unknown'}:${reason}`);
  if (verdict.allowed) {
    const folded = verdict.suppressed > 0 ? `（同类失败另有 ${verdict.suppressed} 次已折叠）` : '';
    try {
      append('meta', `[一起看] 叫醒失败：${reason}${wakeFailureHint(reason)}${folded}`, { say: false });
    } catch { /* 写不进流也要留日志 */ }
  }
  note(`wake failed: ${reason}` + (verdict.allowed ? '' : ` (suppressed x${verdict.suppressed})`));
  return r ?? { ok: false, reason: 'unreachable' };
}

/** 关窗说明：不投 followup（那会进排队消息区），落进 watch.json 等下一次工具调用带走 */
const HANGUP_NOTE = '[一起看·挂断] 悬浮窗被关掉了 —— 用户关它就是在说「不看了」，陪看已经停表。\n'
  + '**不要再调 watch_together，也不要再念台词**（台词队列不再发出）。'
  + '只回一句短的（用 `say`，否则他看不到），比如"好，先停在这儿"。'
  + '他要接着看时会自己说一声，那时候再重新调 watch_together 开窗；'
  + '如果他说的是「把窗口藏起来」，那用 `watch_together({ window: "hide" })`，陪看继续。';

const TICK_MS = 2000;
const PROBE_EVERY_MS = 15_000;
/** 读不到位置多久后主动问一次（静默比问一句更糟：用户不知道它在等什么） */
const ASK_AFTER_MS = 20_000;
/** 两次主动问之间至少隔这么久 */
const ASK_COOLDOWN_MS = 300_000;
/**
 * 连续多久读不到就停表，等人给 cursor（别在那儿空转）。
 *
 * 原来 10 分钟。改成 5 分钟的理由：读不到位置之后**台词在 20 秒后就不再发了**
 * （见台词那段的 `positionUsable`），剩下的十几分钟只是把会话占着、让模型以为还在看 ——
 * 2026-10-31 实报的"关了浏览器它还在继续"就是这种状态。
 */
const UNKNOWN_GIVE_UP_MS = 300_000;
/** 连续这么久读不到浏览器就先停（视频关了 / 浏览器退出了 / 页签切走了） */
const NO_SOURCE_GIVE_UP_MS = 300_000;
/** 余量默认值在 batches.js（批次规划的策略），这里转出给老的调用方 */
export { DEFAULT_LOOKAHEAD };

const loop = {
  active: false,
  ctx: null,
  sessionId: null,
  input: null,
  segments: [],
  spoken: [],
  anchor: null,
  aheadSec: 0,
  positionSource: 'browser',
  /** 交付提前量（秒）。和 watch-run 用的是同一个值，见 startWatchLoop 的 `lead` 参数 */
  lead: WATCH_LEAD,
  unknownSince: 0,
  askedAt: 0,
  noSourceSince: 0,
  dur: null,
  /** 正在跟的那支片子的页面地址（换片判据之一，见 `sourceSwitched`） */
  sourceUrl: null,
  /** 建段耗时 / 正在建哪一段（`statusOnly` 的 build 那一段） */
  lastBuildMs: 0,
  buildingFrom: null,
  /** 字幕轨（两段式投喂）：转过写 / 喂过台词 / 放弃过的段，见 startWatchLoop */
  transcribed: new Set(),
  fedTranscript: new Set(),
  badSegments: new Map(),
  transcribing: null,
  transcribingFrom: null,
  lastTranscript: null,
  /** 段缓存（外部传进来，只用来报"缓存里已有几段"，不参与决策） */
  cache: null,
  /** 上一句台词比画面晚了几秒（可观测性：用户说"后面越来越慢"时先看它） */
  lastSpeechLateSec: null,
  /** TTS 接口的订阅者计数；startWatchLoop 注入 tts 后设置，loopStatus 用 */
  voiceListeners: null,
  /** 最后一条已经投出去的插话（`{ at, text }`）—— 同一条不投第二遍，见 tick 里那段 */
  lastChatFed: null,
  lastWake: null,
  wakeFails: 0,
  logs: [],
  lastProbeAt: 0,
  lastReason: '',
  /** 关窗即收工：这次真的开过窗才为 true */
  windowGuard: false,
  ticker: null,
  log: () => {},
};

/**
 * 记一次唤醒的结果（四处叫醒共用）。
 *
 * **叫不醒必须能看出来**：以前只写进 log，而 log 被调用方传成了空函数，
 * 于是"loop 在跑、位置也对、就是没人说话"完全查不出来。所以失败要计数 + 改 lastReason。
 */
function recordWake(w, { segment } = {}) {
  loop.lastWake = {
    at: new Date().toTimeString().slice(0, 8),
    ok: Boolean(w?.ok),
    reason: w?.reason ?? null,
    segment,
  };
  if (!w?.ok) {
    loop.wakeFails += 1;
    loop.lastReason = 'wake-failed';
  }
}

/**
 * 这一次读数是不是"换片了"？
 *
 * 判据只有两条，都要两边都有值才比：
 *   · 时长变了（差 1 秒以上）—— 最硬的信号，和地址无关；
 *   · 地址变了，而且**两边都像视频页** —— 只有这种地址变化才说明换片。
 *     不加这条限制的话，CDP 读到宿主自己的界面（WorkBuddy / VSCode）、
 *     或者浏览器从一个 tab 跳到另一个 tab，都会被误判成换片，然后当场停表。
 *
 * @param {{dur?:number|null, url?:string|null}} prev 当前正在跟的那支
 * @param {{dur?:number|null, url?:string|null}} next 刚读到的那支
 * @returns {null | {durChanged:boolean, urlChanged:boolean}}
 */
export function sourceSwitched(prev, next) {
  if (!next) return null;
  // **`Number(null) === 0`**：拿它直接比，"还没有时长"（null）和"600 秒"就会被判成换了片。
  // 这个坑仓里踩过好几次（台词 at、指纹缓存），这里显式判空。
  const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
  const prevDur = num(prev?.dur);
  const nextDur = num(next?.dur);
  const durChanged = Number.isFinite(prevDur) && Number.isFinite(nextDur)
    && Math.abs(prevDur - nextDur) > 1;
  const urlChanged = Boolean(prev?.url && next?.url && prev.url !== next.url
    && looksLikeVideoUrl(prev.url) && looksLikeVideoUrl(next.url));
  if (!durChanged && !urlChanged) return null;
  return { durChanged, urlChanged };
}

/**
 * 这一段的台词是不是**已经单独喂过**了。
 *
 * `buildOnce` 用它决定画面那次要不要带台词（带 `omitTranscript`）：
 * 字幕轨可能早就把这段的句子推给模型了，再贴一遍等于同一段说两遍（实测 +50% token）。
 * 只认"当前这场陪看"：换源/重启之后 `fedTranscript` 是空的，那段就得由画面带着词一起给。
 */
export function isFedSegment(input, from) {
  if (!loop.active || !loop.fedTranscript?.size) return false;
  if (sessionKey(loop.input) !== sessionKey(input)) return false;
  return loop.fedTranscript.has(Number(from));
}

export function loopStatus() {
  const est = loop.anchor ? estimate(loop.anchor) : null;
  const plan = loop.plan ?? null;
  const segNow = (plan && est && Number.isFinite(est.pos)) ? plan.segmentAt(est.pos) : null;
  // 片长知道时才敢报"共几段"；不知道就是 null（不知道 ≠ 0）。
  // **取片尾前 1 毫秒所在的那一段**：片长正好落在段边界时（600 = 5×120），
  // `indexAt(dur)` 会指到下一段的开头，段数就多报一段。
  const total = (plan && Number.isFinite(loop.dur))
    ? plan.segmentAt(Math.max(0, loop.dur - 0.001)).index + 1
    : null;
  return {
    active: loop.active,
    session: loop.sessionId,
    input: loop.input,
    segments: loop.segments.length,
    batchPlan: plan ? describePlan(plan) : null,
    // 余量：depth 是"给了就按段数"，null 表示按 bufferSec 动态算
    depth: loop.depth ?? 'auto',
    bufferSec: loop.bufferSec ?? null,
    spoken: loop.spoken.length,
    /*
     * 下面三块是**诊断用**的：用户报"后面越来越慢 / 不说话了"时，
     * 只看 pos 和 reason 是查不出来的，得知道"卡在哪一环"。
     * 只报事实，不下结论。
     */
    // 当前段：第几段 / 起止 / 已经交付过几段 / 这条片子一共几段（片长未知时 total 为 null）
    segment: segNow ? {
      index: segNow.index,
      from: segNow.from,
      to: segNow.to,
      delivered: loop.spoken.length,
      total,
    } : null,
    // 台词：上一句比画面晚了几秒、引擎忙到什么时候（墙钟毫秒）
    speech: {
      lastLateSec: loop.lastSpeechLateSec ?? null,
      busyUntil: loop.voiceBusyUntil || null,
      lastAt: loop.lastSpeechAt ?? null,
      // 队列深度要读盘（watch.json），只在 statusOnly 里补 —— 循环每 2 秒读一次不值得
      queued: null,
    },
    // 建图：正在建哪一段（null = 没在建）、缓存里已有几段、上一段建了多久
    build: {
      inflight: loop.buildingFrom ?? null,
      cached: loop.cache?.size ?? null,
      lastMs: loop.lastBuildMs || null,
    },
    // 字幕轨：转好几段、喂出去几段、正在转哪一段、上一次转了多久（§6 验收靠它）
    transcript: {
      ready: loop.transcribed?.size ?? 0,
      fed: loop.fedTranscript?.size ?? 0,
      inflight: loop.transcribingFrom ?? null,
      last: loop.lastTranscript ?? null,
      bad: loop.badSegments?.size ?? 0,
    },
    // 声音：核心只发事件。listeners = 0 表示"没人接声音"，到点的词会改走叫醒模型。
    voice: {
      listeners: loop.voiceListeners ? loop.voiceListeners() : speechSubscribers(),
      lastAt: loop.lastSpeechAt ?? null,
    },
    pos: est ? +est.pos.toFixed(1) : null,
    confidence: est?.confidence ?? 'none',
    staleMs: est ? est.staleMs : null,
    reason: loop.lastReason,
    lastWake: loop.lastWake,
    wakeFails: loop.wakeFails,
    positionSource: loop.positionSource ?? null,
    log: loop.logs.slice(-8),
  };
}

export function stopWatchLoop(reason = 'stopped') {
  loop.ticker?.dispose();
  loop.ticker = null;
  if (loop.active) loop.log(`[watch] loop stopped (${reason})`);
  loop.active = false;
  loop.lastReason = reason;
  return loopStatus();
}

/**
 * 起循环。重复调用先停旧的（同一时刻只允许一段陪看）。
 *
 * @param {object} o
 * @param {object} o.ctx
 * @param {string} o.sessionId
 * @param {string} o.input
 * @param {{from:number,to:number}[]} o.segments 显式段表（旧调用方/测试）；不传就按批次表排
 * @param {number} [o.cursor]  用户自报的真实进度 —— 传了就以它当锚点（读不到浏览器时的兜底）
 * @param {'playing'|'paused'} [o.status]
 */
export function startWatchLoop({
  ctx, sessionId, input, segments, cursor = null, status = 'playing', log = () => {},
  // 调试端口：显式参数优先，其次 deps（老调用方/handler 走这条）
  browserPort: explicitPort = null,
  size = DEFAULT_SEGMENT, depth = null, segment, ramp, speakEvery = 0,
  // 余量按**时间**算（秒）：当前位置之后已备好的时长不少于它。
  // 不再用"留两段"—— 批次表开头是 1/2/3 分钟，两段在最前面只有 2 分钟，等于没有余量。
  lookahead = DEFAULT_LOOKAHEAD,
  // 台词库存低于这么多段时，叫醒模型去补写。0 = 不管（默认关）
  refillBelow = 0,
  // 提前多少秒判"该说话了"。**必须由调用方传进来**：以前这里写死 15，
  // 于是 `lead: 30` 只在 watch-run 那条路上生效，钟这边照样按 15 秒触发 ——
  // 同一个参数两套口径，是"说好的时间点对不上"这类现象的来源。
  lead = WATCH_LEAD,
  // 段缓存（可选）：只用于 `statusOnly` 里报"缓存里已有几段"，不参与任何决策
  cache = null,
  // TTS 接口可注入（handler 传 api.tts）；不传就走 deps.tts / 旧总线。
  tts: ttsOption = null,
  // 依赖可注入：进程内默认真实实现；测试/仿真用假的，于是"到点会不会说话"可以离线验证
  deps = {},
  // **到点是否往会话里投一条消息把人叫醒**。默认**关**。
  //
  // 为什么默认关：阻塞式调用（`wait: true`）本来就会在段末自己返回，
  // 钟再额外 `followup()` 一次，用户那边看到的是"2 条排队消息：[一起看] 00:00–01:00 该说话了…"，
  // 而这些消息还会挡住用户真正要说的话。要恢复旧行为就显式传 `wake: true`。
  wake: wakeOpt = false,
  // **关窗即收工**：用户把悬浮窗一关就是"我看完了"，比任何位置推断都直接。
  // 只有真的开过窗才生效（`windowGuard: true` 由 handler 在窗口就绪时传）；
  // 没开窗（环境变量关掉、Python 缺失、或压根不需要插话）时为 false，不会误停。
  windowGuard = false,
  // **悬浮窗里的插话，永远叫得醒**（默认开）。
  // 用户的原话："插话能随时插入任何一个箭头对吗" —— 阻塞等待里本来就会 polling，
  // 但"我思考 / 钟在后台空转"的那段时间没人听。这一项就是补那段：
  // 钟每一拍顺手看一眼聊天框，有新消息就真的 wake 一次（只针对**用户的插话**，
  // 不是段末那种"该说话了"的打扰，所以和 `wake: false` 不冲突）。
  wakeOnChat = true,
  // **字幕轨**：只转写、不建图，跑到"当前位置 + 余量"为止。默认开（用户要的是"字先到先给"）。
  // 关掉它就退回原来的行为：字和画面一起在图那一次给。
  transcriptTrack = true,
  // 字幕好了之后等多久再先喂台词（毫秒）。**默认 0 = 一到就喂**（按用户原话）。
  // 调成 20000 就是"字幕好后 20 秒画面还没来才推"，用来减少会话里的消息条数。
  feedTranscriptLeadMs = 0,
}) {
  const wake = wakeOpt === true
    ? (deps.wake ?? ((c, o) => wakeSession(c, o)))
    // 关掉时给一个**不会报错**的空实现：所有调用点照旧，但什么都不发
    : async () => ({ ok: true, via: 'disabled' });
  const now = deps.now ?? (() => Date.now());
  // TTS 走接口：循环只发事件，不 import 声音实现。没注入就退回旧的总线，
  // 兼容 CLI/测试；宿主通过 handler 注入 api.tts 后这条 fallback 不会走到。
  const tts = deps.tts ?? ttsOption ?? null;
  const listeners = () => (tts?.subscribers ? tts.subscribers() : speechSubscribers());
  loop.voiceListeners = listeners;
  const speak = (event) => (tts?.due ? tts.due(event) : emitSpeech(event));
  const ticker = deps.ticker ?? startTicker;
  const readLatency = deps.loadLatency ?? loadLatency;
  // 读进度的间隔可注入：真机 15 秒够了（读一次 CDP 是毫秒级，主要是别太频繁）；
  // 但仿真用倍速跑，倍速越高越要读得勤，否则一整段会在两次采样之间被跳过。
  const probeEveryMs = deps.probeEveryMs ?? PROBE_EVERY_MS;
  const build = deps.build ?? null;
  // 字幕轨的两个函数由 handler 造（它们要 boardOptions 的 cookies 等参数）
  const transcribe = deps.transcribe ?? null;
  const feedTranscript = deps.feedTranscript ?? null;
  const note = (msg) => {
    loop.logs.push(`${new Date().toTimeString().slice(0, 8)} ${msg}`);
    if (loop.logs.length > 20) loop.logs.shift();
  };
  /**
   * 转写失败：**不记进 `transcribed`**，下一拍自然重试（字幕轨的失败不该让画面停）。
   * 同一段连续三次就放弃 10 分钟 —— ASR 服务没起、片子没声音这类问题不该每 2 秒撞一次。
   */
  const failTranscribe = (seg, reason, at) => {
    const n = (loop.badTries.get(seg.from) ?? 0) + 1;
    loop.badTries.set(seg.from, n);
    // **时刻必须来自 tick 的 `tNow`（= 可注入的 `deps.now()`），不能用 `Date.now()`**：
    // 两者混用的话差值会是负的一万多亿毫秒，于是"10 分钟内跳过"变成"永远跳过"，
    // 两段式投喂的等待门槛同理永远不成立。
    if (n >= 3) loop.badSegments.set(seg.from, at);
    note(`transcribe ${Math.round(seg.from)}s failed (${n}/3): ${String(reason).slice(0, 80)}`);
  };
  // `video.currentTime` 是**毫秒级真值**。拿不到就当作"这次没读到"，
  // 由上层决定是问用户还是停表 —— 不猜、不外推到很远。
  const readBrowser = deps.readBrowser ?? ((o) => readBrowserPosition(o));
  // 扩展上报的位置（本地一个小 JSON）。可注入：测试里不该读到这台机器上真实的播放位置。
  const readPosBridge = deps.readBridge ?? ((o) => readBridge(o));
  // 窗口"还开着吗"也可注入：真机用 pid 判活，测试里给个假的
  const windowAlive = deps.windowAlive ?? floatingWindowAlive;
  // 插话唤醒走**真**的 followup（不受 `wake: false` 影响）；可注入便于测试
  const chatWatcher = deps.chatWatcher ?? (() => chatWatcherShared());
  const chatWake = deps.wakeChat ?? ((c, o) => wakeSession(c, o));
  /**
   * **用户动作的信号**（关窗 / 换片 / 播完 / 拖进度 / 位置读不到）：一律真的叫醒。
   *
   * 和 `wake` 的区别必须分清：`wake:false`（默认）关掉的是"这一段该说话了"那种**打扰**，
   * 因为阻塞式调用本来就会在段末自己返回，再投一条只会挡住用户要说的话。
   * 但上面这几件事不是打扰 —— 是"情况变了，你得说一句，而且别再按旧的继续跑"。
   * 以前它们和段末提醒共用 `wake`，于是默认配置下**一声不响**：
   * 用户关了悬浮窗、换了片，模型那边还以为什么都没发生（2026-10-31 实报）。
   *
   * 注：仿真/测试只注入 `deps.wake`（没有 `wakeChat`），所以这里也认它 —— 那是"能真的叫醒"的桩，
   * 不是 `wake:false` 那个空实现。
   */
  const wakeSignal = deps.wakeChat ?? deps.wake ?? ((c, o) => wakeSession(c, o));
  // 端口来源：显式参数 → ~/.dsh/video.json → 环境变量（桌面版读不到 setx 的 env，所以文件优先）
  // 端口只从调用方传进来（工具层读配置）；库层不隐式读机器配置，否则单测会被本机状态影响
  const browserPort = explicitPort ?? deps.browserPort ?? null;
  // 没有会话 id 也不许起循环 —— **除非**已经有声音订阅者：那种情况下到点的词
  // 交给订阅者念，不需要叫醒任何模型（宿主的 speech service 就属于这一类）。
  if (!sessionId && listeners() === 0) return { ok: false, reason: 'no-session-id' };
  // 段可以由批次表生成，所以只有"既没给段、也没给段长"才算没段
  if ((!Array.isArray(segments) || segments.length === 0) && !(Number(segment) > 0 || Array.isArray(ramp))) {
    return { ok: false, reason: 'no-segments' };
  }

  // 批次表：开头短、逐段加长、最后稳定到 segment。
  // 传了 segments 就用它推断等长档（保持旧调用方/测试的行为）；传了 ramp 就走阶梯。
  const seedSize = Number(segment) > 0
    ? Number(segment)
    : (segments?.[0] ? Number(segments[0].to) - Number(segments[0].from) : Number(size) || 120);
  const plan = makePlan({ segment: seedSize, ramp: ramp ?? null });

  // 余量怎么算：
  //   给了 depth → 按段数（旧行为，测试和"我就想固定几段"的场合用）
  //   没给      → 按时间（默认 5 分钟），段短就自动多备几段
  const fixedDepth = Number(depth) >= 1 ? Math.min(64, Math.floor(Number(depth))) : null;
  const bufferSec = Math.max(0, Number(lookahead) || 0);
  const leadSec = Math.max(0, Number(lead) || 0);
  // 余量窗口：**按位置算**（到 pos + bufferSec 为止），不是按段数
  const windowAt = (pos) => (fixedDepth
    ? plan.from(plan.indexAt(pos), fixedDepth)
    : windowFor(plan, pos, bufferSec));

  // **同一个源 + 同一张批次表 → 接着跑，不要重开。**
  // 之前每次工具调用都 stopWatchLoop('restart')，于是：① 已说过的段（spoken）被清空；
  // ② 正在等的那一段被新表重切、原时间点消失。用户看到的就是"说要 04:45 开口，结果 05:45 才说"。
  //
  // 「同一个源」按 `sessionKey` 判，**不按字符串**：同一支片子会有两种写法 ——
  // 扩展报的是带 `?trackid=…&spm_id_from=…` 的完整地址，模型手里是干净链接。
  // 按字符串比，这两种写法每次都会判成"换源"，于是整场陪看每隔一次调用就重开一遍
  // （spoken 清空 → 已经交付过的段又被叫醒一次）。
  const samePlan = loop.active
    && sessionKey(loop.input) === sessionKey(input)
    && loop.sessionId === sessionId
    && loop.plan
    && loop.plan.segment === plan.segment
    && JSON.stringify(loop.plan.ramp) === JSON.stringify(plan.ramp);
  if (samePlan) {
    loop.ctx = ctx;
    loop.depth = fixedDepth;
    loop.bufferSec = bufferSec;
    loop.lead = leadSec;
    // 两段式投喂的两个旋钮也要跟着更新（用户中途嫌消息多就会改它）
    loop.transcriptTrack = transcriptTrack !== false;
    loop.feedLeadMs = Math.max(0, Number(feedTranscriptLeadMs) || 0);
    // **窗口守卫只许从关到开，不许从开改回关**：以前它是闭包变量，只在"新起一场"时定一次，
    // 于是第一场要不是这次开窗（比如窗口早就开着、或者上一次开窗失败），后面永远守卫不到 ——
    // 用户关了窗，钟照样跑（2026-10-31 实报："关了悬浮窗还在继续看"）。
    loop.windowGuard = Boolean(loop.windowGuard || windowGuard);
    if (cache) loop.cache = cache;
    if (Number.isFinite(cursor)) {
      loop.anchor = makeAnchor({ pos: cursor, dur: loop.dur, status, updated: Date.now() }, Date.now());
    }
    note('resumed (same input + same batch plan)');
    return { ok: true, resumed: true, ...loopStatus() };
  }

  // 走到这里说明是新的一段陪看（换源或换批次表）：停掉旧的，重建状态
  stopWatchLoop('restart');

  Object.assign(loop, {
    active: true,
    ctx,
    sessionId,
    input,
    plan,
    segments: segments?.length
      ? segments.map((s) => ({
        from: Number(s.from),
        to: Number(s.to),
      }))
      : plan.from(0, Math.min(64, (fixedDepth ?? windowFor(plan, 0, bufferSec).length) + 1)),
    spoken: [],
    // **换源就必须清掉"上一支片子"的痕迹**：`dur` / `sourceUrl` 留着的话，
    // 新片子第一次读数就会和旧值不一样，于是被判定成"换片"当场停掉。
    dur: null,
    sourceUrl: null,
    status: 'playing',
    // 余量：fixedDepth 为 null 时按 bufferSec 动态算（段短就多备几段）。
    // 起点那几段只有 1/2/3 分钟，固定"两段"在最前面等于只有 2 分钟余量 —— 不够。
    depth: fixedDepth,
    bufferSec,
    lead: leadSec,
    speakEvery: Math.max(0, Number(speakEvery) || 0),
    lastSpeechAt: null,
    // 声音引擎"到什么时候才空出来"（毫秒墙钟）。换一场必须清零，否则新一场开头会被上一场卡住。
    voiceBusyUntil: 0,
    refillBelow: Math.max(0, Number(refillBelow) || 0),
    refillAskedAt: 0,
    lastSpeakAt: 0,
    lastJumpWakeAt: 0,
    built: new Set(),        // 已经建好的批次（按 from 记）
    building: null,          // 正在建的那一个（同时只建一个，别把 CPU 打满）
    aheadSec: 0,
    lastIdlePos: null,
    lastMoveAt: 0,
    unknownSince: 0,
    askedAt: 0,
    lastProbeAt: 0,
    lastReason: 'started',
    // 窗口守卫（关窗即收工）：这次真的开过窗才为 true；resume 路径只能把它从 false 抬到 true
    windowGuard: Boolean(windowGuard),
    cache: cache ?? null,
    lastBuildMs: 0,
    buildingFrom: null,
    // ---- 字幕轨（和画面轨对称：各一个"正在跑"的 flag、各一个 Set）
    transcribed: new Set(),      // 已经转过写的段（按 from 记）
    transcribedAt: new Map(),    // 什么时候转好的（两段式投喂的等待门槛要用）
    fedTranscript: new Set(),    // 台词已经单独推给模型的段
    transcribing: null,          // 正在转写的那一个（同时只转一个）
    transcribingFrom: null,
    badTries: new Map(),         // 段 → 连续失败次数
    badSegments: new Map(),      // 段 → 放弃时刻（10 分钟内不再试）
    lastTranscript: null,        // { from, source, seconds, lines }，给 statusOnly 看
    transcriptTrack: transcriptTrack !== false,
    feedLeadMs: Math.max(0, Number(feedTranscriptLeadMs) || 0),
    lastSpeechLateSec: null,
    log,
  });

  // 用户自报的 cursor 当作"刚刚刷新过的真值"，比任何外推都可信
  loop.anchor = Number.isFinite(cursor)
    ? makeAnchor({ pos: cursor, dur: null, status, updated: Date.now() })
    : null;

  void readLatency().then((st) => { loop.aheadSec = aheadSeconds(st); });

  // 换一场就把"上一场说过的话"清干净：`busyUntil` 和"刚回过的位置"留着的话，
  // 新一场开头十几秒会被上一场的回话卡住（表现为"它不说话"，而且看不出原因）。
  __resetReplyGuard();

  /**
   * 大跳（拖动/回看）要说一声 —— 阈值 60 秒 + 3 分钟冷却（拖一下就问一句会烦死人）。
   *
   * **改成每一拍都看**（位置桥每秒都有读数），不再等 15 秒一次的探针：
   * 用户拖完进度条，模型还按旧进度准备台词，最多差出十几秒的沉默。
   */
  const noteBigJump = (b, tNow) => {
    if (!loop.anchor || !Number.isFinite(Number(b?.pos)) || loop.status === 'paused') return false;
    const elapsedSec = Math.max(0, (tNow - loop.anchor.updated) / 1000);
    const expected = loop.anchor.pos + elapsedSec;
    const jump = Number(b.pos) - expected;
    if (Math.abs(jump) <= 60 || tNow - (loop.lastJumpWakeAt || 0) <= 180_000) return false;
    loop.lastJumpWakeAt = tNow;
    void wakeWithRetry({
      ctx: loop.ctx,
      sessionId: loop.sessionId,
      wake: wakeSignal,
      note,
      text: `[一起看] 用户拖了进度条：${jump > 0 ? '跳到' : '回看到'} ${mmss(b.pos)}`
        + `（原来到 ${mmss(expected)}）。`
        + (jump < 0
          ? '回看的部分不会再重说一遍（避免复读）；要不要简单补一句，你自己判断。'
          : '跳过的部分不补；从新位置接着跟就行。'),
    });
    return true;
  };

  /**
   * 换片/播完：停表 + 叫醒（循环停了之后就没人再轮询，必须叫这一下）。
   *
   * **必须真的叫醒**：这条消息是"别再按旧片子跑了"的指令，不是提醒。
   */
  const stopForSource = (reason, text) => {
    stopWatchLoop(reason);
    void wakeWithRetry({
      ctx: loop.ctx, sessionId: loop.sessionId, wake: wakeSignal, note, text,
    });
  };

  loop.ticker = ticker({
    everyMs: TICK_MS,
    tick: async () => {
      const tNow = now();

      // 用户插话：模型可能正闲着（不在阻塞等待里），这时候也得把它叫起来回一句。
      // 用共享 watcher 消费一条就够 —— 它本来就只报"增量"，我这边消费了，
      // 下一次阻塞等待就不会重复报同一句。
      //
      // **有人在阻塞等待时不许碰**：等待里的 `poll()` 才是唯一能把人从"等结果"里
      // 叫出来的路（投 followup 得等这一轮结束才处理），通道被这里吃掉就再也回不来了。
      if (wakeOnChat && loop.sessionId && chatWaiterCount() === 0) {
        let said = null;
        try { said = chatWatcher()?.() ?? null; } catch { said = null; }
        const chatText = String(said?.text ?? '').trim();
        // **同一条不投第二遍**（2026-11-01 实报"大肥鱼已经重复了"）：`poll()` 自己按
        // `lastAt` 去重，理论上不会重报；但它在**投递之前**就推进了游标 —— 万一投递
        // 这一拍正好撞上模型刚被唤醒、新一轮还没开始读，下一拍不会有补偿，只会漏。
        // 而那之后模型回完话再调 `watch_together`，`replyReminder` 又会把"你还没回"顶出来，
        // 用户看到的就是同一句话被当成两件事。这里按 `at` 记一条已投，彻底封住重投。
        if (chatText && said?.at !== loop.lastChatFed?.at) {
          loop.lastChatFed = { at: said.at, text: chatText };
          note('user said → wake');
          void wakeWithRetry({
            ctx: loop.ctx,
            sessionId: loop.sessionId,
            // 措辞和阻塞等待里的插话**必须是同一份**（interject.js）：
            // 以前这里只写"先回这一句"，模型就以为"回"是指聊天框里的回复 ——
            // 而那句话用户根本看不见，表现出来就是"一声不吭"。
            text: `${interjectNote(chatText.slice(0, 200), { at: said.at })}\n\n回完再调 watch_together 接着陪。`,
            wake: chatWake,
            note,
          });
        }
      }

      // 每一拍先看窗口还在不在：关掉就别再跟了。
      // 放在读位置之前 —— 窗口没了就没有"插话入口"，继续跟只会占着会话。
      //
      // **这一下必须真的叫醒**（`wakeSignal`，不走 `wake`）：`wake:false` 关的是"段末该说话了"
      // 那种打扰，而"用户把窗口关了"是用户下的指令 —— 不叫他，模型那边只会看到时间停住，
      // 表现就是"关了他还在看、还在念台词，根本不会自己结束"（2026-10-31 实报）。
      //
      // **不投 followup，落一条待领的挂断**（2026-11-01 用户要求"不出现队列消息"）：
      // `followup` 会进宿主 inbox 的 `next-turn`，而 DSH 的 QueueDock **不过滤 source**，
      // 于是插件自己的提示会显示在输入框的"排队消息"里 —— 用户没说话却看见一条待发消息。
      // 挂断本来也不需要模型立刻醒：钟已经停了，不会再念词、不会再建图，模型这一轮
      // 是阻塞在被我们中断的工具调用里，返回结果时把这条带上就行（见 handler 的 hangupNote）。
      if (loop.windowGuard && !windowAlive()) {
        stopWatchLoop('widget-closed');
        try { await markHungUp(loop.input, undefined, HANGUP_NOTE); } catch { /* 记不住也不影响停 */ }
        note('window closed → hung up (note delivered on next tool result)');
        return;
      }

      // ---- 每一拍校一次**扩展上报的位置**（读一个小 JSON，不是 CDP）。
      //
      // 为什么不能只靠 15 秒一次的探针：中间那段位置是按时钟外推的。用户一按暂停，
      // 钟还会继续走最多 15 秒 —— 这段时间里"到点"的台词会**提前**吐出来，
      // 用户看到的就是"时间点比视频早"（2026-10-31 实报）。
      // 只在"位置本来就来自扩展"时走这条，别的来源（CDP / 用户给的 cursor）不掺和。
      if (loop.positionSource === 'bridge' && loop.anchor) {
        const s = await readPosBridge({ now: tNow }).catch(() => null);
        if (s && Number.isFinite(s.pos)) {
          // **换片/播完/大跳一律在这一拍判**。以前这三件事只写在 15 秒一次的探针里，
          // 而位置桥**每秒**都在报 —— 用户切了片子，要等到下一次探针（最多 15 秒）
          // 才被发现；那十几秒里钟还在按旧片的段边界算，模型也在按旧片准备台词。
          const switched = sourceSwitched({ dur: loop.dur, url: loop.sourceUrl }, s);
          if (switched) {
            stopForSource('video-changed', `[一起看] 换片了（现在在放：${(s.title ?? '').slice(0, 60) || '未知片子'}`
              + ` @ ${mmss(s.pos)}）。跟用户确认一下要不要接着陪这支：要的话重新调 watch_together 就会从头开始跟。`);
            return;
          }
          if (s.ended) {
            stopForSource('video-ended', '[一起看] 视频播完了。跟用户收个尾，或者问下一支看什么 —— '
              + '用户开了新片之后重新调 watch_together 就会接着陪。');
            return;
          }
          noteBigJump(s, tNow);
          loop.anchor = makeAnchor({
            pos: s.pos, dur: s.dur, status: s.paused ? 'paused' : 'playing',
            updated: tNow, title: s.title,
          }, tNow);
          // **基线跟着更新**：不更新的话，下一次读数永远和"刚开始那支"比 ——
          // 一支片子中途 dur 精确到小数变了都会被当成换片。
          // `Number.isFinite(null)` 为 false，所以"扩展没报时长"不会把基线写成 0 秒
          // （写成 0 的下一次读数就是"时长变了"→ 当场判定换片）。
          if (Number.isFinite(s.dur)) loop.dur = s.dur;
          if (s.url) loop.sourceUrl = s.url;
          loop.status = s.paused ? 'paused' : 'playing';
        }
      }

      if (tNow - loop.lastProbeAt >= probeEveryMs) {
        loop.lastProbeAt = tNow;
        // **唯一的来源**：浏览器调试端口里那个 <video>。
        // 不默认读 9222：这台机器上 WorkBuddy 自己就占着它，盲读会读到宿主的界面元素。
        const b = await readPositionOrNull(readBrowser, browserPort);
        if (b) {
          // 换片：判据和位置桥那条**同一份**（`sourceSwitched`）—— 两处各写一套，
          // 就会出现"扩展通道能认出来、调试端口认不出来"这种只在某些机器上复现的怪事。
          const switched = sourceSwitched({ dur: loop.dur, url: loop.sourceUrl }, b);
          if (switched) {
            stopForSource('video-changed', `[一起看] 换片了（现在在放：${(b.title ?? '').slice(0, 60) || '未知片子'}`
              + ` @ ${mmss(b.pos)}）。跟用户确认一下要不要接着陪这支：要的话重新调 watch_together 就会从头开始跟。`);
            return;
          }
          // **大跳转（拖进度条，前进或后退）**：位置对不对由锚点自然纠正，
          // 但模型得知道用户跳了，否则它还在按旧进度准备台词。
          noteBigJump(b, tNow);

          loop.anchor = makeAnchor({
            pos: b.pos, dur: b.dur, status: b.paused ? 'paused' : 'playing',
            // 浏览器是刚读的，所以永远算"新鲜"。
            // **用 tNow 而不是 Date.now()**：循环的时钟是注入的（仿真用虚拟时间），
            // 两边混用会让 staleMs 变成几十万毫秒，位置立刻被判成 unknown。
            updated: tNow, title: b.title,
          }, tNow);
          loop.status = b.paused ? 'paused' : 'playing';
          loop.positionSource = b.source ?? 'cdp';
          if (Number.isFinite(b.dur)) loop.dur = b.dur;
          if (b.url) loop.sourceUrl = b.url;
          loop.noSourceSince = 0;
          if (b.ended) {
            // 片尾和换片一样：停表 + 叫醒。模型收个尾、问下一支看什么。
            stopForSource('video-ended', '[一起看] 视频播完了。跟用户收个尾，或者问下一支看什么 —— '
              + '用户开了新片之后重新调 watch_together 就会接着陪。');
            return;
          }
        } else {
          // 读不到：浏览器关了 / 页签切走了 / 播放器卡死。
          // **这里不停表** —— 交给下面两条路决定：
          //   · 有旧锚点 → 锚点会变旧 → 判成 position-unknown → 先问用户一次，问不到再停；
          //   · 从来没读到过（锚点为空）→ 就没有"变旧"可言，靠 noSourceSince 兜。
          loop.noSourceSince = loop.noSourceSince || tNow;
        }
        const st = await readLatency();
        loop.aheadSec = aheadSeconds(st);
      }

      if (!loop.anchor) {
        loop.lastReason = 'no-anchor';
        // 从来没读到过位置：没有锚点可变旧，只能靠这个计时器兜底。
        // 5 分钟还没读到就不等了（正常情况下 watch_run 在开循环前就会失败）。
        if (loop.noSourceSince && tNow - loop.noSourceSince > NO_SOURCE_GIVE_UP_MS) {
          stopWatchLoop('position-unreadable');
          return;
        }
        return;
      }

      // ---- 空闲自关：位置两倍最长分段都没动过，就别再空转。
      // 两种"位置冻住"都算：① 在播但不推进（页签挂起 / 播放器崩 / 人走了）；
      // ② **视频被暂停且没人动** —— 暂停时位置本来就不会走，模型不知道人还看不看，
      //    得靠这个判定它走开了。读不到（stale/unknown）是另一条路（先问一次再停表），别在这儿抢。
      {
        const estIdle = estimate(loop.anchor, tNow);
        const idleMs = Math.max(60_000, 2 * Number(plan.segment) * 1000);
        // 只在"位置已知且新鲜"时判空闲：刚刷到的在播读数（recent-refresh）或暂停读数（paused）。
        // 两者位置都是真值、只是没动；读不到（stale/unknown）交给下面的 position-unknown 处理。
        if (Number.isFinite(estIdle.pos) && estIdle.confidence === 'fresh'
          && (estIdle.why === 'recent-refresh' || estIdle.why === 'paused')) {
          if (Math.abs(estIdle.pos - (loop.lastIdlePos ?? -1)) >= 0.5) {
            loop.lastIdlePos = estIdle.pos;
            loop.lastMoveAt = tNow;
          } else if (loop.lastMoveAt && tNow - loop.lastMoveAt >= idleMs) {
            loop.log(`[watch] idle ${Math.round(idleMs / 60_000)} min at ${Math.round(estIdle.pos)}s - stopping`);
            // 停表之外必须叫醒：钟停了之后就没人再轮询聊天框了，
            // 用户之后说什么都收不到 —— 不叫的话这是一个死胡同。
            stopWatchLoop('idle');
            void wakeWithRetry({
              ctx: loop.ctx,
              sessionId: loop.sessionId,
              wake: wakeSignal,
              note,
              text: `[一起看] 看起来停了一会儿（${Math.round(estIdle.pos)} 秒的位置上，`
                + `${Math.round(idleMs / 60_000)} 分钟没动），我先停了。`
                + '想继续就说一声，重新调 watch_together 就接着陪。',
            });
            return;
          }
        }
      }

      // ---- 预取：保证"当前段 + 后面的余量"里，还没建好的那一个有人在建。
      // 余量按时间算（默认 5 分钟），所以开头段短时会连着建 3、4 段，不是固定两段。
      // 一个时刻只建一个批次 —— 这台机器解码是 CPU 密集的，并行只会互相拖慢。
      if (build && !loop.building) {
        const nowEst = estimate(loop.anchor, tNow);
        const idxNow = plan.indexAt(nowEst.pos);
        const winNow = windowAt(nowEst.pos);
        const next = loop.segments
          .slice(idxNow, idxNow + winNow.length)
          .find((sg) => !loop.built.has(sg.from));
        if (next) {
          loop.buildingFrom = next.from;
          loop.building = (async () => {
            const t = Date.now();
            try {
              await build(next.from);
              loop.built.add(next.from);
              loop.lastBuildMs = Date.now() - t;
              note(`built ${Math.round(next.from)}s in ${((Date.now() - t) / 1000).toFixed(1)}s`);
            } catch (e) {
              note(`build ${Math.round(next.from)}s failed: ${String(e?.message ?? e).slice(0, 80)}`);
            } finally {
              loop.building = null;
              loop.buildingFrom = null;
            }
          })();
        }
      }

      // ---- 字幕轨：和画面轨**结构对称** —— 同一个 `windowAt`、同一个 `idxNow`，只换了 Set。
      //
      // 为什么必须共用窗口：两轨的"余量"口径不一样，就会出现"它说 04:00 开始、实际建的是 03:00 那段"
      // （batches.js 里写过这个坑）。所以这里不复制任何常量。
      //
      // 字幕的生产速度是画面的 10 倍以上（实测 ASR RTF 0.019，5 分钟段 ≈ 6 秒），
      // 所以它天然跑在前面；跑到窗口边界时 `find` 返回 undefined，这一轨自己就停了 ——
      // "谁的余量满了谁停"是这段代码的自然结果，不需要额外判断。
      if (transcribe && loop.transcriptTrack && !loop.transcribing) {
        const nowEst = estimate(loop.anchor, tNow);
        const idxNow = plan.indexAt(nowEst.pos);
        const winNow = windowAt(nowEst.pos);
        const next = loop.segments
          .slice(idxNow, idxNow + winNow.length)
          .find((sg) => {
            if (loop.transcribed.has(sg.from)) return false;
            const badAt = loop.badSegments.get(sg.from);
            if (badAt && tNow - badAt < 600_000) return false;   // 放弃过，10 分钟内跳过
            if (badAt) loop.badSegments.delete(sg.from);         // 过期了，允许再试一次
            return true;
          });
        if (next) {
          loop.transcribingFrom = next.from;
          loop.transcribing = (async () => {
            const t = Date.now();
            try {
              const r = await transcribe(next.from, next.to);
              if (!r?.ok) {
                failTranscribe(next, r?.reason ?? 'failed', tNow);
                return;
              }
              loop.transcribed.add(next.from);
              // 记的是**循环的钟**：投喂门槛拿它跟下一拍的 `tNow` 比，必须是同一个时钟。
              loop.transcribedAt.set(next.from, tNow);
              loop.badTries.delete(next.from);
              const secs = +((Date.now() - t) / 1000).toFixed(1);
              loop.lastTranscript = { from: next.from, source: r.source, seconds: secs, lines: r.segments?.length ?? 0 };
              note(`transcribed ${Math.round(next.from)}s in ${secs}s (${r.source})`);
            } catch (e) {
              failTranscribe(next, String(e?.message ?? e), tNow);
            } finally {
              loop.transcribing = null;
              loop.transcribingFrom = null;
            }
          })();
        }
      }

      // ---- 两段式投喂的第一段：**字幕先到、画面还没到**的那一段，先把台词推给模型。
      //
      // 只喂**后面**的段：当前段会和图一起给，先喂一遍等于同一段说两遍。
      // 图已经在建/已经建好的一律不喂 —— 那种情况让图带着词一起给（兜底路径，见设计里的第三种状态）。
      // `feedLeadMs` 默认 0（一到就喂）；给 20000 就是"20 秒后画面还没来才推"。
      if (feedTranscript && loop.transcriptTrack) {
        const nowEst = estimate(loop.anchor, tNow);
        const idxNow = plan.indexAt(nowEst.pos);
        const winNow = windowAt(nowEst.pos);
        for (const sg of loop.segments.slice(idxNow + 1, idxNow + winNow.length)) {
          if (!loop.transcribed.has(sg.from) || loop.fedTranscript.has(sg.from)) continue;
          if (loop.built.has(sg.from) || loop.buildingFrom === sg.from) continue;
          if (tNow - (loop.transcribedAt.get(sg.from) ?? tNow) < loop.feedLeadMs) continue;
          const got = await feedTranscript(sg.from, sg.to).catch(() => null);
          if (!got?.ok) continue;                 // 拿不到就下一拍再说（**不标记**，别把这句吞了）
          const w = await wakeWithRetry({
            // 这一条是**推消息进会话**，和 `wakeSignal` 同一类（不受 `wake:false` 影响）：
            // 台词先到就先送过去，不该因为"段末不打扰"而一声不响。
            ctx: loop.ctx, sessionId: loop.sessionId, wake: wakeSignal, note, text: got.text,
          });
          recordWake(w, { segment: sg.from });
          if (w?.ok) {
            loop.fedTranscript.add(sg.from);
            note(`fed transcript ${Math.round(sg.from)}s (${got.lines} lines)`);
          } else {
            note(`feed transcript ${Math.round(sg.from)}s → ${w?.reason ?? 'failed'}`);
          }
          break;    // 一拍只喂一段：一次 followup 就是一轮模型调用，别一口气塞三条
        }
      }

      // ---- 窗口自增长：只排到"当前位置 + 余量"，然后随进度往前滚。
      // 早先这里只在起循环时排一次（3 段），如果 agent 用了预设台词而不调工具，
      // 循环就再也没被重启过 —— 6 分钟之后它会在 not-due 里静静躺着，再也不说话。
      {
        const nowEst = estimate(loop.anchor, tNow);
        const idxNow = plan.indexAt(nowEst.pos);
        // 段列表要比"预取范围"再长一段，否则 slice 拿不到够多的段可建
        const want = idxNow + windowAt(nowEst.pos).length + 1;
        let guard = 0;
        while (loop.segments.length < want && guard < 200) {
          const i = loop.segments.length;
          const seg = plan.from(i, 1)[0];
          if (Number.isFinite(loop.dur) && seg.from >= loop.dur) break;
          loop.segments.push(seg);
          guard += 1;
        }
      }

      // ---- 台词库存检查：余量不足就**叫醒模型去写**（这是唯一该叫它的理由）
      // 脚本自己不会写台词 —— 它只念。写作是模型的事，库存不够就得有人去补。
      if (loop.refillBelow > 0 && tNow - (loop.refillAskedAt || 0) > 300_000) {
        const estR = estimate(loop.anchor, tNow);
        const idxNow = plan.indexAt(estR.pos);
        const missing = [];
        for (let i = idxNow + 1; i <= idxNow + loop.refillBelow; i += 1) {
          const seg = plan.from(i, 1)[0];
          if (!seg) break;
          if (!(await hasLine(loop.input, seg.from).catch(() => false))) missing.push(seg);
        }
        if (missing.length > 0) {
          loop.refillAskedAt = tNow;
          const list = missing.map((m) => `${mmss(m.from)}–${mmss(m.to)}`).join('、');
          const w = await wakeSignal(loop.ctx, {
            sessionId: loop.sessionId,
            text: `[一起看·补词] 台词库存不够了：${list} 还没有词（现在 ${mmss(estR.pos)}）。`
              + '先用 watch_together({ speakNow: true }) 看画面，再用 lines: [...] 补上。',
          });
          recordWake(w, { segment: missing[0].from });
          note(`refill-needed ${missing.map((m) => m.from).join(',')} → ${w?.ok ? 'ok' : w?.reason ?? 'failed'}`);
          return;
        }
      }

      // ---- 台词：到点就把这句**交出去** —— 展示和出声是两件事，不能绑在一起。
      //   `emitSpeech` 发给所有订阅者：`attachSpeechToChat` 收到就写进 chat.jsonl
      //   （悬浮窗读的就是这一份），会出声的只有 `voice: true` 那几个。
      //
      // **以前整块包在 `speechSubscribers() > 0` 里**，于是没挂声音适配器（或者适配器没加载起来）时
      // 台词凭空消失：用户写了 `lines`，悬浮窗里一句也看不到，台词槽还不会被消费、一直积着。
      // 2026-10-31 实报 → 现在无论有没有声音，到点都先交出去。
      //
      // **由播放位置触发，不由墙钟**：位置停在 03:12 就一直等着；位置到哪一句的 at，就发哪一句。
      // 这里不看 speakEvery —— 那是"多久叫一次模型"，和"什么时候该念这句话"是两件事。
      {
        // **声音是有预算的**：一句话念完要 `字数/5` 秒，声音引擎是**串行**的
        // （上一句念完才轮到下一句）。上一句还在说的时候又塞一句进去，只会排队；
        // 队一旦长起来，声音离画面就越来越远 —— 2026-10-31 实报："话太密会导致语音越来越滞后"。
        // 所以：说的时候这一拍不发，等空下来再说（真拖过头的会被 `dueLine` 的迟到作废丢掉，
        // 也就是"追不上就少说一句"，而不是"越说越晚"）。
        // 只对"真有人念"生效 —— 没人接声音时台词只进流，不该被这个节流。
        //
        // **两个来源都要算**：① 循环自己刚发过一句（`voiceBusyUntil`）；
        // ② 模型刚用 `say` 回了一句（`replyBusyUntil`）。以前只算①，
        // 于是回话刚开口两秒，脚本那句就塞进串行链 —— 排队太久会被适配器
        // 当作"追不上画面"直接丢掉（连字都不出现）。
        const voiceBusy = listeners() > 0
          && (tNow < (loop.voiceBusyUntil ?? 0) || tNow < replyBusyUntil());
        const est = estimate(loop.anchor, tNow);
        // **位置不可信就不许念**（2026-10-31 实报："关了浏览器还在念台词"）。
        //
        // 以前这里只排除了 `paused`，剩下的全放行 —— 而 `estimate()` 在读数停住时
        // 会**按时钟往前推**（`extrapolated`），推太久再降级成 `unknown`，但**两种情况的 `pos` 都是有限的**。
        // 于是关掉浏览器/切走页签之后，钟还在一点点往前走，把后面的台词一句句念出来。
        //
        // 现在的口径：`fresh`（刚读过）照常；`extrapolated` 只在"没超过 SAFETY_AFTER_MS"时允许
        // （那是正常的两拍间隙，不该为此晚 10 秒才说话）；`unknown` 一句都不发。
        const positionUsable = est.confidence === 'fresh'
          || (est.confidence === 'extrapolated' && est.staleMs <= SAFETY_AFTER_MS);
        if (!voiceBusy && est.why !== 'paused' && positionUsable && Number.isFinite(est.pos)) {
          const segNow = plan.segmentAt(est.pos);
          const due = await dueLine(loop.input, est.pos, {
            size: segNow.size,
            // 别的段的稿子要按**那一段自己的长度**铺（批次表是 1/2/3/4/5 分钟递进的）
            sizeOf: (f) => plan.segmentAt(f).size,
            // meta: 顺带拿到"本该第几秒开口"，用来算这句迟到多久（statusOnly 里能看到）
            meta: true,
          }).catch(() => null);
          const line = due ? String(due.text ?? due) : null;
          if (line) {
            const delivered = speak({
              at: est.pos, text: line, input: loop.input, segment: segNow.from,
            });
            if (delivered > 0) {
              loop.lastSpeechAt = tNow;
              if (due && Number.isFinite(due.late)) loop.lastSpeechLateSec = due.late;
              // 记下"引擎到什么时候才空出来"。**用完整时长**（不是 speechLag 的一半，
              // 那是"什么时候可以插话"，两件事）。
              if (listeners() > 0) loop.voiceBusyUntil = tNow + speechSeconds(line.length) * 1000;
              note(`speech ${Math.round(est.pos)}s → ${delivered} listener(s): ${line.slice(0, 20)}…`);
              loop.lastReason = 'spoke';
              // **只有"真有人念"才算说过了**：只写进流不算 —— 那样模型再也不会被叫醒，
              // 用户就只能盯着悬浮窗里一句没人念的字。
              if (listeners() > 0) return;
            }
          }
        }
      }

      // ---- 高频模式：不受批次边界限制，每 speakEvery 秒叫一次（测试/密集解说用）
      if (loop.speakEvery > 0) {
        const est = estimate(loop.anchor, tNow);
        const gap = tNow - (loop.lastSpeakAt || 0);
        const within = Number.isFinite(loop.dur) ? est.pos < loop.dur - 1 : true;
        if (gap >= loop.speakEvery * 1000 && within && est.why !== 'paused') {
          loop.lastSpeakAt = tNow;
          const seg = plan.segmentAt(est.pos);
          // 高频模式**本来就是"叫我"**（模型显式开着 speakEvery），所以走真叫醒，
          // 不该被 `wake: false`（那是段末打扰的开关）连带关掉。
          const w = await wakeSignal(loop.ctx, {
            sessionId: loop.sessionId,
            text: `[一起看·高频] 现在 ${mmss(est.pos)}（这一段 ${mmss(seg.from)}–${mmss(seg.to)}）。`
              + '调 watch_together({ speakNow: true }) 拿当前画面，然后说一句。',
          });
          recordWake(w, { segment: seg.from });
          note(`speak-now ${Math.round(est.pos)}s → ${w?.ok ? 'ok' : w?.reason ?? 'failed'}`);
          return;
        }
      }

      const r = shouldSpeak({
        anchor: loop.anchor,
        segments: loop.segments,
        spoken: loop.spoken,
        now: tNow,
        lead: loop.lead ?? WATCH_LEAD,
        aheadSec: loop.aheadSec,
      });
      loop.lastReason = r.reason ?? 'not-due';

      if (r.reason === 'position-unknown') {
        if (!loop.unknownSince) loop.unknownSince = tNow;
        const unknownFor = tNow - loop.unknownSince;

        // 读不到就**问一次**，别静默。静默的后果是用户以为它坏了。
        if (unknownFor >= ASK_AFTER_MS && tNow - (loop.askedAt ?? 0) >= ASK_COOLDOWN_MS) {
          loop.askedAt = tNow;
          const stale = Math.round((r.staleMs ?? 0) / 1000);
          const w = await wakeSignal(loop.ctx, {
            sessionId: loop.sessionId,
            text: `[一起看] 读不到你的播放进度了（浏览器最后一次读到位置是在 ${stale} 秒前）。`
              + '问一句"你看到几分几秒了"，拿到答复就带 cursor 再调 watch_together。',
          });
          loop.log(`[watch] ask-for-cursor (${stale}s stale) → ${w.ok ? 'ok' : w.reason}`);
        }

        if (unknownFor > UNKNOWN_GIVE_UP_MS) {
          // 读不到就别空转：停掉，等用户给 cursor 重新起
          stopWatchLoop('position-unreadable');
        }
        return;
      }
      loop.unknownSince = 0;
      loop.askedAt = 0;

      if (!r.speak) return;
      const seg = loop.segments.find((x) => x.from === r.segment);

      loop.spoken.push(r.segment);
      // 有预设台词就直接给稿子：省掉"现场想"的那 2–4 秒，也省一次看图的 token
      // **念完就删**：取和删放一起，避免"取到了但没删"导致重看时同一句说两遍
      // 交付点（to - lead）通常早于这一段里最后几句的 at。只取已经到点的那句：
      // 否则第一句未来的词会被提前塞进叫醒文案，到点后槽里已经没了。
      const line = await consumeLine(loop.input, r.segment, { notAfter: r.pos })
        .catch(() => loadLine(loop.input, r.segment).catch(() => null));
      const head = `[一起看] ${mmss(seg.from)}–${mmss(seg.to)} 该说话了`
        + `（用户大约看到 ${mmss(r.pos)}${r.confidence === 'extrapolated' ? '，按墙钟推算' : ''}）。`;
      const text = line
        ? `${head}\n你之前写好的那句：「${line}」\n直接说这句就行；觉得不对就调 watch_together 看一眼再改。`
        : `${head}\n调 watch_together 拿这一段的画面，然后只说一句。`;
      const w = await wake(loop.ctx, { sessionId: loop.sessionId, text });
      recordWake(w, { segment: r.segment });
      note(`wake ${r.segment}s (${r.confidence}) → ${w?.ok ? 'ok' : w?.reason ?? 'failed'}`);
    },
  });

  loop.log(`[watch] loop started: ${loop.segments.length} segment(s), session ${sessionId}`);
  return { ok: true, ...loopStatus() };
}

export const LOOP_LIMITS = Object.freeze({
  TICK_MS, PROBE_EVERY_MS, UNKNOWN_GIVE_UP_MS, MAX_EXTRAPOLATE_MS, ASK_AFTER_MS, ASK_COOLDOWN_MS,
  NO_SOURCE_GIVE_UP_MS,
});

