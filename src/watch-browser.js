/**
 * watch-browser.js — 「浏览器到底在不在」这一件事，加上"没有就拉起来"，以及"读一次位置"。
 *
 * 位置有两条通道（CDP / 浏览器扩展上报），都在 `readPositionOrNull()` 里收口 ——
 * 调用方不需要知道这一次是从哪来的。
 *
 * 从 watch-run.js 拆出来的。为什么值得单独一个文件：**这三件事的错误都是静默的**。
 * 读不到位置以前是 `.catch(() => null)`，于是"浏览器关着"和"开着但没视频"在模型眼里
 * 一模一样，它只能拿位置去倒推浏览器状态 —— 猜错就对着空气写台词。
 * 所以这里的每个返回值都要求能翻译成一句人话（`describeBrowser`）。
 */

import { launchBrowser, waitForPort } from 'dsh-video-storyboard/browser-time';
import { readBridge } from './position-bridge.js';
import { mmss } from './time.js';

/**
 * 把插件自己拉起来的浏览器准备好。
 * 只在"读不到位置 + 配了端口 + 允许自动开 + 不是 attachOnly"时才调用。
 *
 * @param {number} port 调试端口
 * @param {string} [url] 要打开的地址（`file:///…` 或 http 链接）—— 直接落到用户要看的那一页
 *
 * @returns {Promise<{ok:boolean, launched:boolean, via?:string|null, reason?:string|null}>}
 */
export async function ensureWatchBrowser(port, url = '') {
  if (!port) return { ok: false, launched: false, reason: 'no-port' };
  // 带上要看的那个片子：用户说了"陪我看这个链接"，就别让他再在这个窗口里手动打开一次。
  // 这是"零安装"那条路的体验关键 —— 插件开的窗口直接就是要看的片。
  const r = launchBrowser({ port, url });
  if (!r.ok) return { ok: false, launched: true, via: null, reason: r.reason ?? 'launch-failed' };
  const up = await waitForPort(port);
  return {
    ok: up,
    launched: true,
    via: r.via ?? null,
    reason: up ? null : 'port-never-opened',
  };
}

/**
 * 读一次播放位置。**两条通道，按优先级**：
 *   1. 浏览器调试端口（CDP）—— 有端口才试
 *   2. 浏览器扩展上报的（`position-bridge.js`）—— 扩展把位置 POST 到本地 9377
 *
 * 没配端口、读不到、CDP 挂了，都不算错 —— 继续试下一条；都不行才返回 null。
 *
 * 这个 fallback 在陪看路径上出现过 8 次（watch-run / watch-modes / watch-source / watch-loop），
 * 每次都得记得写 `.catch(() => null)` —— 漏一次就是"陪看突然整段失联"。
 * 收成一处之后，`readBrowser` 仍然可注入（测试/仿真靠它喂位置）。
 */
export async function readPositionOrNull(readBrowser, browserPort, { bridge = true } = {}) {
  if (browserPort) {
    const b = await readBrowser({ port: browserPort }).catch(() => null);
    if (b) return { ...b, source: 'cdp' };
  }
  if (!bridge) return null;
  const s = await readBridge().catch(() => null);
  if (!s) return null;
  return {
    pos: s.pos,
    dur: s.dur,
    title: s.title,
    url: s.url,
    paused: s.paused,
    ended: s.ended,
    source: 'bridge',
  };
}

/**
 * 一行说清"浏览器到底在不在"。
 *
 * 这行是给模型看的判据，**不能拿播放位置去倒推**：位置现在还能从浏览器扩展来，
 * 扩展报的是"用户当前可见的那个标签页"，和这个调试端口是不是同一个浏览器**无关**。
 * 有位置完全不代表"这个端口上的浏览器开着"。
 *
 * @param {object} state `probeBrowser()` 的返回值
 * @param {string} [launchNote] 本次调用如果自己开了浏览器，附在后面
 */
export function describeBrowser(state = {}, launchNote = '') {
  const port = state?.port;
  const tail = String(launchNote ?? '');
  switch (state?.state) {
    case 'unconfigured':
      return 'browser: NOT configured — no debug port (the extension can still report a position)' + tail;
    case 'closed':
      return `browser: CLOSED :${port} — nothing is listening there; a position (if any) comes from the browser extension, not from this port${tail}`;
    case 'no-video': {
      const urls = Array.isArray(state.urls) && state.urls.length > 0
        ? ` (its tabs: ${state.urls.join(' | ')})`
        : '';
      return `browser: open :${port} but NO tab is holding a <video>${urls}${tail}`;
    }
    case 'error':
      return `browser: :${port} is up but the debugger did not answer — treat this as unknown, not as "closed"${tail}`;
    case 'watching': {
      const what = state.paused ? 'paused' : 'playing';
      const at = Number.isFinite(state.pos) ? ` ${mmss(state.pos)}` : '';
      const title = state.title ? ` ${String(state.title).slice(0, 60)}` : '';
      return `browser: open :${port}${title} ${what}${at}${tail}`;
    }
    default:
      return `browser: unknown (${state?.state ?? 'no state'})${tail}`;
  }
}
