/**
 * examples/voice-edge-tts — 一个**能出声**的声音适配器，给调试和自用。
 *
 * `src/` 里没有任何一行 import 它。核心只发事件（见 `src/voice.js`），
 * 这个文件订阅事件、把台词念出来，并且在 **stderr 打一行时间码**：
 * 调试时最想知道的就是"这句话到底是第几秒吐出来的"。
 *
 * ## 两件事，别混
 *
 *   收到 `scheduled` = 还没到点，可以**预合成**（本文件按台词缓存 mp3，不播放）
 *   收到 `due`       = 该念了（核心按播放位置发的）
 *   发 `spoken`      = **真的出声了**（本文件在开始播放那一瞬发）
 *
 * 悬浮窗认的是 `spoken`：不然字会先摆出来、声音一两秒后才到（`due` → 合成是一次网络往返
 * 加一个 ffplay 启动）。上报晚了就等于又回到旧毛病，所以上报点选在**播放之前**。
 *
 * ## 启用
 *
 * ```json
 * // ~/.dsh/voice.json
 * { "adapter": "<你的路径>/dsh-watch-together/examples/voice-edge-tts/index.mjs" }
 * ```
 *
 * 或者环境变量：`DSH_VOICE_ADAPTER=<同样的路径>`。
 * 不配就是"没人接声音"，到点的台词照旧叫醒模型由模型自己说 —— 功能完整，只是安静。
 *
 * ## 依赖（都可选，缺了逐级降级）
 *
 * | 缺什么 | 后果 |
 * |---|---|
 * | `edge-tts`（`pip install edge-tts`） | 退回 Windows 系统声音（SAPI） |
 * | `ffplay`（ffmpeg 自带） | 合成出来的 mp3 放不出来，只打日志 |
 * | 两个都没有 | 只打日志，不影响陪看 |
 *
 * 音色 / 引擎路径从 `~/.dsh/tts.json` 读（`voice` / `edgeTts` / `rate`）——
 * **那是适配器自己的配置，核心完全不看**。
 *
 * 本文件**不内置任何具体音色**：`voice` 没配时退回中性默认 `zh-CN-YunxiNeural`，
 * 用户应在自己的 `~/.dsh/tts.json` 里写明想用的音色（例如 `zh-CN-XiaoxuanNeural`）。
 * 这样打包发布时不会把某个人的音色带进包里 —— 每个人自己配自己的。
 */

import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pythonFor, startStream } from './stream/client.mjs';

const run = (bin, args, timeoutMs = 60_000) => new Promise((resolve) => {
  execFile(bin, args, { timeout: timeoutMs, windowsHide: true }, (err) => resolve(!err));
});

function config() {
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || homedir(), '.dsh');
  try {
    return JSON.parse(readFileSync(join(home, 'tts.json'), 'utf8')) ?? {};
  } catch {
    return {};
  }
}

/** edge-tts 可执行文件：配置点名 → 环境变量 → 常见 venv → PATH */
function edgeBin(cfg) {
  const home = process.env.USERPROFILE || process.env.HOME || homedir();
  const win = process.platform === 'win32';
  const cands = [
    cfg.edgeTts,
    process.env.DSH_TTS_BIN,
    win ? join(home, '.dsh', 'tts-venv', 'Scripts', 'edge-tts.exe') : join(home, '.dsh', 'tts-venv', 'bin', 'edge-tts'),
    win ? join(home, '.workbuddy', 'binaries', 'python', 'envs', 'tts', 'Scripts', 'edge-tts.exe')
      : join(home, '.workbuddy', 'binaries', 'python', 'envs', 'tts', 'bin', 'edge-tts'),
  ].filter(Boolean);
  for (const c of cands) {
    try { if (existsSync(c)) return c; } catch { /* 下一个 */ }
  }
  for (const dir of String(process.env.PATH ?? '').split(win ? ';' : ':')) {
    if (!dir) continue;
    for (const ext of (win ? ['.exe', '.cmd', ''] : [''])) {
      const p = join(dir, `edge-tts${ext}`);
      try { if (existsSync(p)) return p; } catch { /* 下一个 */ }
    }
  }
  return null;
}

/**
 * 起常驻合成器（`stream/daemon.py`）。**任何一步失败都返回 null**。
 *
 * 声音是可选能力：这里出问题只能退回"每句一个 CLI 进程"的老路，
 * 不能让陪看因为守护进程起不来就整个没声音。所以没有一行 throw。
 *
 * 收益（实测，Win11）：每句 2.4~3.0s → **170~200ms**；预取命中时 **0ms**。
 * 老路每一句都要重付 python 启动 + import + 建连 + ffplay 启动，那是四笔固定开销。
 *
 * `DSH_TTS_STREAM=0` 可以用来强制走老路（排查"到底是不是它的问题"）。
 */
function openStream(bin) {
  if (String(process.env.DSH_TTS_STREAM ?? '1') === '0') return null;
  const python = pythonFor(bin);
  if (!python) return null;
  let script;
  try {
    script = join(dirname(fileURLToPath(import.meta.url)), 'stream', 'daemon.py');
  } catch {
    return null;
  }
  if (!existsSync(script)) return null;
  try {
    return startStream({
      python,
      script,
      log: (m) => console.error(m),
      onError: (reason) => console.error(`[voice] 常驻合成器停了（${reason}），下一句起退回逐句合成`),
    });
  } catch (e) {
    console.error(`[voice] 常驻合成器起不来：${e?.message ?? e}`);
    return null;
  }
}

/** 只合成，不播放。预取和"到点没赶上预取"两条路共用。 */
async function synthEdge(text, { bin, voice, rate }) {
  const out = join(tmpdir(), `voice-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.mp3`);
  const pct = Math.round(Math.max(-10, Math.min(10, Number(rate) || 0)) * 3);
  const args = ['--voice', voice, '--text', text, '--write-media', out];
  if (pct) args.push(`--rate=${pct > 0 ? '+' : ''}${pct}%`);
  if (!(await run(bin, args))) {
    try { unlinkSync(out); } catch { /* 没有文件正常 */ }
    return { ok: false, reason: 'synth-failed' };
  }
  try {
    if (statSync(out).size < 800) {
      try { unlinkSync(out); } catch { /* 空文件删不掉也不影响 */ }
      return { ok: false, reason: 'empty-audio' };
    }
  } catch {
    return { ok: false, reason: 'stat-failed' };
  }
  return { ok: true, path: out, engine: 'edge-tts' };
}

/**
 * 正在念的那一句的「掐断」句柄（老路的 ffplay 进程）。
 *
 * 常驻通道不需要它 —— 那边走 `stream.interrupt()`，杀的是播放管道那个 ffplay。
 * 两条路都要能被打断：串行链只保证"不重叠"，挡不住"越排越长"。
 */
let currentKill = null;

/** 播放一个已经合成好的 mp3；返回时无论成败都删掉临时文件。 */
function playEdge(path, onStart = null) {
  // **就在这里上报"要出声了"**：ffplay 一启动就有声 —— 悬浮窗收到才把字摆出来，
  // 于是"字出现"和"张嘴"几乎是同一刻（见 src/chat-store.js）。
  try { onStart?.(); } catch { /* 上报失败不影响念 */ }
  // 用 spawn 而不是 execFile：需要拿到 child 才能中途掐断（`interruptCurrent`）
  return new Promise((resolve) => {
    const child = spawn('ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', path], {
      windowsHide: true,
    });
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      currentKill = null;
      try { unlinkSync(path); } catch { /* 删不掉就留着 */ }
      resolve(ok);
    };
    currentKill = () => { try { child.kill(); } catch { /* 已经退了 */ } };
    child.on('error', () => done(false));
    child.on('exit', (code) => done(code === 0));
  });
}

/** Windows 系统声音。Linux/macOS 会失败，失败就当没这个引擎。 */
function speakSapi(text, rate, onStart = null) {
  const lit = `'${String(text ?? '').replace(/'/g, "''")}'`;
  const cmd = `$v = New-Object -ComObject SAPI.SpVoice; $v.Rate = ${Math.max(-10, Math.min(10, Number(rate) || 0))}; $null = $v.Speak(${lit})`;
  // PowerShell 冷启动要几百毫秒，上报放在**起进程之前**，宁可略早也别晚（字等声音没关系，声音等字不行）
  try { onStart?.(); } catch { /* 上报失败不影响念 */ }
  // spawn 而不是 execFile：`SpVoice.Speak()` 是阻塞的，只有杀掉进程才能让它闭嘴 ——
  // 没有 edge-tts 的机器全走这条路（实测本机就是），不能中断的话"越堆越长"永远治不好。
  return new Promise((resolve) => {
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], {
      windowsHide: true,
    });
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      currentKill = null;
      resolve(ok);
    };
    const guard = setTimeout(() => { try { child.kill(); } catch { /* 已经退了 */ } done(false); }, 60_000);
    currentKill = () => { try { child.kill(); } catch { /* 已经退了 */ } };
    child.on('error', () => { clearTimeout(guard); done(false); });
    child.on('exit', (code) => { clearTimeout(guard); done(code === 0); });
  });
}

const mmss = (t) => {
  const s = Math.max(0, Number(t) || 0);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(1).padStart(4, '0')}`;
};

/** 排队超过这么久就**放弃**这一句：声音追不上画面时，宁可少说一句，也不要越说越晚。 */
const MAX_QUEUE_LAG_MS = 3500;

/**
 * 适配器入口。核心调用它，把接口递进来。
 *
 * @param {{onSpeech:Function, speechSubscribers:Function, emitSpeech?:Function, emitSpoken?:Function}} api
 * @returns {() => void} detach
 */
export function attach(api) {
  const cfg = config();
  // 不内置任何具体音色：从 ~/.dsh/tts.json 读 `voice`；没配就用中性默认并提示用户自己换。
  // 发布时不带任何人的音色，用户按喜好在 tts.json 里配（如 "zh-CN-XiaoxuanNeural"）。
  const voice = cfg.voice || 'zh-CN-YunxiNeural';
  if (!cfg.voice) console.error('[voice] 未配置 voice（~/.dsh/tts.json），用中性默认 zh-CN-YunxiNeural；'
    + '想用晓萱等音色请在该文件加 "voice": "zh-CN-XiaoxuanNeural"');
  const rate = Number(cfg.rate) || 0;
  const bin = edgeBin(cfg);
  // 常驻合成器：能起就用它（首声 170~200ms），起不来就是 null，全部逻辑退回老路。
  const stream = openStream(bin);
  let chain = Promise.resolve();            // 播放串行：两句绝不重叠着念
  /**
   * 「该念的是第几句」。新的一句进来就 +1，之前排队的看到代际变了就自己退场。
   *
   * 为什么需要：串行链只保证"不重叠"，挡不住"越排越长" —— 模型连说三句，
   * 第三句要等前两句念完才开口，那时候画面早换了，听到的是"它在说上一段的事"。
   * 用户要的是**新的直接顶掉旧的**，不是排队。
   */
  let speakGen = 0;

  /**
   * 掐断当前这一句，并清空排队。
   *
   * 常驻通道走 `stream.interrupt()`（只杀播放管道那个 ffplay，daemon 还活着）；
   * 老路直接 kill 调当前 ffplay。**chain 重置是有意的**：排队的都是"画面已经过去"的旧话。
   */
  function interruptCurrent() {
    if (stream?.alive) { try { stream.interrupt(); } catch { /* 通道挂了就算了 */ } }
    if (currentKill) { try { currentKill(); } catch { /* 已经退了 */ } currentKill = null; }
    chain = Promise.resolve();
  }

  // **预合成**：核心在台词写好、还没到点时发 `scheduled`。这里趁这段时间把 mp3 合成好，
  // 到点只播放；否则 due 才开始跑 edge-tts（CLI 冷启动 + 网络往返 + 完整 mp3），
  // 第一声会晚 0.6~2 秒。没有 prefetch 的旧宿主仍然走 due 现场合成，不破坏兼容。
  const MAX_PREFETCH = 6;
  const prefetched = new Map();             // key -> { task, path, at }
  let prefetchTail = Promise.resolve();
  const keyOf = (e) => `${e.input ?? ''}|${e.segment ?? ''}|${String(e.text ?? '')}`;
  const discard = (entry) => {
    entry.task.then((r) => {
      if (r?.ok && r.path) { try { unlinkSync(r.path); } catch { /* 已删 */ } }
    }).catch(() => {});
  };
  const prefetch = (e) => {
    // **没有 `at` 的事件一律不预取**。适配器是陪看和看屏幕两个插件共用的，
    // 那边（`see-now`）的事件是 `at: null`（它没有时间轴）。而 `Number(null)` 是 0、
    // `Number.isFinite(0)` 为真 —— 放进来会被当成"最早的一句"占满队列，之后
    // `Number(e.at) < farthestAt` 永远是 `0 < 0`（假），新句子再也进不来，预取静默失效。
    if (e.at === null || e.at === undefined) return;
    if (!bin || !e.text || !Number.isFinite(Number(e.at))) return;
    const key = keyOf(e);
    if (prefetched.has(key)) return;
    if (prefetched.size >= MAX_PREFETCH) {
      // 队列满时只留更近的：远处的合成完了也大概率赶不上，别把近处的挤掉。
      let farthestKey = null;
      let farthestAt = -Infinity;
      for (const [k, v] of prefetched) {
        if (v.at > farthestAt) { farthestAt = v.at; farthestKey = k; }
      }
      if (!(Number(e.at) < farthestAt)) return;
      const old = prefetched.get(farthestKey);
      prefetched.delete(farthestKey);
      if (old) discard(old);
    }
    const task = prefetchTail.then(() => synthEdge(e.text, { bin, voice, rate }));
    prefetchTail = task.then(() => {}, () => {});
    const entry = { task, at: Number(e.at) };
    prefetched.set(key, entry);
    task.then((r) => {
      if (!r?.ok) {
        if (prefetched.get(key) === entry) prefetched.delete(key);
        return;
      }
      entry.path = r.path;
    }).catch(() => {});
  };

  if (!bin) console.error('[voice] edge-tts 没找到，退回系统声音');

  const off = api.onSpeech((e) => {
    if (e.state === 'scheduled') {
      // 常驻通道不需要"排队 6 句"那套：它按 text 在内存里缓存，满了淘汰最老的。
      // 老路的 `MAX_PREFETCH` 是文件缓存 + 串行 CLI 逼出来的，这里不用照抄。
      if (stream?.alive && e.at !== null && e.at !== undefined && e.text) {
        stream.prefetch(e.text);
        return;
      }
      prefetch(e);
      return;
    }
    if (e.state !== 'due') return;

    /**
     * **抢占**：新的一句要开口了，把上一句没念完的直接截断、把还在排队的丢掉。
     *
     * 这是用户明确的诉求（"下一句来了直接把上一句停掉，不然越堆越长"）。
     * 代价：被截断的那句后面几个字听不到 —— 但那几个字本来就是"上一段画面"的话，
     * 留着说完反而和眼前的东西对不上。
     */
    speakGen += 1;
    const myGen = speakGen;
    interruptCurrent();

    // 「真的出声了」只报一次：edge 成功之后就不该再由 SAPI 兜底那条报第二遍。
    // 展示层（悬浮窗）等的就是这个上报 —— 不是 `due`（见 src/chat-store.js）。
    let reported = false;
    const onStart = () => {
      if (reported) return;
      reported = true;
      try {
        // 老宿主可能没给 emitSpoken：那就靠展示层的 2.5 秒兜底，功能不残
        api.emitSpoken?.({ at: e.at, text: e.text, input: e.input, segment: e.segment });
      } catch { /* 上报失败不影响念 */ }
    };
    const queuedAt = Date.now();
    chain = chain.then(async () => {
      // 已经被更新的一句顶掉了：直接退场，不念
      if (myGen !== speakGen) return;
      // **排太久了就别念**：串行链只会越排越长，声音离画面越来越远。
      // 核心那边已经按"上一句念完才发下一句"节流，走到这里说明是真的卡住了
      // （合成慢、引擎换挡、机器在忙）—— 这一句放弃，队立刻清空。
      const waited = Date.now() - queuedAt;
      if (waited > MAX_QUEUE_LAG_MS) {
        console.error(`[voice] 跳过（排队 ${(waited / 1000).toFixed(1)}s，追不上画面）：${e.text}`);
        // 没出声的字不该出现在悬浮窗里：让展示层把兜底定时器撤掉
        try {
          api.emitSpeech?.({
            at: e.at, text: e.text, state: 'skipped', input: e.input, segment: e.segment,
          });
        } catch { /* 上报失败不影响后面的话 */ }
        return;
      }
      const key = keyOf(e);
      const ready = prefetched.get(key);
      if (ready) prefetched.delete(key);
      const t0 = Date.now();
      let audio = null;
      // **常驻通道优先**：音频边收边写进常驻 ffplay 的管道，首块就是出声
      // （实测 170~200ms；预取命中时 0ms）。失败也只在**没出过声**时才往下兜底，
      // 出过声再补一遍会变成一句话念两次。
      if (stream?.alive) {
        try {
          const r = await stream.say(e.text, { onFirst: onStart });
          if (!r?.skipped) {
            console.error(`[voice ${mmss(e.at)}] stream first=${r?.first ?? '-'}ms `
              + `done=${r?.done ?? '-'}ms (wait ${waited}ms): ${e.text}`);
            return;
          }
        } catch (err) {
          if (reported) return;
          console.error(`[voice] 常驻通道失败（${err?.message ?? err}），本句退回逐句合成`);
        }
      }
      if (bin) {
        if (ready) {
          audio = await ready.task.catch(() => ({ ok: false, reason: 'prefetch-failed' }));
        } else {
          audio = await synthEdge(e.text, { bin, voice, rate });
        }
        if (audio?.ok) {
          console.error(`[voice ${mmss(e.at)}] ${ready ? 'prefetched' : 'synth'} `
            + `ready ${Date.now() - t0}ms (wait ${waited}ms): ${e.text}`);
          if (await playEdge(audio.path, onStart)) return;
          console.error('[voice] ffplay 失败，继续兜底');
        } else {
          console.error(`[voice] edge-tts 失败（${audio?.reason ?? 'unknown'}），退回系统声音`);
        }
      }
      console.error(`[voice ${mmss(e.at)}] sapi ${Date.now() - t0}ms (wait ${waited}ms): ${e.text}`);
      if (!(await speakSapi(e.text, rate, onStart))) console.error('[voice] 系统声音也不可用，只打日志');
    }).catch((err) => console.error(`[voice] ${err?.message ?? err}`));
  });

  console.error(`[voice] 已接上（engine=${stream?.alive ? 'edge-tts/常驻' : bin ? 'edge-tts' : 'sapi'}，voice=${voice}）`);
  return () => {
    off();
    for (const entry of prefetched.values()) discard(entry);
    prefetched.clear();
    try { stream?.stop(); } catch { /* 已经退出 */ }
  };
}

export default attach;

