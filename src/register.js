/**
 * register.js — 陪看这一个工具的**注册入口**。
 *
 * 存在的理由很实际：schema（`tool-spec.js`）、handler（`handler.js`）、注册（这里）
 * 三样都在 `src/` 里，所以这个包就是一个自足的整体 ——
 * 不再需要"去别人家 `index.js` 里把五行抠出来、再去 `tools/` 里捡一个 handler"。
 *
 * 这个文件**只依赖 `./` 和包外的 `dsh-video-storyboard`**，不碰 `index.js`、
 * 不碰任何 `video_*` 的契约。`test/schema-audit.test.mjs` 会盯着入口只注册这一个工具。
 */

import * as handler from './handler.js';
import { createWatchInterfaces } from './interfaces.js';
import { watchToolSpec } from './tool-spec.js';

/**
 * @param {(spec: object) => object} defineTool  宿主的 defineTool
 * @param {object} ctx  宿主上下文（存图用）
 * @param {{ getSessionId?: () => (string|null), cache?: Map }} [deps]
 *   `getSessionId` 用**函数**而不是值：会话 id 由 session/event 钩子随时更新，
 *   闭包里拿快照会让第一次之后的所有调用都用旧 id。
 * @returns {object[]} 已经 `defineTool()` 好的工具，调用方负责 register + 收集 disposer
 */
export function watchTools(defineTool, ctx, {
  getSessionId = () => null, cache = new Map(), interfaces = null,
} = {}) {
  // 一次 apply 只造一套接口：识别、TTS、悬浮窗各有自己的适配器，handler 不再直接 import 实现。
  const api = interfaces ?? createWatchInterfaces();
  return [
    defineTool({
      ...watchToolSpec(),
      // 第二个参数是宿主的 `ToolRunContext`：`signal` 是"这一轮被取消了"的唯一通知。
      // 丢掉它的话，用户按停止之后阻塞循环还会继续轮询浏览器（默认 2×段长，封顶 600s）。
      execute: (args, run) => handler.execute(ctx, args, {
        sessionId: getSessionId(), cache, interfaces: api, signal: run?.signal ?? null,
      }),
    }),
  ];
}
