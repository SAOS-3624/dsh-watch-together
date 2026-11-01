window.__ModuleLoader__.load({
  id: "dsh-watch-together",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require("react");
    const h = React.createElement;
    const { useEffect, useState } = React;

    const CSS = [
      '[data-dsh-vs]{color:var(--dsw-alias-label-primary,#1f2329);font-size:13px;line-height:20px}',
      '[data-dsh-vs] *{box-sizing:border-box}',
      '[data-dsh-vs] .dsh-vs-section{padding:20px 0;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}',
      '[data-dsh-vs] .dsh-vs-section:first-of-type{padding-top:2px;border-top:0}',
      '[data-dsh-vs] .dsh-vs-section-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 12px}',
      '[data-dsh-vs] .dsh-vs-section-title{margin:0;font-size:14px;line-height:22px;font-weight:600}',
      '[data-dsh-vs] .dsh-vs-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px 18px}',
      '[data-dsh-vs] .dsh-vs-field{display:flex;flex-direction:column;gap:6px;min-width:0}',
      '[data-dsh-vs] .dsh-vs-span-2{grid-column:1/-1}',
      '[data-dsh-vs] .dsh-vs-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#5c6370)}',
      '[data-dsh-vs] .dsh-vs-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a919e)}',
      '[data-dsh-vs] .dsh-vs-input{width:100%;height:34px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:inherit;outline:none}',
      '[data-dsh-vs] .dsh-vs-input::placeholder{color:var(--dsw-alias-label-tertiary,#a0a6b0)}',
      '[data-dsh-vs] .dsh-vs-input:focus{border-color:var(--dsw-alias-brand-primary,#4f7cff);box-shadow:0 0 0 3px rgba(79,124,255,.14)}',
      '[data-dsh-vs] .dsh-vs-deps{display:flex;flex-direction:column}',
      '[data-dsh-vs] .dsh-vs-dep{display:flex;align-items:center;gap:10px;min-height:46px;padding:8px 0;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08))}',
      '[data-dsh-vs] .dsh-vs-dep:first-child{border-top:0;padding-top:2px}',
      '[data-dsh-vs] .dsh-vs-dot{width:7px;height:7px;flex:none;border-radius:50%;background:var(--dsw-alias-state-success-primary,#31a36b)}',
      '[data-dsh-vs] .dsh-vs-dot.is-bad{background:var(--dsw-alias-state-error-primary,#e5484d)}',
      '[data-dsh-vs] .dsh-vs-dot.is-warn{background:var(--dsw-alias-state-warn-primary,#d89614)}',
      '[data-dsh-vs] .dsh-vs-dep-main{min-width:0;flex:1}',
      '[data-dsh-vs] .dsh-vs-dep-name{font-size:13px;line-height:18px}',
      '[data-dsh-vs] .dsh-vs-dep-detail{margin-top:1px;font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary,#8a919e);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '[data-dsh-vs] .dsh-vs-btn{display:inline-flex;align-items:center;justify-content:center;height:32px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:13px;text-decoration:none;cursor:pointer;white-space:nowrap}',
      '[data-dsh-vs] .dsh-vs-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}',
      '[data-dsh-vs] .dsh-vs-btn-sm{height:28px;padding:0 10px;font-size:12px}',
      '[data-dsh-vs] .dsh-vs-btn-primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill,#4f7cff);color:var(--dsw-alias-label-primary-foreground,#fff)}',
      '[data-dsh-vs] .dsh-vs-btn-primary:hover{background:var(--dsw-alias-button-primary-hover,#3f6be0)}',
      '[data-dsh-vs] .dsh-vs-btn:disabled{opacity:.5;cursor:default}',
      '[data-dsh-vs] .dsh-vs-textbtn{padding:0;border:0;background:transparent;color:var(--dsw-alias-brand-primary,#4f7cff);font:inherit;font-size:12px;cursor:pointer}',
      '[data-dsh-vs] .dsh-vs-textbtn:disabled{opacity:.5;cursor:default}',
      '[data-dsh-vs] .dsh-vs-footer{display:flex;align-items:center;gap:12px;padding-top:16px;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}',
      '[data-dsh-vs] .dsh-vs-status{margin-left:auto;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a919e);text-align:right}',
      '[data-dsh-vs] .dsh-vs-status.is-error{color:var(--dsw-alias-state-error-primary,#e5484d)}',
      '[data-dsh-vs] .dsh-vs-loading{padding:16px 0;color:var(--dsw-alias-label-tertiary,#8a919e)}',
      '@media(max-width:720px){[data-dsh-vs] .dsh-vs-grid{grid-template-columns:1fr}[data-dsh-vs] .dsh-vs-span-2{grid-column:auto}}',
    ].join('');

    function useInjectedStyle() {
      useEffect(() => {
        if (typeof document === 'undefined' || document.getElementById('dsh-vs-watch-style')) return;
        const style = document.createElement('style');
        style.id = 'dsh-vs-watch-style';
        style.textContent = CSS;
        document.head.appendChild(style);
      }, []);
    }

    function apiConfig() {
      const injected = globalThis.__DSH_WATCH_TOGETHER_SETTINGS__;
      if (!injected || typeof injected.url !== 'string') return null;
      const url = new URL(injected.url);
      const token = url.searchParams.get('token') || '';
      const base = url.pathname.replace(/\/+$/, '') + '/api';
      return { token: token, base: base };
    }

    async function apiCall(api, action, body) {
      const res = await fetch(api.base + action, {
        method: body === undefined ? 'GET' : 'POST',
        cache: 'no-store',
        headers: body === undefined
          ? { 'x-settings-token': api.token }
          : { 'x-settings-token': api.token, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
      return data;
    }

    function formFromState(state) {
      const video = state && state.video ? state.video : {};
      const watch = state && state.watch ? state.watch : {};
      const voice = state && state.voice ? state.voice : {};
      return {
        browserPort: video.browserPort ? String(video.browserPort) : '',
        chatPort: watch.chatPort ? String(watch.chatPort) : '9377',
        adapter: typeof voice.adapter === 'string' ? voice.adapter : '',
      };
    }

    function TextField(props) {
      return h('div', { className: 'dsh-vs-field' + (props.wide ? ' dsh-vs-span-2' : '') },
        h('span', { className: 'dsh-vs-label' }, props.label),
        h('input', {
          className: 'dsh-vs-input',
          type: props.type || 'text',
          value: props.value,
          placeholder: props.placeholder || '',
          autoComplete: 'off',
          spellCheck: false,
          onChange: event => props.onChange(event.target.value),
        }),
        props.hint ? h('span', { className: 'dsh-vs-hint' }, props.hint) : null,
      );
    }

    function depDetail(check) {
      if (check.ok && (check.id === 'core' || check.id === 'extension' || check.id === 'floating')) return '已安装';
      return check.detail || '';
    }

    function depAction(check) {
      if (check.ok || !check.downloadUrl || !/^https:\/\//.test(check.downloadUrl)) return null;
      const label = check.downloadLabel || '查看';
      return h('a', {
        className: 'dsh-vs-btn dsh-vs-btn-sm',
        href: check.downloadUrl,
        target: '_blank',
        rel: 'noopener noreferrer',
      }, /下载/.test(label) ? '下载' : /获取/.test(label) ? '获取' : '查看');
    }

    function SettingsTab() {
      useInjectedStyle();
      const [form, setForm] = useState(null);
      const [checks, setChecks] = useState([]);
      const [busy, setBusy] = useState(false);
      const [checking, setChecking] = useState(false);
      const [error, setError] = useState('');
      const [notice, setNotice] = useState('');

      async function runCheck(api) {
        const target = api || apiConfig();
        if (!target) {
          setError('设置接口未注入，请重启 DSH。');
          return;
        }
        setChecking(true);
        setError('');
        try {
          const data = await apiCall(target, '/check', {});
          setChecks(Array.isArray(data.checks) ? data.checks : []);
          setNotice('环境检查完成。');
        } catch (e) {
          setError(String(e && e.message ? e.message : e));
        } finally {
          setChecking(false);
        }
      }

      useEffect(() => {
        let cancelled = false;
        const api = apiConfig();
        if (!api) {
          setError('设置接口未注入，请重启 DSH。');
          return undefined;
        }
        setBusy(true);
        apiCall(api, '/state').then(state => {
          if (cancelled) return;
          setForm(formFromState(state));
          setBusy(false);
          void runCheck(api);
        }).catch(e => {
          if (cancelled) return;
          setError(String(e && e.message ? e.message : e));
          setBusy(false);
        });
        return () => { cancelled = true; };
      }, []);

      async function save() {
        if (!form) return;
        const api = apiConfig();
        if (!api) {
          setError('设置接口未注入，请重启 DSH。');
          return;
        }
        setBusy(true);
        setError('');
        setNotice('');
        try {
          const video = {
            browserPort: form.browserPort === '' ? false : Number(form.browserPort),
          };
          const watch = { chatPort: Number(form.chatPort) };
          const voice = { adapter: form.adapter };
          await apiCall(api, '/save', { video: video, watch: watch, voice: voice });
          setNotice('已保存。聊天端口改动在下次启动 DSH 后生效。');
        } catch (e) {
          setError(String(e && e.message ? e.message : e));
        } finally {
          setBusy(false);
        }
      }

      if (!form) {
        return h('div', { 'data-dsh-vs': 'watch', className: 'dsh-vs dsh-vs-loading' }, error || '正在加载设置…');
      }

      const visibleChecks = checks.filter(item => item.id !== 'browser' && item.id !== 'chat' && item.id !== 'voice');
      const optionalIds = { python: true, extension: true, floating: true };

      return h('div', { 'data-dsh-vs': 'watch', className: 'dsh-vs' },
        h('section', { className: 'dsh-vs-section' },
          h('div', { className: 'dsh-vs-section-head' },
            h('h3', { className: 'dsh-vs-section-title' }, '位置与聊天'),
          ),
          h('div', { className: 'dsh-vs-grid' },
            h(TextField, {
              label: '浏览器调试端口',
              value: form.browserPort,
              type: 'number',
              placeholder: '9333',
              hint: 'Edge 带 --remote-debugging-port 启动后，才能读取实时播放位置。',
              onChange: value => setForm(prev => ({ ...prev, browserPort: value })),
            }),
            h(TextField, {
              label: '聊天服务端口',
              value: form.chatPort,
              type: 'number',
              placeholder: '9377',
              hint: '聊天服务启动时读取；已在运行需重启 DSH。',
              onChange: value => setForm(prev => ({ ...prev, chatPort: value })),
            }),
          ),
        ),
        h('section', { className: 'dsh-vs-section' },
          h('div', { className: 'dsh-vs-section-head' },
            h('h3', { className: 'dsh-vs-section-title' }, '声音'),
          ),
          h('div', { className: 'dsh-vs-grid' },
            h(TextField, {
              label: '语音适配器',
              value: form.adapter,
              wide: true,
              placeholder: 'C:\\path\\to\\voice.mjs 或包名',
              hint: '留空则台词只写入聊天记录；下一次陪看开始时挂载。',
              onChange: value => setForm(prev => ({ ...prev, adapter: value })),
            }),
          ),
        ),
        h('section', { className: 'dsh-vs-section' },
          h('div', { className: 'dsh-vs-section-head' },
            h('h3', { className: 'dsh-vs-section-title' }, '依赖'),
            h('button', {
              type: 'button',
              className: 'dsh-vs-textbtn',
              disabled: checking,
              onClick: () => { setNotice(''); void runCheck(); },
            }, checking ? '检查中…' : '重新检查'),
          ),
          h('p', { className: 'dsh-vs-hint', style: { margin: '0 0 6px' } },
            '缺少时显示官方下载按钮；插件不会自动安装或执行下载的文件。'),
          visibleChecks.length
            ? h('div', { className: 'dsh-vs-deps' }, visibleChecks.map(check =>
                h('div', { className: 'dsh-vs-dep', key: check.id },
                  h('span', {
                    className: 'dsh-vs-dot'
                      + (check.ok ? '' : optionalIds[check.id] ? ' is-warn' : ' is-bad'),
                  }),
                  h('div', { className: 'dsh-vs-dep-main' },
                    h('div', { className: 'dsh-vs-dep-name' }, check.label || check.id),
                    h('div', { className: 'dsh-vs-dep-detail', title: check.detail || '' }, depDetail(check)),
                  ),
                  depAction(check),
                )))
            : h('p', { className: 'dsh-vs-hint' }, checking ? '正在检查…' : '尚未检查。'),
        ),
        h('div', { className: 'dsh-vs-footer' },
          h('button', {
            type: 'button',
            className: 'dsh-vs-btn dsh-vs-btn-primary',
            disabled: busy,
            onClick: save,
          }, busy ? '保存中…' : '保存'),
          h('span', { className: 'dsh-vs-status' + (error ? ' is-error' : ''), role: 'status' },
            error || notice),
        ),
      );
    }

    function BundleConfig(props) {
      return props && props.view === 'page' ? h(SettingsTab) : null;
    }

    function apply(ctx) {
      ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
        name: 'settings.plugins.tab',
        id: 'watch-together',
        order: 20,
        label: () => '一起看',
      }, SettingsTab));
      ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: 'dsh-watch-together',
      }, BundleConfig));
    }

    exports.apply = apply;
    exports.inject = ['slots'];
    return module.exports;
  },
});
