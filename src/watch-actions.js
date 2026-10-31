/**
 * watch-actions.js — `watch_together` 的**单发命令**：不进主流程，一问一答就结束。
 *
 * 从 index.js 拆出来的。这些东西放在工具注册函数里，会把"注册五个工具"这件事淹掉，
 * 而且它们各自回答的是不同的运维问题：
 *
 *   stopLoop    停钟（唯一一个"只写不读"的命令）
 *   statusOnly  钟在哪、浏览器在不在 —— **只问不建**，排查"它为什么没反应"的第一站
 *   checkCookies   B 站登录态 / 字幕可用性 —— 能立刻回答"为什么还在用 ASR"
 *   testWake    5 秒内回答"loop 到底叫不叫得醒我"
 *
 * **没有语音相关的命令**：核心不发声，念不念由订了 `speech` 事件的那一方决定
 * （见 voice.js 和 README 的「接声音」）。
 *
 * 返回 `null` 表示"这一轮不是单发命令"，交给主流程。**判据在调用方之外只有这一条**。
 */

import { configuredPort, probeBrowser } from 'dsh-video-storyboard/browser-time';
import { checkBiliLogin, fetchRemoteSubtitles } from 'dsh-video-storyboard/subtitles';
import { loadCues, sentencesBetween } from './lines-util.js';
import { linesOverview } from './watch-lines.js';
import { markMaterial, materialNote } from './watch-material.js';
import { controllerOf, wakeSession } from './timer.js';
import { loopStatus, stopWatchLoop } from './watch-loop.js';
import { appendAssistantSay } from './chat.js';
import { setWindowHidden } from './floating-window.js';
import { lastSpeech } from './voice.js';
import { mmss } from './time.js';

export async function runWatchAction(args, { ctx = null, sessionId = null, browserPort } = {}) {
  // 模型插话时说的那一句：写进统一流 + 交给声音。不占图片、不等位置，所以排在所有单发命令最前面。
  if (typeof args.say === 'string' && args.say.trim()) {
    const entry = appendAssistantSay(args.say, { t: lastSpeech()?.at ?? null });
    return { text: JSON.stringify({ ok: true, said: entry?.text ?? '', inChat: true }), images: [] };
  }

  // `stop` 是别名：用户说"停止一起看"时，模型第一反应就是敲 stop
  if (args.stopLoop === true || args.stop === true) {
    return { text: JSON.stringify(stopWatchLoop('requested')), images: [] };
  }

  // **藏起来 / 放出来**：和关窗是两件事（关窗 = 不看了，会停表；藏起来 = 陪看继续）。
  // 用户的原话是"如果有其他功能隐藏悬浮窗会更好"（2026-11-01）—— 他嫌它挡画面，
  // 但并不想结束陪看。窗口进程不动，只写一个配置键，窗口自己每 200ms 读一次。
  if (args.window === 'hide' || args.window === 'show') {
    const want = args.window === 'hide';
    const r = setWindowHidden(want);
    if (!r.ok) {
      return {
        images: [],
        text: `[window] ${r.reason === 'window-not-open'
          ? '悬浮窗没开着，没什么可藏的'
          : r.reason === 'disabled'
            ? '这台机器关掉了悬浮窗（DSH_WATCH_NO_WIDGET=1）'
            : `切不过去（${r.reason}）`}。`,
      };
    }
    // 藏起来之后用户看不见窗口，所以这句话只能靠 `say` 进流 —— 让它自己说一句
    return {
      images: [],
      text: `[window] 悬浮窗已${want ? '藏起来（陪看继续，位置照跟、台词照念）' : '放出来'}。`
        + '别调 stop，也别当成"用户不看了" —— 关窗才是那个意思。',
    };
  }

  // **只取字幕**：图和字幕要拆开返回时走这条（`transcript: true`）。
  // 台词需要的是"句子 + 它的真实秒数"，两样字幕里都有；图另一次给。
  // 这里顺带记下"字幕这一半已经交到模型手里了"，交付时才敢说"素材齐了，写台词"。
  if (args.transcriptOnly === true || args.transcript === true) {
    const input = typeof args.input === 'string' ? args.input : '';
    if (!input) return { text: '[transcriptOnly] 需要 `input`（视频链接或路径）', images: [] };
    const size = Number(args.size) > 0
      ? Number(args.size)
      : (Number(args.segment) > 0 ? Number(args.segment) : 120);
    const from = Number.isFinite(Number(args.from)) ? Number(args.from) : null;
    if (from === null) {
      return {
        text: '[transcriptOnly] 需要 `from`（这一段从第几秒开始）。不知道就先用 statusOnly 看当前段。',
        images: [],
      };
    }
    // 只取这一段窗口的 cue：没有 CC 字幕时 `loadCues` 会走 ASR，只转写这一段才有意义
    // （不传窗口就永远只转 0–30 秒，后面的段全拿不到时间码）。
    const cuesRes = await loadCues(input, { start: from, end: from + size })
      .catch((e) => ({ ok: false, reason: String(e?.message ?? e) }));
    if (!cuesRes.ok) {
      return {
        text: `[transcriptOnly] 拿不到字幕（${cuesRes.reason}）。`
          + '那就用带图交付里每格下面那行转写 —— 它和这里是同一批句子。别凭印象写 `at`。',
        images: [],
      };
    }
    const max = Number(args.max) > 0 ? Number(args.max) : 10;
    const sents = sentencesBetween(cuesRes.cues, from, from + size).slice(0, max);
    const mat = await markMaterial(input, from, 'transcript').catch(() => null);
    const body = sents.map((s) => `${s.at.toFixed(1)}\t${s.text}`).join('\n');
    return {
      text: `段 ${mmss(from)}–${mmss(from + size)}｜字幕 ${sents.length} 句（每行：秒数 + 句子）\n${body}`
        + (mat ? materialNote(mat) : '')
        + `\n写台词：\`watch_together({ lines: [{ from: ${from}, at: <上面那个秒数>, text: "…" }] })\``,
      images: [],
    };
  }

  // 只看钟的状态，不读进度、不出图 —— 排查"它为什么不说话"时用。
  // **顺带报浏览器状态**：这是唯一一个"只问不建"的入口，模型想知道
  // "浏览器到底开着没"的时候应该走这里，而不是拿播放位置去倒推。
  if (args.statusOnly === true) {
    const bp = browserPort ?? configuredPort() ?? null;
    const browser = bp
      ? await probeBrowser({ port: bp }).catch(() => ({ state: 'error', port: bp }))
      : { state: 'unconfigured', port: null };
    const st = loopStatus();
    // **台词队列深度要读盘才准**（watch.json 里的 lines）。只在诊断入口付这个成本，
    // 循环每 2 秒读一次不值得；`queued: null` 表示"没算"，不是 0。
    if (st.input) {
      try {
        const ov = await linesOverview(st.input);
        if (Array.isArray(ov)) {
          st.speech.queued = ov.reduce((n, x) => n + (Number(x.count) || 0), 0);
          st.speech.segmentsWithLines = ov.length;
        }
      } catch (e) {
        // **别静默**：这个 catch 第一次就吞掉了一个 ReferenceError（漏 import），
        // 结果只是"queued 一直是 null"，看起来像"没有台词"。错因要报出来。
        st.speech.queued = null;
        st.speech.queueError = String(e?.message ?? e).slice(0, 120);
      }
    }
    return { text: JSON.stringify({ ...st, browser }, null, 1), images: [] };
  }

  // 检查 B 站登录态与字幕可用性：这一条能立刻回答"为什么还在用 ASR"
  if (args.checkCookies === true) {
    const login = await checkBiliLogin({ cookies: args.cookies });
    const url = typeof args.input === 'string' && /^https?:/i.test(args.input) ? args.input : null;
    const subs = url ? await fetchRemoteSubtitles({ url, cookies: args.cookies }) : null;
    return {
      text: JSON.stringify({
        login,
        subtitles: subs
          ? { ok: subs.ok, reason: subs.reason, count: subs.segments?.length ?? 0, lang: subs.lang }
          : 'pass a video URL in input to check subtitles',
      }),
      images: [],
    };
  }

  // 立刻试一次唤醒，把结果原样报出来。这一条能 5 秒内回答"loop 到底叫不叫得醒我"。
  if (args.testWake === true) {
    const r = await wakeSession(ctx, {
      sessionId,
      text: '[一起看] 这是一次唤醒连通性测试，收到就不用回复内容，回一句"收到"即可。',
    });
    // **不能写 `ctx.sessionController`**：没 inject 的服务取它会直接抛错
    const sc = controllerOf(ctx);
    return {
      text: JSON.stringify({
        sessionId: sessionId ?? null,
        hasSessionController: Boolean(sc),
        hasResolveAgent: typeof sc?.resolveAgent === 'function',
        ...r,
      }),
      images: [],
    };
  }

  return null;
}

