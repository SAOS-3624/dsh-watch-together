/**
 * chat-server.js — 聊天框的 localhost 服务：一条页面路由 + 四个 API + 生命周期。
 *
 * 路由：
 *   GET  /              完整版页面（消息列表 + 输入框，只读兜底）
 *   GET  /api/messages  自 `since` 起的增量，给页面每 600ms 轮询
 *   POST /api/say       用户说的话，写进流并回调 onUser
 *   POST /api/position  浏览器扩展上报播放位置（见 position-bridge.js）
 *   GET  /api/position  查最近一次上报（popup / doctor 用）
 *
 * 页面内容在 `chat-view.js`，流在 `chat-store.js`。这里只做"收请求、派给谁"。
 * CLI（`watch.mjs`）和 DSH 插件（`watch_together`）都读同一个文件、同一套 watcher，
 * 谁先起服务谁占端口，另一个复用（`chatAlive` 判）。
 *
 * 输入框的主入口是 Python 悬浮窗（`floating-window.js`），不是这个页面：
 * 浏览器置顶小窗（`GET /widget` + `documentPictureInPicture`）那条老路已删除。
 */

import { createServer } from 'node:http';

import { CHAT_PAGE, renderPage } from './chat-view.js';
import { appendChat, readChat } from './chat-store.js';
import { readBridge, readHello, writeBridge, writeHello } from './position-bridge.js';

export const DEFAULT_CHAT_PORT = 9377;

/**
 * 起聊天服务（localhost）。返回 { port, server, close }，调用方决定常驻还是用完就关。
 *
 * @param {{ port?: number, env?: object, onUser?: (text:string)=>void, log?: Function }} o
 */
export async function startChatServer({
  port = DEFAULT_CHAT_PORT, env = process.env, onUser = null, log = null,
} = {}) {
  const page = renderPage(CHAT_PAGE, port);

  // 扩展从**网页的源**发请求，属于跨域；而且是从公网页面访问本地地址，
  // Chrome 的 Private Network Access 还要求预检里看到 allow-private-network。
  // 我们只暴露"上报位置"和"读位置"，没有敏感信息，所以直接放开。
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-private-network': 'true',
    'cache-control': 'no-store',
  };

  const server = createServer(async (req, res) => {
    let u;
    try { u = new URL(req.url, 'http://127.0.0.1'); } catch { res.writeHead(400); res.end(); return; }

    // 扩展直接 fetch（不经过 service worker）时会有这一趟预检
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    // ---- 扩展加载时打的招呼：用来区分"没装"和"装了但没视频"
    if (u.pathname === '/api/hello') {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 4000) req.destroy(); });
        req.on('end', async () => {
          let j = {};
          try { j = JSON.parse(body || '{}'); } catch { /* 空 body 也算打招呼 */ }
          await writeHello(j, { env }).catch(() => null);
          res.writeHead(200, { ...cors, 'content-type': 'application/json; charset=utf-8' });
          res.end('{"ok":true}');
        });
        return;
      }
      const h = await readHello({ env }).catch(() => null);
      res.writeHead(200, { ...cors, 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(h ? { ok: true, ...h } : { ok: false }));
      return;
    }

    // ---- 浏览器扩展上报位置
    if (u.pathname === '/api/position') {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 16_000) req.destroy(); });
        req.on('end', async () => {
          let sample = null;
          try { sample = await writeBridge(JSON.parse(body), { env }); } catch { /* 坏请求就当没收到 */ }
          res.writeHead(sample ? 200 : 400, { ...cors, 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(sample ? { ok: true, pos: sample.pos } : { ok: false }));
        });
        return;
      }
      // 这个处理器是 async 的，异常必须自己收住 —— 否则会在 server 里变成
      // unhandledRejection，把整个进程带下去（Node 15 起默认行为）。
      const b = await readBridge({ env }).catch(() => null);
      res.writeHead(200, { ...cors, 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(b ?? { ok: false, reason: 'no-fresh-position' }));
      return;
    }

    if (u.pathname === '/' || u.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page);
      return;
    }
    if (u.pathname === '/api/messages') {
      const since = Math.max(0, Number(u.searchParams.get('since')) || 0);
      const all = readChat(env);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ total: all.length, msgs: all.slice(since) }));
      return;
    }
    if (u.pathname === '/api/say' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 8000) req.destroy(); });
      req.on('end', () => {
        let ok = false;
        try {
          const j = JSON.parse(body);
          const text = String(j?.text ?? '').trim().slice(0, 500);
          if (text) {
            appendChat('user', text, {}, env);
            ok = true;
            log?.(`[用户] ${text}`);
            onUser?.(text);
          }
        } catch { /* 坏请求就算了 */ }
        // ok:false 让页面能把话回填进输入框 —— 之前一律 ok:true，
        // 服务端没写进去用户也不知道，字就丢了
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok }));
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  return { port, server, close: () => new Promise((r) => server.close(() => r())) };
}

/**
 * 把聊天框**准备好**（幂等）：服务没起来就起，起来了就什么都不做。
 *
 * 为什么需要它：第一次调用要绑端口 + 可能要开标签页，是异步的；而调用方（`watch_together`
 * 进入阻塞之前）只想要一句 `void ensureChatSession(port)` —— 起不来也不该让陪看失败，
 * 所以这里把异常吞掉，只留一个失败的 promise。
 */
let chatSession = null;
export function ensureChatSession(port = DEFAULT_CHAT_PORT) {
  // 测试或"不想起服务"的场景：`DSH_WATCH_NO_CHAT=1` 直接不给。否则它会一直 listen，
  // 进程（尤其实在 `node --test` 里）因为一个活着的 server 退不出去 —— 实测卡满 60 秒。
  if (process.env.DSH_WATCH_NO_CHAT === '1') return Promise.resolve(null);
  if (!chatSession) {
    // **起不来不许把失败永久缓存**：以前一被赋成"失败的 promise"，这一整个进程里就再也不会
    // 尝试监听 —— 端口被别人占过一下，插话通道就永久废掉，而且完全没有提示。
    chatSession = startChatServer({ port })
      .catch(() => null)
      .then((srv) => {
        if (!srv) chatSession = null;
        return srv;
      });
  }
  return chatSession;
}

/** 把已经起好的那个服务关掉（测试/退出用） */
export async function closeChatSession() {
  const s = chatSession;
  chatSession = null;
  if (s) {
    try { const r = await s; await r?.close?.(); } catch { /* 关不掉就算了 */ }
  }
}

/** 这个端口上有没有已经跑着的聊天服务 */
export async function chatAlive(port = DEFAULT_CHAT_PORT, timeoutMs = 1200) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/messages?since=0`, { signal: ac.signal });
    return r.ok;
  } catch { return false; } finally { clearTimeout(timer); }
}

/**
 * 聊天记录页的地址。**只读兜底**：输入框的主入口是 `floating-window.js` 打开的
 * Python 悬浮窗（`examples/floating-chat/window.py`）。两个前端读同一个 `chat.jsonl`，
 * 都开着也不冲突。页面里说的话 → `POST /api/say` → 写进 chat.jsonl → 阻塞循环
 * 每 150–500ms 读一次，立刻把这一句交还给模型（见 interrupt.js / watch-run.js 的 wait 循环）。
 */
export function chatPageUrl(port = DEFAULT_CHAT_PORT) {
  return `http://127.0.0.1:${port}/`;
}
