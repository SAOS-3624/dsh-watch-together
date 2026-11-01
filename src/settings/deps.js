/**
 * settings/deps.js — 陪看设置页的环境自检。只读，不安装。
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { readVideoSettings, readVoiceSettings, readWatchSettings } from './config.js';

const run = promisify(execFile);
const TIMEOUT = 2500;
const require = createRequire(import.meta.url);

async function version(command, args) {
  try {
    const { stdout, stderr } = await run(command, args, { timeout: TIMEOUT, windowsHide: true, maxBuffer: 64 * 1024 });
    const line = String(stdout || stderr).trim().split(/\r?\n/)[0].slice(0, 120);
    return { ok: true, detail: line || '已安装' };
  } catch (e) {
    return { ok: false, detail: e?.code === 'ENOENT' ? '未找到' : String(e?.message ?? e).slice(0, 120) };
  }
}

async function firstOf(list) {
  const errors = [];
  for (const [command, args] of list) {
    const r = await version(command, args);
    if (r.ok) return r;
    errors.push(r.detail);
  }
  return { ok: false, detail: errors[0] || '未找到' };
}

function portOpen(port, timeoutMs = 450) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    const done = (value) => { socket.removeAllListeners(); socket.destroy(); resolve(value); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function downloadFor(id, platform = process.platform) {
  const win = platform === 'win32';
  switch (id) {
    case 'ffmpeg':
    case 'ffprobe':
      return {
        downloadUrl: win
          ? 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
          : 'https://ffmpeg.org/download.html',
        downloadLabel: win ? '下载 FFmpeg zip' : '下载 FFmpeg',
      };
    case 'python':
      return {
        downloadUrl: win ? 'https://www.python.org/downloads/windows/' : 'https://www.python.org/downloads/',
        downloadLabel: '下载 Python',
      };
    case 'core':
      return {
        downloadUrl: 'https://github.com/SAOS-3624/dsh-video-storyboard',
        downloadLabel: '获取分镜插件',
      };
    case 'extension':
      return {
        downloadUrl: 'https://github.com/SAOS-3624/dsh-watch-together/tree/main/extension',
        downloadLabel: '扩展目录',
      };
    case 'voice':
      return {
        downloadUrl: 'https://github.com/SAOS-3624/dsh-watch-together/tree/main/examples/voice-edge-tts',
        downloadLabel: '语音示例',
      };
    case 'browser':
      return {
        downloadUrl: 'https://learn.microsoft.com/en-us/microsoft-edge/devtools-guide-chromium/remote-debugging/',
        downloadLabel: '调试端口说明',
      };
    default:
      return {};
  }
}

function corePackage() {
  try {
    // package.json is intentionally absent from the core package exports map,
    // so resolve an exported module face instead of the manifest.
    return { ok: true, detail: require.resolve('dsh-video-storyboard/probe') };
  } catch {
    return { ok: false, detail: '未解析到 dsh-video-storyboard（陪看依赖它建段）' };
  }
}

function extension() {
  const path = fileURLToPath(new URL('../../extension/manifest.json', import.meta.url));
  return {
    ok: existsSync(path),
    detail: existsSync(path) ? '扩展目录在 ' + path : '扩展目录缺失：' + path,
  };
}

function floatingWindow() {
  const path = fileURLToPath(new URL('../../examples/floating-chat/window.py', import.meta.url));
  return {
    ok: existsSync(path),
    detail: existsSync(path) ? path : '悬浮窗脚本缺失：' + path,
  };
}

function voice(env) {
  const cfg = readVoiceSettings(env);
  if (!cfg.adapter) return { ok: false, detail: '未配置（可选；只影响念台词）' };
  if (/^[a-zA-Z]:[\\/]|^\\\\|^\.{1,2}[\\/]|^\//.test(cfg.adapter)) {
    return { ok: existsSync(cfg.adapter), detail: existsSync(cfg.adapter) ? cfg.adapter : '文件不存在：' + cfg.adapter };
  }
  return { ok: true, detail: cfg.adapter + '（包名，挂载时才能校验）' };
}

/** @returns {Promise<Array<{id:string,label:string,ok:boolean,detail:string}>>} */
export async function checkEnvironment(_ctx, env = process.env) {
  const python = await firstOf([['python', ['--version']], ['py', ['--version']]]);
  let ffmpegCmd = 'ffmpeg';
  let ffprobeCmd = 'ffprobe';
  try {
    const core = await import('dsh-video-storyboard/probe');
    ffmpegCmd = core.DEFAULT_FFMPEG || ffmpegCmd;
    ffprobeCmd = core.DEFAULT_FFPROBE || ffprobeCmd;
  } catch { /* 独立测试时可能没有核心包；退回 PATH */ }
  const ffmpeg = await version(ffmpegCmd, ['-version']);
  const ffprobe = await version(ffprobeCmd, ['-version']);
  const core = corePackage();
  const ext = extension();
  const win = floatingWindow();
  const voiceState = voice(env);
  const video = readVideoSettings(env);
  const watch = readWatchSettings(env);
  const browserOpen = video.browserPort ? await portOpen(video.browserPort) : false;
  const chatOpen = await portOpen(watch.chatPort);
  const rows = [
    { id: 'ffmpeg', label: 'ffmpeg', ...ffmpeg },
    { id: 'ffprobe', label: 'ffprobe', ...ffprobe },
    { id: 'python', label: 'Python（悬浮窗）', ...python },
    { id: 'core', label: 'dsh-video-storyboard', ...core },
    { id: 'extension', label: '浏览器位置扩展', ...ext },
    { id: 'floating', label: 'Python 悬浮窗脚本', ...win },
    {
      id: 'browser', label: '浏览器调试端口 :' + (video.browserPort || '未配置'),
      ok: browserOpen, detail: browserOpen ? '可连接' : '未连接（扩展/SMTC 仍可能提供位置）',
    },
    {
      id: 'chat', label: '聊天服务 :' + watch.chatPort,
      ok: true, detail: chatOpen ? '已有服务在监听' : '端口空闲；首次陪看会启动',
    },
    { id: 'voice', label: '语音适配器', ...voiceState },
  ];
  return rows.map((row) => ({ ...row, ...downloadFor(row.id) }));
}
