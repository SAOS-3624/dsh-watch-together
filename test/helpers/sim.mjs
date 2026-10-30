/**
 * sim.mjs — 不用 DSH、不用真时钟，把整条陪看循环跑起来。
 *
 * 为什么要有这个：真机测试要重启 DSH、要真的看片、一次要十几分钟。
 * 而"到点该不该说话"是个**纯逻辑问题**，完全可以离线验证——
 * 只要把三个外部世界换成假的：时钟、浏览器读数、会话推送。
 *
 * 假"浏览器读数"的关键：每次调用都**按虚拟时间当场算**一个 `currentTime`，
 * 这才符合 `video.currentTime` 的真实语义（它是真值，不是"多久刷新一次的快照"）。
 *
 * > 这层以前模拟的是 Windows 媒体控件（SMTC）的"快照 + 刷新间隔"，
 * > 因为 SMTC 只在事件时刷新。SMTC 已在 2026-10-30 删除，这里随之改成直接给当前位置。
 *
 * 能模拟的坏情况：
 *   `deadFrom`  某个时刻之后浏览器没了（关窗口 / 页签切走）→ 读数变 null
 *   `failEvery` 每 N 次读失败一次（CDP 偶发超时）→ 读数变 null
 *   `stalledFrom` 位置不再前进（播放器卡住）→ 仍在"播"，但 currentTime 不动
 */

/** 建立一个可回放的仿真环境 */
export function createSim({
  duration = 1016,
  title = 'A',
  url = 'https://www.bilibili.com/video/BV1sim',
  tickMs = 2000,
  playingFrom = 0,
  paused = [],          // [{from, to}] 秒
  changes = [],         // [{at, duration, url, title}] 秒：之后就是另一支片子
  deadFrom = null,      // 秒：之后读不到（模拟浏览器关掉）
  failEvery = 0,        // 每 N 次读数失败一次（0 = 不失败）
  stalledFrom = null,   // 秒：之后位置不再前进（模拟播放器卡死）
} = {}) {
  let t = 0;                                  // 虚拟时间（毫秒）
  const start = Date.now();                   // 真实基准，只用于"看起来像时间戳"
  const wakes = [];
  let current = { title, duration, url };
  let reads = 0;

  const pausedAt = (sec) => paused.some((p) => sec >= p.from && sec < p.to);

  /** 累计暂停了多少秒（到第 sec 秒为止） */
  function pausedSeconds(sec) {
    let acc = 0;
    for (const p of paused) {
      if (sec <= p.from) continue;
      acc += Math.min(sec, p.to) - p.from;
    }
    return acc;
  }

  /** 第 ms 毫秒时播放器停在第几秒 */
  function positionAt(ms) {
    const sec = ms / 1000;
    const moving = stalledFrom === null || sec < stalledFrom;
    const elapsed = moving ? sec : stalledFrom;
    return Math.min(playingFrom + Math.max(0, elapsed - pausedSeconds(elapsed)), current.duration);
  }

  /** 换片：过了那个时刻就换成另一支片子 */
  function applyChanges(ms) {
    for (const c of changes) {
      if (ms >= c.at * 1000) {
        current = {
          title: c.title ?? current.title,
          duration: c.duration ?? current.duration,
          url: c.url ?? `${current.url}-${c.at}`,
        };
      }
    }
  }

  const readBrowser = async () => {
    applyChanges(t);
    reads += 1;
    if (deadFrom !== null && t >= deadFrom * 1000) return null;
    if (failEvery > 0 && reads % failEvery === 0) return null;
    return {
      pos: positionAt(t),
      dur: current.duration,
      title: current.title,
      url: current.url,
      paused: pausedAt(t / 1000),
      ended: positionAt(t) >= current.duration - 0.5,
    };
  };

  const wake = async (_ctx, { text }) => { wakes.push({ at: t, text }); return { ok: true }; };
  const now = () => start + t;

  /** 假 ticker：不注册真定时器，把 tick 交出来由测试驱动 */
  let tickFn = null;
  const ticker = ({ tick }) => {
    tickFn = tick;
    return { dispose() { tickFn = null; } };
  };

  return {
    deps: {
      readBrowser, wake, now, ticker,
      loadLatency: async () => ({ ms: 0, samples: 5, at: 0 }),
    },
    get t() { return t; },
    get wakes() { return wakes; },
    /** 兼容旧断言：现在"快照"就是当前这一秒的读数 */
    get snapshot() { return { pos: positionAt(t), dur: current.duration, title: current.title }; },
    /** 推进到第 sec 秒，逐 tick 调用 */
    async runTo(sec, { onTick } = {}) {
      while (t < sec * 1000) {
        const next = Math.min(t + tickMs, sec * 1000);
        t = next;
        if (tickFn) await tickFn();
        onTick?.(t / 1000);
        if (!tickFn) break;                 // 循环已经停了
      }
      // 预取是 fire-and-forget（`loop.building = (async …)()`，故意不等），
      // 虚拟时间跑得比微任务快，所以这里让一轮宏任务把那些 promise 落下来，
      // 否则断言"已经建好了"会看到空数组。
      await new Promise((r) => setImmediate(r));
      return this;
    },
  };
}
