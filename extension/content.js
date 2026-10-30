/**
 * content.js — 在**你正在看的那个页面**里读播放进度，交给后台去上报。
 *
 * 为什么不在这里直接 fetch：
 * 页面是 https://www.bilibili.com，目标是 http://127.0.0.1 —— 跨域 + 私有网络访问，
 * 两道闸门。扩展的后台（service worker）有 host_permissions，不受这两道限制。
 * 所以这里只负责"读"，发出去交给 background.js。
 *
 * 读什么：`<video>` 元素的 `currentTime` / `duration` / `paused`。
 * 这是页面里的真值，比任何外部接口都准 —— 播放器自己就是靠它在走。
 */

/* global chrome */

(() => {
  // 有些站点在一个页面里放多个 video（广告、预览、小窗）。
  // 挑"最像正在看的那个"：优先在播的，其次时长长的。
  function pickVideo() {
    const all = [...document.querySelectorAll('video')];
    if (all.length === 0) return null;
    if (all.length === 1) return all[0];
    const playing = all.filter((v) => !v.paused && !v.ended);
    const pool = playing.length > 0 ? playing : all;
    return pool.reduce((best, v) => {
      const score = (v) => (Number.isFinite(v.duration) ? v.duration : 0);
      return score(v) > score(best) ? v : best;
    }, pool[0]);
  }

  /**
   * **只在这个标签页可见的时候上报。**
   *
   * 为什么：页面里每个标签页都会跑这份脚本。如果用户开了两个带视频的标签页
   * （比如看片看到一半，又点开一支新的），两边会每秒各报一次，
   * 服务端收到的位置就会来回跳 —— 陪看会以为用户在疯狂拖进度条。
   * "当前可见的那个标签页"就是用户正在看的那个，以它为准。
   */
  function report() {
    if (!chrome?.runtime?.id) return;      // 扩展被重新加载/停用了
    if (document.visibilityState !== 'visible') return;
    const v = pickVideo();
    if (!v || !Number.isFinite(v.currentTime)) return;

    const now = Date.now();
    lastSent = now;
    const payload = {
      pos: v.currentTime,
      dur: Number.isFinite(v.duration) ? v.duration : null,
      title: document.title || '',
      url: location.href,
      paused: Boolean(v.paused),
      ended: Boolean(v.ended),
    };

    try {
      // 不 await：上报失败不该在页面控制台里刷红字
      chrome.runtime.sendMessage({ type: 'position', payload }).catch(() => {});
    } catch { /* 扩展上下文失效，下次再说 */ }
  }

  // 1) 每秒一次心跳：位置一直在变，服务端按 5 秒新鲜度判定，丢几拍也不影响
  setInterval(report, 1000);

  // 2) 关键动作立刻报一次：暂停/拖动/切集之后位置会跳，等下一拍就晚了
  for (const ev of ['play', 'pause', 'seeked', 'ratechange', 'ended', 'loadedmetadata']) {
    document.addEventListener(ev, report, true);
  }

  // 3) 有些站点是单页应用，切视频不刷新页面 —— 视频元素可能后来才出现
  document.addEventListener('DOMContentLoaded', report, true);
  // 4) 切回这个标签页的瞬间立刻报一次：换片检测靠的就是这一拍
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') report();
  });
  report();
})();
