/**
 * watch-source.js — "用户到底在看什么"：从**零信息**反推到一条能用的 input。
 *
 * 从 watch-run.js 拆出来的第 0 步。用户只会说"我在看这个"，不会报路径；
 * 所以这里有两条候选路，按可靠度排序：
 *   1. 浏览器的视频页地址（能直接拿到 BV 号）
 *   2. 浏览器打开的是本地文件（file:// → 直接当路径用）
 *
 * 两条都来自同一个地方：**调试端口里那个 `<video>` 所在页面的地址**。
 *
 * > 这里曾经还有第 3、4 条：系统媒体会话（SMTC）给的标题 → 去 B 站按标题+时长搜，
 * > 以及"上一次为这个标题记住的源"。2026-10-30 整块删掉了，原因有两个：
 * > ① 按标题搜会猜错（同名的另一条片子），猜错后每一段都是错的；
 * > ② 那条路只在"SMTC 能给标题、但给不了地址"时才存在 —— SMTC 已经删了。
 * > 现在没有地址就是没有源，**直接让用户给**，不猜。
 *
 * 返回值有两种：`{ ok: false, ... }` 是"这次调用到此为止"的完整工具结果；
 * 否则是 `{ input, resolved }`。**判据只看 ok**。
 */

import { fileUrlToPath, hasDebugPort, looksLikeVideoUrl } from 'dsh-video-storyboard/browser-time';
import { chatWatcherShared, enterChatWait, sleepWithChat } from './interrupt.js';
import { readPositionOrNull } from './watch-browser.js';
import { readBridge } from './position-bridge.js';
import { interjectNote } from './interject.js';

/**
 * "可以开始看了"的判据 —— **能读到播放位置**，而不是"能读到页面地址"。
 *
 * 这两个以前被混为一谈：只要浏览器里有一个视频页，就把 input 定死、跳过 waitForVideo，
 * 然后因为页面还没起播读不到位，秒回一句 "cannot read your playback position"，
 * 还反过来让用户报时间。而"页面开着、但还没点播放"恰恰是最常见的场景。
 *
 * pos > 0.5 或正在播，才算就绪：暂停在 0:00 的人只是开着页面，不是在看。
 */
const positionReady = (b) => Boolean(b) && Number.isFinite(b?.pos)
  && (b.pos > 0.5 || b.paused === false);

/**
 * 过期读数还能认多久。
 *
 * 扩展**只在标签页可见时**上报（那两个标签页会互相打架），所以用户一切到别的窗口打字，
 * 位置就在 5 秒后变成"过期"。而"一起看"这句话恰恰是在**别的窗口**里打的 ——
 * 于是最常见的开场变成了"等了 60 秒才说你没开视频"。
 *
 * 两分钟之内，那支片子是谁仍然确定，用它；位置本身交给上层标成 stale 并让新读数纠正。
 */
const STALE_IDENTIFY_MS = 120_000;

/** 从一次读数里认出"这是在放什么"（不看位置是否就绪） */
function identityOf(b) {
  if (!b) return null;
  if (looksLikeVideoUrl(b?.url) && /^https?:/i.test(b.url)) {
    return { input: b.url, matchedBy: 'browser-url' };
  }
  const local = fileUrlToPath(b?.url);
  if (local) return { input: local, matchedBy: 'browser-file' };
  return null;
}

/** 从一次浏览器读数里取出"这是在放什么"，取不到就 null */
function sourceOf(b) {
  if (!positionReady(b)) return null;
  return identityOf(b);
}

/**
 * 过期读数认片：位置桥上一次上报（哪怕已经过期）指向的是哪支片子。
 * @returns {Promise<null | {input:string, matchedBy:string, stale:{pos:number, ageMs:number, at:number}}>}
 */
async function staleSource() {
  const s = await readBridge({ maxAgeMs: STALE_IDENTIFY_MS }).catch(() => null);
  const hit = identityOf(s);
  if (!hit) return null;
  return { ...hit, stale: { pos: s.pos, ageMs: s.ageMs ?? 0, at: s.at } };
}

/**
 * "为什么没有视频"的那一行。两处失败文案共用同一份措辞 ——
 * 以前各写一遍，改一处就会让两条路径说出两种解释。
 *
 * 主通道是**浏览器扩展上报**，调试端口只是备路 —— 所以"没配端口"不是第一嫌疑人，
 * 以前这里写成"去配 browserPort 再用 start-edge-debug.cmd 起浏览器"，把兜底说成了正路。
 */
async function whyNoVideo(browserPort) {
  const ext = 'the browser extension reports nothing either '
    + '(installed + enabled on the tab that is playing?)';
  if (!browserPort) {
    return `browser: no debug port configured, and ${ext}`;
  }
  return await hasDebugPort({ port: browserPort })
    ? `browser: open :${browserPort} but no tab is holding a <video>; ${ext}`
    : `browser: debug port ${browserPort} is not listening, and ${ext}`;
}

/** 把一次失败拼成完整的工具结果 */
async function noVideoResult({ reason, browserPort, waitedSec = null, extra = '' }) {
  const whyBrowser = await whyNoVideo(browserPort);
  const waited = waitedSec === null ? '' : `I waited ${waitedSec}s and no video appeared.\n`;
  return {
    ok: false,
    ...(waitedSec === null ? {} : { waitedSec }),
    reason,
    browser: browserPort ? 'checked' : 'unconfigured',
    text: `${waited}${whyBrowser}\n${extra}`
      + '**不要向用户要链接或路径** —— 这个工具的输入就是"他自己浏览器里正在放的那个"。'
      + '告诉他先把视频点开、播起来，然后直接再调一次 watch_together（参数都不用改）；'
      + '等他开始播，位置桥会自动把它交出来。',
    images: [],
  };
}

export async function resolveWatchSource({ input: given, args, readBrowser, browserPort }) {
  let input = given;
  let resolved = null;
  let stale = null;

  if (!input) {
    // 浏览器开过调试端口时，**页面地址就是源**（能直接拿到 BV 号）
    const hit = sourceOf(await readPositionOrNull(readBrowser, browserPort));
    if (hit) ({ input, resolved } = hit);
    // 没有新鲜读数：看看过期的（用户很可能刚切到别的窗口去说"一起看"）。
    // 认出来就直接用，位置标 stale —— 比在这里干等一分钟强得多。
    if (!input) {
      const old = await staleSource();
      if (old) {
        ({ input, resolved, stale } = old);
      }
    }
  }

  // ---- 等视频出现（waitForVideo）
  // 用户常常先叫一声、再去开视频。与其立刻失败让他再叫一次，不如在这里挂着等，
  // 并且**把等待的结果说清楚**（等了多少秒、有没有等到）。
  // 注意：工具调用中途没法说话，所以"我在等"这句必须由模型在调用**之前**说 ——
  // 这一点写在工具描述和 manifest 的 guidance 里。
  //
  // 只有一条来源了，所以这个循环就是"每 300ms 问一次浏览器"，没有别的分支可等。
  // **没有 input 时默认就等**（只有显式 `waitForVideo: false` 才立刻失败）。
  // 为什么改默认：模型冷启动最容易干的事就是"问用户要链接"，而那正是用户最烦的一步
  // （原话："他怎么还在问我这个问题，以后只让他查我的浏览器"）。
  // 这里等一小会儿，视频一开就自动接上；等不到也只说"先播起来再叫我"。
  //
  // **自动等只等 20 秒**（原来 60）：用户抱怨"开头检测视频特别慢"（2026-10-31），
  // 而绝大多数情况下要么一秒内就认出来，要么是真的还没开视频 —— 干等一分钟只是让人干瞪眼。
  // 显式 `waitForVideo: true` 仍然是 120 秒：那种情况是模型已经跟用户说过"我在等"。
  const autoWait = !given && args.waitForVideo !== false;
  if (!input && (args.waitForVideo === true || autoWait)) {
    const cap = Math.min(600, Math.max(10, Number(args.maxWaitSec) || (autoWait ? 20 : 120)));
    const deadline = Date.now() + cap * 1000;
    const tWait = Date.now();
    // 等用户开视频这段时间，这条插话通道归等待者（见 interrupt.js 的 chatWaiters）
    const leaveChatWait = enterChatWait();
    try {
      while (Date.now() < deadline) {
        const hit = sourceOf(await readPositionOrNull(readBrowser, browserPort));
        if (hit) {
          ({ input, resolved } = hit);
          break;
        }
        // 等用户开视频这段时间最长两分钟，**干等最没意义** —— 顺手看着聊天框，
        // 用户随时可以插一句（比如"我找不到那个片"），立刻就能回他。
        const said = await sleepWithChat(300, { watcher: chatWatcherShared(), everyMs: 150 });
        // **这条返回以前没有 `text`**：调用方把它原样交给宿主，而 output.schema 里
        // `text` 是必填 —— 于是"等视频时用户插话"会得到一个不合格的结果，
        // 模型那边看到的是工具报错，用户看到的是"我说了话它没反应"。
        if (said) {
          return {
            ok: false,
            reason: 'chat',
            chat: { text: said.text, at: said.at },
            input: null,
            resolved: null,
            text: `${interjectNote(said.text, { at: said.at })}\n\n`
              + '（还在等视频起来，这次等待先到这里 —— 回完再调一次 watch_together 接着等。）',
            images: [],
          };
        }
      }
    } finally {
      leaveChatWait();
    }
    if (!input) {
      return noVideoResult({
        reason: 'no-video-timeout',
        browserPort,
        waitedSec: Math.round((Date.now() - tWait) / 1000),
      });
    }
  }

  if (!input) {
    return noVideoResult({
      reason: 'no-video',
      browserPort,
      extra: 'Nothing is playing in the watch browser right now.\n',
    });
  }

  return { input, resolved, stale };
}
