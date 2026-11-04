/**
 * client.mjs — 跑 `daemon.py` 并把它的 JSON 行协议包成 Promise。
 *
 * 只做三件事：起进程、按 id 配对请求与回执、进程死了让上层知道。
 * **不判断该不该念**（那是语音总线的事），**也不碰引擎参数**（那是 daemon 自己的事）。
 *
 * 音频不经过这里：daemon 直接写进 ffplay 的管道，node 只收状态行。
 * 这样多一跳就多一份缓冲，首声全被它吃掉。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * 从 `edge-tts` 可执行文件反推 python。
 *
 * 不用 `python` 裸名：用户机器上可能有好几个 python，而 edge_tts 只装在其中一个里
 * （`<venv>/Scripts/edge-tts.exe` 旁边的 `python.exe` 才是对的）。
 */
export function pythonFor(edgeBin) {
  if (!edgeBin) return null;
  const dir = dirname(String(edgeBin));
  const win = process.platform === 'win32';
  const cands = win
    ? [join(dir, 'python.exe'), join(dir, 'python3.exe')]
    : [join(dir, 'python3'), join(dir, 'python')];
  for (const c of cands) {
    try { if (existsSync(c)) return c; } catch { /* 下一个 */ }
  }
  return null;
}

/**
 * @param {{ python: string, script: string, args?: string[], onError?: Function, log?: Function }} o
 */
export function startStream({ python, script, args = ['-u', script], onError, log = () => {} }) {
  const extra = process.platform === 'win32' ? { windowsHide: true } : {};
  const proc = spawn(python, args, {
    stdio: ['pipe', 'pipe', 'pipe'], ...extra,
  });

  /** id -> {resolve, reject, first} */
  const pending = new Map();
  let buf = '';
  let dead = null;
  let ready = false;
  let lastError = null;

  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.ev === 'ready') { ready = true; continue; }
      if (ev.ev === 'boot') { log(`[stream] daemon 起来：voice=${ev.voice} rate=${ev.rate}`); continue; }
      const entry = pending.get(ev.id);
      if (!entry) continue;
      if (ev.ev === 'first') {
        entry.first = ev.ms;
        // **先报出声，再等 done**：展示层要的是"字可以出现了"，不是"这段念完了"。
        try { entry.onFirst?.(ev.ms); } catch { /* 回调自己的事 */ }
        continue;
      }
      if (ev.ev === 'done') {
        pending.delete(ev.id);
        entry.resolve({ first: entry.first ?? ev.ms ?? null, done: ev.ms ?? null });
        continue;
      }
      if (ev.ev === 'skip') {
        pending.delete(ev.id);
        entry.resolve({ skipped: true });
        continue;
      }
      if (ev.ev === 'error') {
        pending.delete(ev.id);
        lastError = ev.reason || 'unknown';
        entry.reject(new Error(lastError));
        continue;
      }
    }
  });

  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (d) => {
    for (const line of String(d).split(/\r?\n/)) {
      if (line.trim()) log(line);
    }
  });

  const fail = (reason) => {
    if (dead) return;
    dead = reason;
    for (const [, entry] of pending) entry.reject(new Error(reason));
    pending.clear();
    try { onError?.(reason); } catch { /* 回调自己的事 */ }
  };
  proc.on('exit', (code) => fail(`daemon 退出 code=${code}`));
  proc.on('error', (e) => fail(`daemon 起不来：${e.message}`));

  const send = (obj) => {
    if (dead) return false;
    try {
      proc.stdin.write(JSON.stringify(obj) + '\n');
      return true;
    } catch {
      return false;
    }
  };

  let seq = 0;
  const ask = (op, text, timeoutMs, onFirst) => new Promise((resolve, reject) => {
    if (dead) { reject(new Error(dead)); return; }
    seq += 1;
    const id = seq;
    // 超时兜底：网络卡住时 daemon 那边可能永远不返回，这边不能跟着挂住
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('timeout'));
    }, timeoutMs);
    pending.set(id, {
      onFirst,
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    if (!send({ op, id, text })) {
      clearTimeout(timer);
      pending.delete(id);
      reject(new Error(dead || 'send-failed'));
    }
  });

  return {
    get alive() { return !dead; },
    get warm() { return ready; },
    get lastError() { return lastError; },
    warmUp() { send({ op: 'warm' }); },
    say: (text, { timeoutMs = 30_000, onFirst = null } = {}) => ask('say', text, timeoutMs, onFirst),
    prefetch: (text, timeoutMs = 30_000) => ask('prefetch', text, timeoutMs).catch(() => ({ failed: true })),
    forget: (text) => send({ op: 'forget', text }),
    /**
     * 截断正在念的那一句（**不停进程**）。
     *
     * 和 `stop()` 的区别：`stop` 是 `SystemExit(0)`，整个常驻合成器没了，下一句要
     * 重新预热 1~2 秒；`interrupt` 只杀播放管道那一个 ffplay，daemon 还活着，
     * 下一句从新进程开始念（多花一次 demuxer 探测 ~200ms）。
     */
    interrupt() { try { send({ op: 'interrupt' }); } catch { /* 已经断了 */ } },
    stop() {
      try { send({ op: 'stop' }); } catch { /* already */ }
      setTimeout(() => { try { proc.kill(); } catch { /* already */ } }, 300);
    },
  };
}
