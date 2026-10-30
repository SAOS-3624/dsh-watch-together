/**
 * watch.js — 「一起看」的对外门面。
 *
 * 这里**不放实现**，只转发两件本来就不相干的事：
 *
 *   watch-state.js   看到哪儿了   —— watch.json 的读写 + 段长/交付点算术
 *   watch-lines.js   该说什么了   —— 位置轴上的台词队列
 *
 * 为什么保留这个文件而不是让调用方直接 import 那两个：
 * `watch-loop` / `watch-run` / `watch-modes` / `watch-source` 和几个测试文件都从这里取东西，
 * 逐个改 import 只会把一次结构性调整扩散成一次全网改动。门面留着，调用方一行不用动。
 *
 * > 这里曾经还转发 `watch-probe.js`（起 python 读 Windows 系统媒体控件 SMTC）。
 * > 2026-10-30 整块删掉了：SMTC 的 Position 只在事件发生时刷新（实测两次刷新隔过 143、216 秒），
 * > 拿它当实时位置必须外推，外推就会猜错，猜错就让后面每一段都错。
 * > 现在位置只有一个来源：浏览器调试端口里的 `video.currentTime`。
 *
 * 核心思想不是"多调几次 storyboard"，而是**预取**：
 *   用户在看第 N 段时，插件已经把这一段算完了（8–10 s）；
 *   等用户快看完这一段（remaining ≤ lead），才把图和清单交出去。
 *   于是用户感知到的延迟是 0 —— 计算发生在他在看的时候。
 */

export {
  WATCH_LEAD,
  WATCH_SEGMENT,
  deliveryState,
  loadWatch,
  norm,
  saveWatch,
  segmentStart,
  sessionKey,
  watchPath,
} from './watch-state.js';

export {
  consumeLine,
  dueLine,
  hasLine,
  linesOverview,
  loadLine,
  readSlot,
  saveLines,
} from './watch-lines.js';
