/**
 * index.js — **dsh-watch-together** 的 DSH 插件入口。只做注册：
 *
 *   watch_together   陪看：按用户真实播放进度，一段一段往下看
 *
 * 这一个工具就够。它和 `dsh-video-storyboard` 的四个 `video_*` 工具是**两个插件**：
 * 那个负责"把一段视频变成一张可引用的宫格"，这个负责"跟着你一段段看下去"。
 * 这里不注册任何 `video_*` —— 那是另一个包的职责。
 *
 * 契约要点（对着 @deepseek-ai/dsh-tools 的类型定义核对过）：
 *  - `apply` 返回 disposer（把所有 `ctx.tools.register()` 的返回值串起来）
 *  - `execute` 返回**规范值**（要过 output.schema）
 *  - `output.render(args, value)` 把规范值渲染成 ContentBlock[]，图片块是
 *    `{ type: 'image', attachment: ImageAttachmentRef }`，ref 必须由
 *    `ctx.attachments.saveImage()` 提交过后才能拿到（不能自己编）
 *  - saveImage 要的是**真正编码后的字节**（PNG/JPEG），不是裸 RGB —— 它会解码校验
 */

import { attachSpeechToChat } from './chat.js';
import { getTtsPort } from './runtime-ports.js';
import { watchTools } from './register.js';
import { createSettingsPage } from './settings/server.js';

export const name = 'dsh-watch-together';
// **只声明 tools**：cordis 的 inject 是硬依赖，服务缺失时 apply 永远不会被调用，
// 插件就停在"加载中"（用户侧：装完插件 DSH 卡死）。attachments 只在截图那条路上用，
// 改成运行期探测（src/handler.js），没有它就返回文本。
export const inject = ['tools'];

/**
 * 解析宿主的 dsh-tools。正常安装时裸包名就能解析；本地开发/测试时
 * 用 `DSH_TOOLS_PATH` 指向安装里的 lib/index.js。
 */
async function loadDefineTool() {
  try {
    const mod = await import('@deepseek-ai/dsh-tools');
    if (mod?.defineTool) return mod.defineTool;
  } catch {
    /* 落到环境变量 */
  }
  const override = process.env.DSH_TOOLS_PATH;
  if (override) {
    const { pathToFileURL } = await import('node:url');
    const mod = await import(pathToFileURL(override).href);
    if (mod?.defineTool) return mod.defineTool;
  }
  throw new Error('cannot resolve @deepseek-ai/dsh-tools (set DSH_TOOLS_PATH for local dev)');
}

const APPLY_TIMEOUT_MS = 15_000;

export async function apply(ctx) {
  try {
    return await withTimeout(registerAll(ctx), APPLY_TIMEOUT_MS, 'registerAll');
  } catch (e) {
    // **最坏的情况是插件不能用，不是应用起不来**。
    // 真实事故：在 apply 里做 ctx 探测，`Object.keys(ctx)` 在 cordis 上下文上抛错，
    // 整个 DSH 直接崩在启动阶段（"The application could not start"）。
    // 所以 apply 的异常一律吞掉并记录，交回一个空 disposer。
    try {
      ctx?.logger?.error?.(`[dsh-watch-together] failed to load: ${e?.stack ?? e}`);
    } catch { /* 连日志都写不了就算了 */ }
    // DSH_VIDEO_DEBUG=1 时把错误抛出去 —— 否则"插件静默不工作"很难查
    if (process.env.DSH_VIDEO_DEBUG) throw e;
    return () => {};
  }
}

async function registerAll(ctx) {
  const defineTool = await loadDefineTool();

  // 当前会话：从 session/event 里拿（`session.header.id`）。这是 dsh-fish 的做法，
  // 比反射 ctx 安全得多 —— 反射会把整个应用搞崩（见 apply 的注释）。
  let lastSessionId = null;

  // 陪看跨调用复用同一批已建好的段（一部电影几十段，只留最近 8 段）
  const watchCache = new Map();

  const tools = [
    ...watchTools(defineTool, ctx, { getSessionId: () => lastSessionId, cache: watchCache }),
  ];

  // **disposers 必须在最前面声明**：它曾经声明在 ctx.on 之后，于是 `disposers.push(off)`
  // 撞上 const 的暂时性死区，抛 ReferenceError，又被下面的 catch 静默吞掉 ——
  // 监听器注册成功了，解绑函数却从来没登记过（插件卸载时不会解绑，而且没人知道出过错）。
  const disposers = [];
  if (typeof ctx.on === 'function') {
    try {
      const off = ctx.on('session/event', (session) => {
        const id = session?.header?.id ?? session?.id;
        if (id) lastSessionId = id;
      });
      if (typeof off === 'function') disposers.push(off);
    } catch (e) {
      // 拿不到就退化成"只能手动触发"，但要说出来 —— 静默失败是这类 bug 的温床
      try {
        ctx?.logger?.warn?.(`[dsh-watch-together] session/event hook failed: ${e?.message ?? e}`);
      } catch { /* 日志都没有就只能算了 */ }
    }
  }

  // 声音适配器（可选）：只通过 tts 接口挂，不 import voice.js。
  // 这里也保留启动时挂载，这样第一次只调 `say`（还没开窗）也有声音。
  try {
    const v = await getTtsPort().attachConfigured?.({ log: (m) => ctx?.logger?.info?.(m) });
    if (v && !v.ok && v.reason !== 'not-configured') {
      ctx?.logger?.warn?.(`[dsh-watch-together] voice adapter not loaded: ${v.reason}`);
    }
  } catch (e) {
    ctx?.logger?.warn?.(`[dsh-watch-together] voice adapter crashed: ${e?.message ?? e}`);
  }

  // 到点的台词写进**统一文本流**（聊天框 / 悬浮窗读同一份，声音也从这里取）。
  // 订阅时带 `voice: false` —— 只做展示，不该让循环以为"有人会念"而不再叫醒模型。
  disposers.push(attachSpeechToChat());

  disposers.push(...tools.map((tool) => ctx.tools.register(tool)));

  // 设置页是可选能力：没有本机 webServer 的宿主只注册 watch_together。
  const attachSettings = (settingsCtx) => {
    try {
      const settings = createSettingsPage({ ctx: settingsCtx, env: process.env, log: (message) => settingsCtx?.logger?.warn?.(message) });
      if (settings) {
        disposers.push(settings.dispose);
        disposers.push(settingsCtx.tools.register(defineTool(settings.tool)));
      }
    } catch (e) {
      try { settingsCtx?.logger?.warn?.('[dsh-watch-together] settings page failed: ' + String(e?.message ?? e)); } catch { /* ignore */ }
    }
  };
  // webServer 可能晚于插件就绪；动态 inject 比 apply 时硬探测更可靠。
  if (typeof ctx.inject === 'function') {
    try {
      const off = ctx.inject(['webServer'], (webCtx) => attachSettings(webCtx));
      if (typeof off === 'function') disposers.push(off);
    } catch (e) {
      try { ctx?.logger?.warn?.('[dsh-watch-together] settings injection failed: ' + String(e?.message ?? e)); } catch { /* ignore */ }
    }
  } else {
    attachSettings(ctx);
  }

  return () => {
    for (const dispose of disposers.reverse()) dispose?.();
  };
}

/** 看门狗：apply 里任何 await 卡住都会拖住宿主启动，超时就交回空 disposer。 */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
