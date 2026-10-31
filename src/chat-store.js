/**
 * chat-store.js — 统一文本流：一个 jsonl 文件，三种 role。
 *
 * ```
 *   role:'line'       剧本台词（say:true 时会被念）
 *   role:'assistant'  模型插话（watch_together 的 say 参数写进来）
 *   role:'user'       用户从聊天框说的话（不念）
 * ```
 *
 * ## 为什么用文件而不是别的
 *
 * 阻塞等待期间，**宿主的输入框不能实时把话送到模型手里**。实测（WorkBuddy）：
 * 用户 03:05:35 发的消息，写进会话文件时排在我 03:05:52 那条回复**之后** —— 事后补写。
 * 42 秒的文件大小监控里一个字节都没长。所以"发消息打断阻塞"在宿主这一层不成立。
 *
 * 而这里的 jsonl 是我们自己 append 的，**写盘即时**：阻塞循环每 500ms 读一次就能看见。
 * 这是唯一真正"边等边能听见"的通道。
 *
 * 这个文件只管"流里有什么"。HTTP 服务和页面在 `chat-server.js` / `chat-view.js`。
 */

import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { cacheDir } from 'dsh-video-storyboard/cache';
import { emitSpeech, onSpeech, speechSubscribers } from './voice.js';

/** 聊天记录（jsonl，一行一条 {role, text, at}） */
export function chatFile(env = process.env) {
  return join(cacheDir(env), 'chat.jsonl');
}

export function readChat(env = process.env) {
  try {
    return readFileSync(chatFile(env), 'utf8').trim().split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

/**
 * 文件末尾那一条的墙钟时间（读不到 = NaN）。
 *
 * 为什么要单独一个函数：`appendChat` 的 `at` 必须严格递增，但**不能为了一个时间戳
 * 把整份聊天记录 parse 一遍** —— 一场两小时几千条，每写一句都全量读，写盘会越来越慢。
 * 只读末尾这一段就够（末尾可能是半行，往前退一条）。
 *
 * 窗口取 16 KB 而不是 4 KB：一条消息最长 2000 字，中文 UTF-8 一个字 3 字节，
 * 一条就能到 6 KB —— 窗口太小会连"上一条"都读不全，退到更早的那条上去。
 */
function tailStamp(file) {
  try {
    const { size } = statSync(file);
    if (!size) return NaN;
    const len = Math.min(16_384, size);
    const fd = openSync(file, 'r');
    try {
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString('utf8').split('\n').filter((l) => l.trim());
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        try {
          const n = Number(JSON.parse(lines[i])?.at);
          if (Number.isFinite(n)) return n;
        } catch { /* 末尾半行：再往前退一条 */ }
      }
      return NaN;
    } finally { closeSync(fd); }
  } catch { return NaN; }
}

/**
 * 追加一条到统一流。
 *
 * `at` 是**墙钟毫秒**（什么时候写进来的）；`t` 是**播放位置秒**（这句对应视频的哪一刻）——
 * 两者别混：`at` 用来排序，`t` 用来和画面比对。
 *
 * @param {'line'|'assistant'|'user'} role
 * @param {string} text
 * @param {{ t?: number|null, say?: boolean }} [meta] `say` = 这条要不要念出来
 */
export function appendChat(role, text, meta = {}, env = process.env) {
  const dir = cacheDir(env);
  try { mkdirSync(dir, { recursive: true }); } catch { /* 已存在 */ }
  // `at` 必须是**严格递增**的序号：同一毫秒里连写两条（用户手快/程序连发）时，
  // 两条会拿到相同的 `at`，而"新消息"的判据是 `at > 已读位置` —— 后一条就永远不算新，
  // 直接丢掉（实测：`test/chat.test.mjs` 里连说两句，第二句收不到）。
  const file = chatFile(env);
  let at = Date.now();
  const prev = tailStamp(file);
  if (Number.isFinite(prev) && at <= prev) at = prev + 1;
  const entry = {
    role,
    text: String(text).slice(0, 2000),
    at,
    ...(Number.isFinite(meta?.t) ? { t: +Number(meta.t).toFixed(2) } : {}),
    ...(meta?.say === true ? { say: true } : {}),
  };
  appendFileSync(chatFile(env), `${JSON.stringify(entry)}\n`, 'utf8');
  return entry;
}

/**
 * 把"该念的台词"写进统一流 —— 这样聊天框里能看见剧本，声音也有得念。
 *
 * ## 写盘的时刻 = **声音真出来那一刻**，不是"到点"那一刻
 *
 * 以前一收到 `due` 就写盘，于是**字先出来、声音后到**：`due` 到"出声"之间还隔着一整套合成
 * —— edge-tts 一次网络往返 + ffplay 启动，短句也要 0.6~2 秒。用户看到的是
 * "台词已经摆在那儿了，一秒后才念"。2026-10-31 实报。
 *
 * 反过来做只会更糟：把话音往后挪（`speechLag`）字和声能对上，但声音离画面越来越远，
 * 那就不叫陪看了。所以**挪的是字**：
 *
 *   - 有会出声的订阅者 → 等它发 `spoken`（适配器在开始播放那一瞬发）再写；
 *   - 没人会出声（没挂适配器） → 照旧收到 `due` 就写，悬浮窗不能空着；
 *   - 适配器不上报 `spoken`（老适配器） → `fallbackMs` 兜底，宁可早一点，也不吞字。
 *
 * `scheduled` 仍然只是清单，不写。
 *
 * @param {{ env?: object, onEntry?: (e:object)=>void, fallbackMs?: number }} [o]
 *        `fallbackMs` 兜底等待（默认 2500ms，可用 `DSH_WATCH_CAPTION_FALLBACK_MS` 覆盖）
 */
export function attachSpeechToChat({ env = process.env, onEntry = null, fallbackMs = null } = {}) {
  const fromEnv = Number(env?.DSH_WATCH_CAPTION_FALLBACK_MS);
  const waitMs = Number.isFinite(fallbackMs) && fallbackMs >= 0
    ? Number(fallbackMs)
    : (Number.isFinite(fromEnv) && fromEnv >= 0 ? fromEnv : 2500);
  /**
   * 同一句的两种状态用同一个 key 配对。**不能用 `seq`**：`spoken` 是适配器新发的一条事件，
   * `emitSpeech` 会另给一个序号，拿 `seq` 去等就永远等不到自己那一句（而兜底会把字又摆一遍）。
   * `at` 是这句在时间轴上的位置，配上正文就够唯一了。
   */
  /** 等声音开口的那几条：`key → 兜底定时器` */
  const waiting = new Map();

  const write = (e) => {
    const entry = appendChat('line', e.text, { t: e.at, say: true }, env);
    writtenKeys.add(speechKey(e.at, e.text));   // 只留最近的一小段：这是防重，不是账本
    if (writtenKeys.size > 500) writtenKeys.clear();
    try { onEntry?.(entry); } catch { /* 展示层的事，别影响写盘 */ }
  };

  return onSpeech((e) => {
    // 插话那句是**先写流再广播**的（`appendSpoken`），这里再写就重复了
    if (e.origin === 'chat') return;
    if (e.state !== 'due' && e.state !== 'spoken' && e.state !== 'skipped') return;
    const text = String(e.text ?? '').trim();
    if (!text) return;
    const key = speechKey(e.at, text);

    // **这句不念了**（适配器排队太久、追不上画面）：把兜底定时器撤掉，字也别摆。
    // 不撤的话 2.5 秒后兜底会把它写进流 —— 屏幕上出现一句根本没出声的台词。
    if (e.state === 'skipped') {
      const timer = waiting.get(key);
      if (timer) { clearTimeout(timer); waiting.delete(key); }
      writtenKeys.add(key);
      return;
    }

    if (e.state === 'spoken') {
      const timer = waiting.get(key);
      if (timer) { clearTimeout(timer); waiting.delete(key); }
      if (writtenKeys.has(key)) return;       // 兜底/写盘那一步已经摆过字了
      write({ at: e.at, text });
      return;
    }

    // `due`：没人会出声就直接写 —— 零依赖路径不能因为等不到 `spoken` 而变哑
    if (speechSubscribers() === 0) { write({ at: e.at, text }); return; }
    if (waiting.has(key) || writtenKeys.has(key)) return;
    const timer = setTimeout(() => {
      waiting.delete(key);
      if (writtenKeys.has(key)) return;
      write({ at: e.at, text });             // 适配器没上报：宁可早一点，也别把字吞掉
    }, waitMs);
    timer.unref?.();
    waiting.set(key, timer);
  }, { voice: false });
}

/**
 * 已经写进流的句子（`at|text`）—— **跨所有写盘路径**共用一个集合。
 *
 * 为什么它在模块级：`appendSpoken()`（写盘的人）和 `attachSpeechToChat()`（展示层订阅者）
 * 必须看到同一份账。以前 `written` 只在订阅者闭包里，而 `appendSpoken` 没法登记自己
 * 刚写过的那句，于是：`say` 那条在 `due` 时被 `origin:'chat'` 挡掉、**不出字**；
 * 一会儿声音适配器发来 `spoken`（没有 origin），订阅者认不出这句已经写过了，
 * 就再写一条 —— 悬浮窗里同一句话出现两遍，只念一遍（2026-10-31 实报）。
 */
const writtenKeys = new Set();

/** 一句在时间轴上的唯一标识：`at|text`（`at` 可能为 null，配正文也够） */
function speechKey(at, text) {
  return `${Number.isFinite(Number(at)) ? Number(at) : 'null'}|${String(text ?? '')}`;
}

/** 这句是不是已经写进流了 */
export function wasWritten(at, text) {
  return writtenKeys.has(speechKey(at, text));
}

/**
 * **唯一出口**：往悬浮窗（`chat.jsonl`）写一句话，并且**一定经过语音播报**。
 *
 * 为什么必须收成一个入口：以前有两条写盘的路 ——
 *   `appendAssistantSay()`（写 + 发语音事件）和直接 `appendChat('line', …)`（只写）。
 * 于是"我补写的台词"在窗口里看得见、却一点声都没有（实测用户第一反应就是
 * "为什么你写的台词没有语音播报"）。凡是**说给用户的话**，都得走这里：
 * 写盘和发声是同一次调用的两个副作用，谁也离不开谁。
 *
 * `speak: false` 只留给**诊断行**（麦克风状态、写盘失败之类的 `meta`），
 * 那些是给眼睛看的日志，不该念出来。
 *
 * `origin: 'chat'` 是给展示层订阅者的信号："这条已经在流里了，别再写第二遍"
 * （见 `attachSpeechToChat`）。
 *
 * @param {'assistant'|'line'|'meta'} role
 * @param {string} text
 * @param {{t?: number|null, env?: object, speak?: boolean}} [o]
 */
export function appendSpoken(role, text, { t = null, env = process.env, speak = true } = {}) {
  const clean = String(text ?? '').trim();
  if (!clean) return null;
  const entry = appendChat(role, clean, { t, say: speak }, env);
  // **登记**：这句已经在流里了。之后声音适配器发来的 `spoken`（没有 origin）看到这条就不会再写一遍。
  writtenKeys.add(speechKey(t, clean));
  if (writtenKeys.size > 500) writtenKeys.clear();
  if (speak) emitSpeech({ at: t, text: clean, state: 'due', origin: 'chat' });
  return entry;
}

/** 模型插话时说的那一句 —— 就是 `appendSpoken('assistant', …)` 的别名，保留旧名字 */
export function appendAssistantSay(text, { t = null, env = process.env } = {}) {
  return appendSpoken('assistant', text, { t, env });
}

/**
 * 盯"新来的用户消息"。
 *
 * 以创建时刻的条数为基线，之后只看增量 —— 历史消息一条都不会被误判成新插话。
 * 同一批里如果有多条用户消息，**只消费到被报告的那条**：剩下的留在未读区，
 * 下次 poll（模型回完话再来）接着报。一口气把整批标成已读的话，
 * "回完话再来取剩下的"就变成"永远取不到" —— 那是丢用户的话。
 *
 * ## 为什么按**字节**增量读，而不是每次重读整个文件
 *
 * 这个 poll 在阻塞等待里是 **150 ms 一次**（见 interrupt.js 的 sleepWithChat）。
 * 以前每次 `readChat()` 把整份聊天记录读出来再逐行 parse：两小时一场下来几千条，
 * 相当于每秒把几百 KB 的文本反复解码 —— 纯浪费，而且随会话变长越来越慢。
 * 现在只读**上次之后新追加的那段字节**（`chat.jsonl` 只会 append），
 * 代价和文件大小无关。
 */
export function makeChatWatcher(env = process.env) {
  // **不能按"条数"分页**：chat.jsonl 会被就地清理/重启窗口后重写，条数一缩，
  // `seen` 就永远大于文件行数 —— watcher 从此聋掉，用户在窗口里说的话再也没人接。
  // （2026-10-31 现场：用户 19:02:53 说了一句，19:03:00 和 19:03:16 台词还在正常念，
  //  说明钟是活的，唯独这句插话没人管。）
  //
  // 改成按**消息自带的墙钟时间**（`at`，毫秒）分页：时间戳单调递增，跟文件行数无关。
  // 基线在**创建那一刻**定下（不是第一次 poll）—— 建好之后写进来的才算新消息。
  const file = chatFile(env);
  const stamp = (m) => {
    const n = Number(m?.at);
    return Number.isFinite(n) ? n : null;
  };
  let lastAt = 0;
  for (const m of readChat(env)) {          // 一个进程只全量读这一次，之后都是增量
    const t = stamp(m);
    if (m?.role === 'user' && t !== null && t > lastAt) lastAt = t;
  }

  let offset = 0;                           // 已经读到第几个字节
  let carry = '';                           // 上次没读完的半行
  try { offset = statSync(file).size; } catch { offset = 0; }
  /** 还有哪些用户消息没被报出去（按 at 升序） */
  const pending = [];

  /** 把新追加的字节读进来，命中用户消息就压进 pending */
  function drain() {
    let size = 0;
    try { size = statSync(file).size; } catch { return; }
    // 文件被清空/重写（用户手动删、换缓存目录）：游标回零重新读
    if (size < offset) { offset = 0; carry = ''; }
    if (size === offset) return;
    const len = size - offset;
    const fd = openSync(file, 'r');
    let text = '';
    try {
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, offset);
      text = buf.toString('utf8');
    } catch { return; } finally { closeSync(fd); }
    offset = size;
    const parts = (carry + text).split('\n');
    carry = parts.pop() ?? '';              // 末尾可能是半行，留到下一拍
    for (const l of parts) {
      let m = null;
      try { m = JSON.parse(l); } catch { continue; }
      if (m?.role !== 'user') continue;
      if (!String(m.text ?? '').trim()) continue;
      const t = stamp(m);
      // 没写 at 的老消息永远不报（否则会重放历史）
      if (t === null || t <= lastAt) continue;
      pending.push({ text: m.text, at: t });
    }
    if (pending.length > 200) pending.splice(0, pending.length - 200);
  }

  return function poll() {
    drain();
    if (pending.length === 0) return null;
    pending.sort((a, b) => a.at - b.at);
    const hit = pending.shift();
    lastAt = hit.at;                 // 只消费到这一条，后面的留着下次报
    return hit;
  };
}
