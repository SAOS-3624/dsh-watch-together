import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { runInNewContext } from 'node:vm';

import {
  configuredChatPort, readVideoSettings, readVoiceSettings, readWatchSettings,
  writeVideoSettings, writeVoiceSettings, writeWatchSettings,
} from '../src/settings/config.js';
import { createSettingsPage } from '../src/settings/server.js';

const home = () => mkdtempSync(join(tmpdir(), 'watch-settings-'));
const envOf = (dir) => ({ DSH_HOME: dir });

test('watch settings: 默认端口、写入 watch.json、合并未知字段', () => {
  const dir = home();
  const env = envOf(dir);
  assert.equal(readWatchSettings(env).chatPort, 9377);
  writeFileSync(join(dir, 'watch.json'), JSON.stringify({ custom: true }));
  const saved = writeWatchSettings({ chatPort: 9388 }, env);
  assert.equal(saved.chatPort, 9388);
  assert.equal(configuredChatPort(env), 9388);
  const raw = JSON.parse(readFileSync(join(dir, 'watch.json'), 'utf8'));
  assert.equal(raw.custom, true);
  assert.throws(() => writeWatchSettings({ chatPort: 70000 }, env), /65535/);
});

test('watch settings: video 端口与 voice adapter 写入', () => {
  const dir = home();
  const env = envOf(dir);
  const video = writeVideoSettings({ browserPort: 9333 }, env);
  assert.equal(video.browserPort, 9333);
  assert.equal(readVideoSettings(env).browserPort, 9333);
  writeVideoSettings({ browserPort: false }, env);
  assert.equal(readVideoSettings(env).browserPort, null);

  const voice = writeVoiceSettings({ adapter: 'D:/voice/my.mjs' }, env);
  assert.equal(voice.adapter, 'D:/voice/my.mjs');
  assert.equal(readVoiceSettings(env).adapter, 'D:/voice/my.mjs');
  writeVoiceSettings({ adapter: '' }, env);
  assert.equal(readVoiceSettings(env).adapter, '');
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(join(dir, 'voice.json'), 'utf8')), 'adapter'), false);
});

function fakeWeb() {
  let handler = null;
  let inject = null;
  const webServer = {
    port: 3080,
    register(route) { handler = route.handler; return () => { handler = null; }; },
    getOrigin() { return 'http://127.0.0.1:3080'; },
  };
  const ctx = {
    get: () => webServer,
    on(event, callback) {
      if (event === 'webserver/index-inject') inject = callback;
      return () => { inject = null; };
    },
  };
  return {
    webServer,
    ctx,
    handler: () => handler,
    injections() { const table = []; inject?.(table); return table; },
  };
}

function response() {
  const out = { status: 0, headers: {}, body: '' };
  return {
    out, headersSent: false,
    writeHead(status, headers) { out.status = status; out.headers = headers || {}; this.headersSent = true; },
    end(body = '') { out.body = String(body); },
  };
}

async function invoke(handler, { method = 'GET', url = '/', headers = {}, body } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
  req.method = method; req.url = url; req.headers = headers;
  const res = response();
  await handler(req, res);
  return res.out;
}

test('watch settings server: token、保存、key 不适用但路径可读', async () => {
  const dir = home();
  const env = envOf(dir);
  const web = fakeWeb();
  const page = createSettingsPage({ ctx: web.ctx, env });
  assert.ok(page);
  const token = new URL(page.url).searchParams.get('token');
  const table = web.injections();
  assert.equal(table[0].name, '__DSH_WATCH_TOGETHER_SETTINGS__');
  assert.equal(table[0].value.url, page.url, '设置 tab 必须拿到同一个带 token 的 URL');
  const html = await invoke(web.handler(), { url: '/dsh-watch-together/settings?token=' + token });
  assert.equal(html.status, 200);
  assert.match(html.body, /一起看 · 设置/);
  assert.equal((await invoke(web.handler(), { url: '/dsh-watch-together/settings?token=nope' })).status, 403);

  const api = (action, options = {}) => invoke(web.handler(), {
    ...options,
    url: '/dsh-watch-together/settings/api' + action,
    headers: { 'x-settings-token': token, ...(options.headers || {}) },
  });
  assert.equal((await api('/state', { headers: { 'x-settings-token': 'nope' } })).status, 401);
  const saved = await api('/save', {
    method: 'POST',
    body: JSON.stringify({
      video: { browserPort: 9333 },
      watch: { chatPort: 9388 },
      voice: { adapter: 'D:/voice/my.mjs' },
    }),
  });
  assert.equal(saved.status, 200);
  const state = JSON.parse(saved.body);
  assert.equal(state.video.browserPort, 9333);
  assert.equal(state.watch.chatPort, 9388);
  assert.equal(state.voice.adapter, 'D:/voice/my.mjs');
  assert.equal(state.paths.watch.endsWith('watch.json'), true);
  const checked = await api('/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(checked.status, 200);
  const checks = JSON.parse(checked.body).checks;
  for (const id of ['ffmpeg', 'python', 'core']) {
    const row = checks.find((c) => c.id === id);
    assert.match(row.downloadUrl, /^https:\/\//, id + ' 需要官方下载地址');
  }
  const core = checks.find((c) => c.id === 'core');
  assert.equal(core.ok, true, '已安装的核心包必须被识别，不能只在缺包时才有下载按钮');
  assert.match(core.detail, /probe\.js$/);
  assert.equal(page.tool.name, 'watch_together_settings');
  assert.equal((await page.tool.execute()).available, true);
});

test('watch settings: DSH 设置 tab 的 client bundle 可注册', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.dsh.client.platform, 'web');
  assert.equal(pkg.exports['./client'], './lib/client.js');
  let handoff = null;
  const clientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.equal(clientSource.includes('iframe'), false, '设置页必须是原生表单，不能套 iframe');
  const sandbox = { window: { __ModuleLoader__: { load: (h) => { handoff = h; } } }, globalThis: {}, console };
  runInNewContext(clientSource, sandbox);
  const mod = handoff.factory(() => ({ createElement: () => ({}) }));
  const registered = [];
  mod.apply({ slots: { inject(_name, callback) { callback(); }, register(options, component) { registered.push({ options, component }); } } });
  const tab = registered.find((entry) => entry.options.name === 'settings.plugins.tab');
  assert.equal(tab.options.id, 'watch-together');
  assert.equal(tab.options.label(), '一起看');
  assert.equal(typeof tab.component, 'function');
  const bundle = registered.find((entry) => entry.options.name === 'plugins.bundle.config');
  assert.equal(bundle.options.key, 'dsh-watch-together');
  assert.equal(bundle.component({ view: 'summary' }), null);
});

test('watch settings server: 没有 webServer 时返回 null', () => {
  assert.equal(createSettingsPage({ ctx: { get: () => undefined }, env: { DSH_HOME: home() } }), null);
});
