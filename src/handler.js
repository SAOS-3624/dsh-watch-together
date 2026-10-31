/**
 * handler.js — `watch_together` 的 execute：单发命令分流 → 一次陪看调用 → 起循环。
 *
 * 三段彼此独立，顺序也不能换：
 *   1. 单发命令（watch-actions.js）：一问一答就结束，一行都不进主流程；
 *   2. 一次陪看调用（watch-run.js）：读位置、建这一段、到点交付；
 *   3. 起循环（watch-loop.js）：从这里往后每段到点自己叫醒。
 *
 * 本文件只负责"把宿主的 ctx 和机器配置接上去"，不做业务判断。
 *
 * schema + handler + 注册都在 `src/` 里，所以这个包自足。它唯一跨出去的那条线是
 * `dsh-video-storyboard`（建段、出清单）—— 那是允许的依赖方向，也是唯一的依赖。
 */

import { DEFAULT_RAMP, DEFAULT_SEGMENT } from './batches.js';
import { configuredPort } from 'dsh-video-storyboard/browser-time';
import { formatManifest } from 'dsh-video-storyboard/format';
import { runStoryboard } from 'dsh-video-storyboard/pipeline';
import { createInputSurface } from './input-surface.js';
import { appendAssistantSay } from './chat.js';
import { replyReminder } from './interject.js';
import { pullLinesNear, pulledLinesNote } from './reply-guard.js';
import { validateWatchArgs } from './tool-spec.js';
import { makeBuilder, runWatchPass } from './watch-run.js';
import { runWatchAction } from './watch-actions.js';
import { DEFAULT_LOOKAHEAD, loopStatus, startWatchLoop, stopWatchLoop } from './watch-loop.js';
import { sessionKey } from './watch.js';

/**
 * @param {object} ctx   宿主上下文（存图用）
 * @param {object} args  工具参数
 * @param {{sessionId?: string|null, cache?: Map, signal?: AbortSignal|null}} deps
 *   sessionId 来自 session/event 钩子；没有它就不起循环（除非已有声音订阅者，见 voice.js）。
 *   cache 由外层持有 —— 一次会话里跨多次调用复用同一批已建好的段。
 *   signal 是宿主的取消信号（`ToolRunContext.signal`）：阻塞等待必须看它，否则"停止"按不住。
 */
export async function execute(ctx, args, {
  sessionId = null, cache = new Map(), signal = null,
} = {}) {
  const problems = validateWatchArgs(args);

  // **我要说的话，走 `say` 参数**：它才会写进 `chat.jsonl`，悬浮窗里才看得见。
  // 只写在普通回复里的字，插件这一侧收不到 —— 用户那边就是"你一句话都没说"。
  //
  // 而且**允许和其他参数同时给**：以前 `say` 会被 `runWatchAction` 拦下来直接返回，
  // 于是"交付这一段 + 顺带说一句"得调两次工具（多一次模型往返）。
  // 现在：只有 `say` 就当场返回；带着别的活就写进流、继续跑主流程。
  //
  // 顺带两件事（2026-10-31 晚加）：
  //   ① 记下"声音从这里开始忙"，循环才知道别在两秒后又塞一句脚本台词进来；
  //   ② 把回话占住的这十几秒里挂着的脚本台词**取走**，交给模型按它刚说的重写 ——
  //      两句挨着念会连成一串，后一句还会被声音适配器当"追不上"直接丢掉。
  const saidNow = typeof args.say === 'string' && args.say.trim() !== '';
  let saidNote = '';
  let nearNote = '';
  if (saidNow) {
    // 说话时的播放位置：循环的估计值最接近"用户此刻看到哪儿"，读不到就不传（不猜）
    const st0 = loopStatus();
    // `Number(null) === 0`：不显式判空的话，"还没有位置"会被当成"在 0 秒"，
    // 于是把第一段开头 12 秒里的词全取走了
    const posRaw = st0.pos;
    const posNow = (posRaw === null || posRaw === undefined || posRaw === '')
      ? null : Number(posRaw);
    const where = st0.input ?? (typeof args.input === 'string' ? args.input : null);
    const entry = appendAssistantSay(args.say.trim(), { t: posNow });
    const near = await pullLinesNear(where, { pos: posNow }).catch(() => ({ pulled: [], guardSec: 12 }));
    nearNote = pulledLinesNote({ ...near, pos: posNow });

    const others = Object.keys(args)
      .filter((k) => k !== 'say' && k !== 'browserPort')
      .filter((k) => args[k] !== undefined && args[k] !== null && args[k] !== false && args[k] !== '');
    if (others.length === 0) {
      return {
        text: JSON.stringify({ ok: true, said: entry?.text ?? '', inChat: true }) + nearNote,
        images: [],
      };
    }
    saidNote = `\n[said] 这句已写进悬浮窗：「${entry?.text ?? ''}」${nearNote}`;
    args = { ...args };
    delete args.say;
  }


  // 输入面（悬浮窗 + 聊天服务）：跟"陪看"无关的那一侧，整体在 input-surface.js。
  // 它幂等 —— 这个 execute 里调几次都只开一次窗，返回同一句 note。
  const prepareInputSurface = createInputSurface();

  // waitForVideo 这一条在主流程之外就开始等，所以先备好；wait:true 由 watch-run 在真要阻塞前回调
  if (args.waitForVideo === true) void prepareInputSurface();

  // 单发命令（status / voices / speak / cookies / wake / stop）在这里分流
  const quick = await runWatchAction(args, {
    ctx, sessionId, browserPort: args.browserPort ?? configuredPort(),
  });
  // **待回执也跟着单发命令走**：模型很可能先 statusOnly 看一眼再回话，
  // 那一步用户同样只会看到沉默 —— 提醒要挂在每一条返回上，不能只挂主流程。
  if (quick) return { ...quick, text: `${quick.text}${replyReminder({ answered: saidNow })}` };

  if (problems.length > 0) throw new Error(`invalid arguments: ${problems.join('; ')}`);

  // 每次开始陪看都**先**备好输入面：悬浮窗关了要重新开、声音没挂要挂上。
  // 以前只在"真要阻塞"或"到点交付"时才备 —— 用户中途把窗口关掉，下一次调用就再也不会开，
  // 整场陪看没有插话入口（而且模型还以为入口在）。
  let widgetNote = '';
  let surface = null;
  if (!signal?.aborted) {
    // 这是"新开一场"还是"同一场中途再调"？
    //   新开一场  → 窗口不在就开（用户要的那个自动开）
    //   同一场中途 → 窗口不在就判定"用户关了窗"，停钟、不重开
    // 用户投诉过："我刚才关了悬浮窗又自己弹出来了" —— 关窗是他的表达，不许撤销它。
    const st0 = loopStatus();
    const sameWatch = st0.active && Boolean(args.input)
      && sessionKey(st0.input ?? '') === sessionKey(args.input);
    surface = await prepareInputSurface({
      start: !sameWatch,
      input: typeof args.input === 'string' ? args.input : null,
      // 用户明确要求重开才清掉"他自己关过窗"的记录（见 watch-state 的 hangup）
      reopen: args.open === true,
    });
    widgetNote = surface.note;
  }

  // 批次表的默认值在这里定一次，工具和循环共用同一份（否则两边段边界会各算各的）
  const segment = Number(args.segment) > 0 ? Number(args.segment) : DEFAULT_SEGMENT;
  const ramp = args.ramp === undefined ? [...DEFAULT_RAMP] : args.ramp;
  const callArgs = { ...args, segment, ramp };

  // 机器配置只在这里读一次，然后显式传给库层。
  // **只读端口，不读"要不要自动开浏览器"**：那条路已删（位置主通道是扩展上报）。
  const browserPort = args.browserPort ?? configuredPort() ?? undefined;

  const r = await runWatchPass(callArgs, {
    browserPort,
    cache,
    runStoryboard,
    formatManifest,
    signal,
    prepareWait: prepareInputSurface,
    // 关窗即收工：只有这次真把窗口开起来了，才把"窗口没了"当作"不看了"
    expectWindow: surface?.windowOpen === true,
    saveImage: async ({ data, name }) => ctx.attachments.saveImage({
      data, mediaType: 'image/png', name,
    }),
  });

  // 用户在等待期间按了停止：**钟也要停** —— 否则宿主那边已经收工，后台还在轮询浏览器
  if (signal?.aborted) stopWatchLoop('aborted');

  // 输入面已经在上面（参数校验之后）备好了，这里不再重复：
  // `prepareInputSurface` 在同一个 execute 里是幂等的，`watch-run` 真要阻塞时复用同一个 Promise。

  // 起陪看循环：从这里往后每 120 秒一段，到点自己叫醒。
  // 没有会话 id 就不起（只是不会自动说话，工具本身照常可用）。
  // **有人已经按了停止就别再起钟**：那等于"停止"之后又从后台活过来。
  // **有没有人接声音不影响这里**：循环里只在有订阅者时才把台词交出去（见 voice.js），
  // 没订阅者就照旧叫醒模型，两条路都不需要核心自带引擎。
  const canLoop = Boolean(sessionId) && !signal?.aborted;
  if (args.loop !== false && canLoop && Number.isFinite(r.cursor)) {
    const size = r.size ?? 120;
    // 余量按**时间**算（默认 5 分钟）：开头段短就多备几段。
    // 以前固定"两段"，在 1/2/3 分钟的阶梯上最前面只等于 2 分钟 —— 不够保险。
    // depth 只在调用方显式给了的时候才按段数算（旧口径，一般不要用）。
    const lookahead = args.lookahead === undefined
      ? DEFAULT_LOOKAHEAD
      : Math.max(0, Number(args.lookahead) || 0);
    const depth = Number(args.depth) >= 1 ? Math.floor(Number(args.depth)) : null;
    const speakEvery = Math.max(0, Number(args.speakEvery) || 0);
    // 台词库存的"补词判定"**默认关闭**：
    // 分段 + 阻塞等待已经足够知道"该看下一段了"，再加一层库存判断反而会把模型叫得太频繁，
    // 而且有些模型本来就不爱说话 —— 不该逼它产出台词。
    const refillBelow = args.refillBelow === undefined ? 0 : Math.max(0, Number(args.refillBelow) || 0);
    startWatchLoop({
      ctx, sessionId, input: r.input,
      cursor: r.cursor, status: r.status,
      // 段长 / 阶梯 / 余量 / 提前量交给循环：之后它自己往前滚、自己补建。
      // **lead 必须传**：钟和 watch-run 用的必须是同一个提前量，否则"说好的时间点"会差一截。
      segment, ramp, lookahead, depth, speakEvery, refillBelow, lead: args.lead,
      // **到点发不发 `[一起看] … 该说话了` 这种会话消息**：默认不发（`wake` 显式 true 才发）。
      // 阻塞式调用本来就会在段末自己返回，钟再 `followup()` 一次，用户看到的是
      // "N 条排队消息"，而且会挡住他自己要说的话。
      wake: args.wake === true,
      // 窗口关掉就收工（只有这次真把窗口开起来时才生效）
      windowGuard: surface?.windowOpen === true,
      // 循环负责"什么时候建"，这里给它"怎么建"
      deps: {
        browserPort,
        build: makeBuilder({
          input: r.input, args: callArgs, runStoryboard, formatManifest, cache,
        }),
      },
      log: () => {},
    });
  }
  // 第一次真进入阻塞时，把输入框状态附在结果里 —— 模型才知道该告诉用户去哪说话
  // `replyReminder` 在最后：这一轮如果还是没回插话，就把"你还没回她"顶出来
  return {
    text: `${r.text}${widgetNote}${saidNote}${replyReminder({ answered: saidNow })}`,
    images: r.images,
  };
}

