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
  // 有些站点在一个页面里放多个 video（广告、预览、小窗、多 P、多语言选集）。
  // 挑"用户正在看的那个"：先排除不可见 / 零尺寸的，再按可见面积选最大的；
  // 播放中只加一点权重，不能让它压过一个更大的主播放器。
  // 旧实现按 duration 选，多 P 页面会挑到隐藏的 13 分钟长视频，位置直接跳到另一集。
  function visibleBox(v) {
    if (!v.isConnected) return null;
    const r = v.getBoundingClientRect();
    if (!(r.width > 2 && r.height > 2)) return null;
    let style;
    try { style = getComputedStyle(v); } catch { return null; }
    if (style.display === 'none' || style.visibility === 'hidden'
        || Number(style.opacity) === 0) return null;
    const left = Math.max(0, r.left);
    const top = Math.max(0, r.top);
    const right = Math.min(window.innerWidth, r.right);
    const bottom = Math.min(window.innerHeight, r.bottom);
    if (right - left <= 2 || bottom - top <= 2) return null;
    return { area: (right - left) * (bottom - top) };
  }

  function pickVideo() {
    const all = [...document.querySelectorAll('video')];
    if (all.length === 0) return null;
    if (all.length === 1) return all[0];

    const viewport = Math.max(1, window.innerWidth * window.innerHeight);
    const info = all.map((v) => ({ v, box: visibleBox(v) }));
    // 先只在可见的里挑；整页都不可见（比如刚切走）时才退回全部。
    const visible = info.filter((x) => x.box);
    const pool = visible.length > 0 ? visible : info;
    // 用户主动暂停时视频是 paused 但没 ended；只有 ended 才该让位给别的。
    const live = pool.filter((x) => !x.v.ended);
    const candidates = live.length > 0 ? live : pool;

    const score = ({ v, box }) => {
      let s = box ? (box.area / viewport) * 1e7 : 0;
      if (!v.paused && !v.ended) s += 1e5;
      if (v.readyState >= 2) s += 1e3;
      if (v.currentTime > 0) s += 1e3;
      if (v === document.pictureInPictureElement) s += 1e9;
      const fs = document.fullscreenElement;
      if (fs && fs !== document.documentElement && fs.contains(v)) s += 5e8;
      return s;
    };
    return candidates.reduce((best, cur) => (score(cur) > score(best) ? cur : best)).v;
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
