/**
 * floating-window.js — 打开**陪看悬浮窗**（`examples/floating-chat/window.py`）。
 *
 * ## 为什么是 Python，不是浏览器
 *
 * 浏览器那条路（`GET /widget` + `documentPictureInPicture`）能置顶，但要先开一个标签页，
 * 关掉标签页就没了 —— 它是"把页面搬进小窗"，不是独立的窗口。现在的前端是 tkinter：
 * 无边框、置顶、半透明、按住顶部拖动，发的消息直接 append 进同一个 `chat.jsonl`。
 * 所以**默认开 Python 窗，浏览器页只当兜底**（`DSH_WATCH_BROWSER_WIDGET=1` 才开）。
 *
 * ## 脚本从哪来
 *
 * 开发仓库里的那份通常比装到 profile 里的新（`mic.py`/`aec.py`、🎤 语音输入都在仓库里），
 * 所以解析顺序是：
 *
 *   1. `DSH_FLOAT_WINDOW` 环境变量       —— 显式指定脚本
 *   2. `<DSH_HOME>/watch-window.json`    —— `{ "script": "...", "python": "..." }`
 *      （和 `voice.json` 一样：那里面也是指到开发仓库的适配器）
 *   3. 包里自带的 `examples/floating-chat/window.py`
 *
 * 解释器同理：`DSH_FLOAT_PYTHON` → 配置里的 `python` → `pythonw`（不留黑框）→ `python`。
 *
 * ## 一个进程只开一次
 *
 * 用 pid 锁文件（`<DSH_HOME>/watch-window.pid`）：进程还活着就不重复开窗，
 * 免得每调一次 `watch_together` 弹一个。
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 包里自带的那份（装到 profile 之后就在这个位置） */
const PACKAGED = join(HERE, '..', 'examples', 'floating-chat', 'window.py');

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

export function windowConfigPath() {
  return join(dshHome(), 'watch-window.json');
}

function pidPath() {
  return join(dshHome(), 'watch-window.pid');
}

/** 读配置；坏 JSON 当作没有（不能让开窗失败） */
function readConfig() {
  try {
    return JSON.parse(readFileSync(windowConfigPath(), 'utf8')) ?? {};
  } catch {
    return {};
  }
}

/** 这个脚本最终用哪个文件（不检查存在性，交给调用方报清楚） */
export function resolveWindowScript(cfg = readConfig()) {
  const explicit = process.env.DSH_FLOAT_WINDOW || cfg.script;
  if (explicit) return explicit;
  return PACKAGED;
}

/** 解释器候选：win 上 pythonw 不留黑框；没有 pythonw 就用 python */
function pythonCandidates(cfg = readConfig()) {
  const list = [];
  if (process.env.DSH_FLOAT_PYTHON) list.push(process.env.DSH_FLOAT_PYTHON);
  if (cfg.python) list.push(cfg.python);
  if (process.platform === 'win32') list.push('pythonw.exe', 'python.exe');
  else list.push('python3', 'python');
  return list;
}

/** 上次开的窗口还活着吗？（pid 复用会误判，但代价只是"少开一次"，可接受） */
function stillRunning() {
  let pid = 0;
  try {
    pid = Number(readFileSync(pidPath(), 'utf8').trim());
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 悬浮窗还开着吗？（给"关窗就结束陪看"用）
 *
 * 用户把窗口一关，就是"我看完了"最直接的表达 —— 比任何位置推断都准。
 * 所以这里只认 pid 存活，不猜别的。
 */
export function floatingWindowAlive() {
  if (process.env.DSH_WATCH_NO_WIDGET === '1') return false;
  return stillRunning();
}

/**
 * 开窗（幂等）。
 *
 * @param {{log?: (m: string) => void, force?: boolean}} [o]
 *        `force` 跳过"已经在跑"的判断（手工排查用）
 * @returns {{ok: boolean, script?: string, python?: string, reason?: string}}
 */
export function openFloatingWindow({ log = null, force = false } = {}) {
  if (process.env.DSH_WATCH_NO_WIDGET === '1') return { ok: false, reason: 'disabled' };
  const cfg = readConfig();
  let script = resolveWindowScript(cfg);
  if (!existsSync(script)) {
    // 配的那份没了（仓库挪走了）就退回包里自带的 —— 少新功能也不能没窗口
    if (script !== PACKAGED && existsSync(PACKAGED)) {
      log?.(`[widget] configured script missing, falling back to packaged: ${PACKAGED}`);
      script = PACKAGED;
    } else {
      return { ok: false, reason: `script-not-found: ${script}`, script };
    }
  }
  if (!force && stillRunning()) return { ok: false, reason: 'already-opened', script };

  let lastErr = null;
  for (const python of pythonCandidates(cfg)) {
    try {
      const child = spawn(python, [script], {
        stdio: 'ignore',
        detached: true,
        // 别弹控制台窗口；不 detach 的话关掉宿主会把窗口一起带走（我们要它独立活着）
        windowsHide: true,
      });
      child.on('error', (e) => { lastErr = e; log?.(`[widget] ${python} failed: ${e?.message ?? e}`); });
      child.unref?.();
      try {
        writeFileSync(pidPath(), String(child.pid ?? ''), 'utf8');
      } catch { /* 写不了 pid 只是会多开一次 */ }
      return { ok: true, script, python };
    } catch (e) {
      lastErr = e;
    }
  }
  return { ok: false, reason: String(lastErr?.message ?? 'no-python'), script };
}
