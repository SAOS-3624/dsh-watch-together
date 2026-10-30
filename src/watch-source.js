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
import { readPositionOrNull } from './watch-browser.js';

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

/** 从一次浏览器读数里取出"这是在放什么"，取不到就 null */
function sourceOf(b) {
  if (!positionReady(b)) return null;
  if (looksLikeVideoUrl(b?.url) && /^https?:/i.test(b.url)) {
    return { input: b.url, matchedBy: 'browser-url' };
  }
  const local = fileUrlToPath(b?.url);
  if (local) return { input: local, matchedBy: 'browser-file' };
  return null;
}

/**
 * "为什么没有视频"的那一行。两处失败文案共用同一份措辞 ——
 * 以前各写一遍，改一处就会让两条路径说出两种解释。
 */
async function whyNoVideo(browserPort) {
  if (!browserPort) {
    return 'browser: NOT configured — set browserPort in ~/.dsh/video.json '
      + 'and start it with scripts/start-edge-debug.cmd';
  }
  return await hasDebugPort({ port: browserPort })
    ? `browser: open :${browserPort} but no tab is holding a <video>`
    : `browser: CLOSED :${browserPort} — no debug port is listening `
      + '(start it with scripts/start-edge-debug.cmd)';
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
      + 'Play something, or pass input yourself (path or link). '
      + 'If you would rather wait for them to start it, call again with waitForVideo: true — '
      + 'but say you are waiting first: this call stays silent while it blocks.',
    images: [],
  };
}

export async function resolveWatchSource({ input: given, args, readBrowser, browserPort }) {
  let input = given;
  let resolved = null;

  if (!input) {
    // 浏览器开过调试端口时，**页面地址就是源**（能直接拿到 BV 号）
    const hit = sourceOf(await readPositionOrNull(readBrowser, browserPort));
    if (hit) ({ input, resolved } = hit);
  }

  // ---- 等视频出现（waitForVideo）
  // 用户常常先叫一声、再去开视频。与其立刻失败让他再叫一次，不如在这里挂着等，
  // 并且**把等待的结果说清楚**（等了多少秒、有没有等到）。
  // 注意：工具调用中途没法说话，所以"我在等"这句必须由模型在调用**之前**说 ——
  // 这一点写在工具描述和 manifest 的 guidance 里。
  //
  // 只有一条来源了，所以这个循环就是"每 300ms 问一次浏览器"，没有别的分支可等。
  if (!input && args.waitForVideo === true) {
    const cap = Math.min(600, Math.max(10, Number(args.maxWaitSec) || 120));
    const deadline = Date.now() + cap * 1000;
    const tWait = Date.now();
    while (Date.now() < deadline) {
      const hit = sourceOf(await readPositionOrNull(readBrowser, browserPort));
      if (hit) {
        ({ input, resolved } = hit);
        break;
      }
      await new Promise((r) => setTimeout(r, 300));
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

  return { input, resolved };
}
