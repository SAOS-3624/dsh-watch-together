/**
 * settings/server.js — 陪看插件自己的本机设置页与 API。
 *
 * 同分镜插件：host-only 包不为了一个表单去构建 lazy-CJS 浏览器半侧；页面是
 * 本机 HTML，由 watch_together_settings 工具给出带随机 token 的地址。
 */

import { randomBytes } from 'node:crypto';

import { checkEnvironment } from './deps.js';
import {
  configPaths, readVideoSettings, readVoiceSettings, readWatchSettings,
  writeVideoSettings, writeVoiceSettings, writeWatchSettings,
} from './config.js';
import { settingsPage } from './page.js';

const PAGE_PATH = '/dsh-watch-together/settings';
const API_PREFIX = PAGE_PATH + '/api';
const MAX_BODY = 64 * 1024;

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sameToken(actual, expected) {
  if (typeof actual !== 'string' || actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体太大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

function statePayload(env) {
  return {
    video: readVideoSettings(env),
    watch: readWatchSettings(env),
    voice: readVoiceSettings(env),
    paths: configPaths(env),
  };
}

/**
 * @param {{ ctx: object, env?: NodeJS.ProcessEnv, log?: Function }} options
 * @returns {null | { url: string, tool: object, dispose: () => void }}
 */
export function createSettingsPage({ ctx, env = process.env, log = () => {} } = {}) {
  const webServer = ctx?.get?.('webServer');
  if (!webServer || typeof webServer.register !== 'function') return null;
  const token = randomBytes(32).toString('hex');
  let disposed = false;

  const handle = async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname === PAGE_PATH) {
        if (!sameToken(url.searchParams.get('token'), token)) return json(res, 403, { error: 'token 无效' });
        const html = settingsPage();
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'",
        });
        res.end(html);
        return;
      }
      if (!url.pathname.startsWith(API_PREFIX + '/')) return json(res, 404, { error: 'not found' });
      if (!sameToken(req.headers['x-settings-token'], token)) return json(res, 401, { error: 'token 无效' });

      const action = url.pathname.slice(API_PREFIX.length);
      if (req.method === 'GET' && action === '/state') {
        return json(res, 200, statePayload(env));
      }
      if (req.method === 'POST' && action === '/save') {
        const body = await readBody(req);
        if (!body || typeof body !== 'object') throw new Error('请求体必须是对象');
        if (body.video !== undefined) writeVideoSettings(body.video, env);
        if (body.watch !== undefined) writeWatchSettings(body.watch, env);
        if (body.voice !== undefined) writeVoiceSettings(body.voice, env);
        return json(res, 200, statePayload(env));
      }
      if (req.method === 'POST' && action === '/check') {
        return json(res, 200, { checks: await checkEnvironment(ctx, env) });
      }
      return json(res, 404, { error: 'not found' });
    } catch (e) {
      const message = String(e?.message ?? e).slice(0, 300);
      if (!res.headersSent) json(res, 400, { error: message });
      else res.end();
    }
  };

  let routeDispose = null;
  try {
    routeDispose = webServer.register({ kind: 'prefix', path: PAGE_PATH, handler: handle });
  } catch (e) {
    log('[dsh-watch-together] settings page unavailable: ' + String(e?.message ?? e));
    return null;
  }

  const origin = webServer.getOrigin?.() || ('http://127.0.0.1:' + webServer.port);
  const url = origin + PAGE_PATH + '?token=' + token;
  const tool = {
    name: 'watch_together_settings',
    description: [
      'Open the local watch_together settings page: browser debugging port,',
      'chat service port, voice adapter path, and a read-only dependency check',
      'with official download links and setup instructions for Python, the browser extension, and ffmpeg.',
      'Returns a tokenized local URL.',
    ].join(' '),
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true },
          available: { type: 'boolean', required: true },
          text: { type: 'string', required: true },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: value.text }];
      },
    },
    timeoutMs: 10_000,
    isConcurrencySafe() { return true; },
    async execute() {
      if (disposed) throw new Error('settings page is no longer available');
      return {
        url,
        available: true,
        text: [
          '一起看设置页：',
          url,
          '在浏览器打开；页面里的 API 用这个 URL 的 token 校验，不要把它发给别人。',
          '语音适配器下一场开始时挂载；聊天端口在聊天服务启动时读取（服务已在跑需重启 DSH）。',
          '台词/ASR 的 key 在视频分镜设置页配置。',
        ].join('\n'),
      };
    },
  };

  return {
    url,
    tool,
    dispose() {
      if (disposed) return;
      disposed = true;
      try { routeDispose?.(); } catch { /* ignore */ }
    },
  };
}
