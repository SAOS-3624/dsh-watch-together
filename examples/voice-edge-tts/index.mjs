/**
 * examples/voice-edge-tts — 一个**能出声**的声音适配器，给调试和自用。
 *
 * `src/` 里没有任何一行 import 它。核心只发事件（见 `src/voice.js`），
 * 这个文件订阅事件、把台词念出来，并且在 **stderr 打一行时间码**：
 * 调试时最想知道的就是"这句话到底是第几秒吐出来的"。
 *
 * ## 两件事，别混
 *
 *   收到 `due`   = 该念了（核心按播放位置发的）
 *   发 `spoken`  = **真的出声了**（本文件在合成完成、开始播放那一瞬发）
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

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

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

async function speakEdge(text, { bin, voice, rate, onStart = null }) {
  const out = join(tmpdir(), `voice-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.mp3`);
  const pct = Math.round(Math.max(-10, Math.min(10, Number(rate) || 0)) * 3);
  const args = ['--voice', voice, '--text', text, '--write-media', out];
  if (pct) args.push(`--rate=${pct > 0 ? '+' : ''}${pct}%`);
  if (!(await run(bin, args))) return { ok: false, reason: 'synth-failed' };
  try {
    if (statSync(out).size < 800) return { ok: false, reason: 'empty-audio' };
  } catch { return { ok: false, reason: 'stat-failed' }; }
  // **就在这里上报"要出声了"**：合成已经完成，ffplay 一启动就有声 ——
  // 悬浮窗收到才把字摆出来，于是"字出现"和"张嘴"几乎是同一刻（见 src/chat-store.js）。
  try { onStart?.(); } catch { /* 上报失败不影响念 */ }
  const played = await run('ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', out], 90_000);
  try { unlinkSync(out); } catch { /* 删不掉就留着 */ }
  return played ? { ok: true, engine: 'edge-tts' } : { ok: false, reason: 'play-failed' };
}

/** Windows 系统声音。Linux/macOS 会失败，失败就当没这个引擎。 */
function speakSapi(text, rate, onStart = null) {
  const lit = `'${String(text ?? '').replace(/'/g, "''")}'`;
  const cmd = `$v = New-Object -ComObject SAPI.SpVoice; $v.Rate = ${Math.max(-10, Math.min(10, Number(rate) || 0))}; $null = $v.Speak(${lit})`;
  // PowerShell 冷启动要几百毫秒，上报放在**起进程之前**，宁可略早也别晚（字等声音没关系，声音等字不行）
  try { onStart?.(); } catch { /* 上报失败不影响念 */ }
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd],
      { timeout: 60_000, windowsHide: true }, (err) => resolve(!err));
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
  let chain = Promise.resolve();            // 串行：两句绝不重叠着念

  if (!bin) console.error('[voice] edge-tts 没找到，退回系统声音');

  const off = api.onSpeech((e) => {
    if (e.state !== 'due') return;
    // **先打日志再念**：调试时关心的是"它什么时候吐字"，不是"有没有声"
    console.error(`[voice ${mmss(e.at)}] ${e.text}`);
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
      if (bin) {
        const r = await speakEdge(e.text, { bin, voice, rate, onStart });
        if (r.ok) return;
        console.error(`[voice] edge-tts 失败（${r.reason}），退回系统声音`);
      }
      if (!(await speakSapi(e.text, rate, onStart))) console.error('[voice] 系统声音也不可用，只打日志');
    }).catch((err) => console.error(`[voice] ${err?.message ?? err}`));
  });

  console.error(`[voice] 已接上（engine=${bin ? 'edge-tts' : 'sapi'}，voice=${voice}）`);
  return () => off();
}

export default attach;

