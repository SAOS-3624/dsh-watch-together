/**
 * background.js — 把页面报上来的位置 POST 给本机的陪看服务。
 *
 * 为什么由这里发而不是 content.js 发：页面是 https 的公网站点，目标是 127.0.0.1，
 * 属于"跨域 + 私有网络访问"，浏览器有两道闸门。扩展的后台因为声明了
 * host_permissions，不受这两道限制。所以读取在页面里，发送在这里。
 *
 * 除了位置，这里还会打一声招呼（`/api/hello`）：
 * 光看"有没有收到位置"分不清"扩展没装"和"装了但这个页面没视频"，
 * 而装了扩展的人第一件事就是想知道"它到底加载了没有"。
 */

/* global chrome */

/** 陪看插件/CLI 起的本地服务（聊天框用的也是这个端口） */
const BASE = 'http://127.0.0.1:9377';
const ENDPOINT = `${BASE}/api/position`;
const HELLO = `${BASE}/api/hello`;

/** 最近一次上报的结果，popup 会来问 */
let lastResult = { ok: false, at: 0, error: '还没有上报过', pos: null, title: null };

/** service worker 每次被唤醒都会重新加载这个模块 —— 正好当"我还活着"的心跳 */
let helloSent = false;

async function sayHello(force = false) {
  if (helloSent && !force) return;
  helloSent = true;
  try {
    await fetch(HELLO, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: chrome.runtime.getManifest().version }),
    });
  } catch {
    // 服务没起也正常：下次 service worker 醒来会再试
    helloSent = false;
  }
}

void sayHello();

chrome.runtime.onInstalled.addListener((details) => {
  void sayHello(true);
  // 刚装好/刚更新：开一个说明页，让用户知道"接下来要做什么"
  if (details?.reason === 'install' || details?.reason === 'update') {
    chrome.tabs?.create?.({ url: chrome.runtime.getURL('welcome.html') });
  }
});

chrome.runtime.onStartup?.addListener(() => { void sayHello(true); });

async function postPosition(payload) {
  try {
    const r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await r.json().catch(() => ({}));
    lastResult = {
      ok: Boolean(r.ok && j?.ok),
      at: Date.now(),
      error: r.ok ? (j?.ok ? null : '服务端拒收（位置不是数字？）') : `HTTP ${r.status}`,
      pos: payload?.pos ?? null,
      title: payload?.title ?? null,
    };
  } catch (e) {
    // 最常见的原因就一个：陪看服务没起（没开 DSH、也没跑 watch.mjs bridge）
    lastResult = {
      ok: false,
      at: Date.now(),
      error: '连不上 127.0.0.1:9377 —— 陪看服务没在跑',
      pos: payload?.pos ?? null,
      title: payload?.title ?? null,
    };
    void e;
  }
  return lastResult;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'position') {
    postPosition(msg.payload).then(sendResponse);
    return true;                    // 异步回包，必须返回 true 让通道留着
  }
  if (msg?.type === 'status') {
    sendResponse(lastResult);
    return false;
  }
  if (msg?.type === 'hello') {
    sayHello(true).then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});
