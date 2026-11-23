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
      '[data-dsh-vs] .dsh-vs-select{width:100%;height:34px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:inherit;outline:none}',
      '[data-dsh-vs] .dsh-vs-select:focus{border-color:var(--dsw-alias-brand-primary,#4f7cff);box-shadow:0 0 0 3px rgba(79,124,255,.14)}',
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

    async function apiCall(api, action, body, signal) {
      const res = await fetch(api.base + action, {
        method: body === undefined ? 'GET' : 'POST',
        cache: 'no-store',
        signal: signal || undefined,
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
      const tts = state && state.tts ? state.tts : {};
      const win = state && state.window ? state.window : {};
      return {
        browserPort: video.browserPort ? String(video.browserPort) : '',
        chatPort: watch.chatPort ? String(watch.chatPort) : '9377',
        adapter: typeof voice.adapter === 'string' ? voice.adapter : '',
        windowStyle: typeof win.style === 'string' ? win.style : 'auto',
        voiceEnvOverrides: Array.isArray(voice.envOverrides) ? voice.envOverrides : [],
        ttsTestText: '',
        ttsEngine: typeof tts.engine === 'string' ? tts.engine : '',
        ttsVoice: typeof tts.voice === 'string' && tts.voice ? tts.voice : 'zh-CN-XiaoxiaoNeural',
        ttsRate: String(tts.rate === undefined ? 0 : tts.rate),
        ttsPitch: String(tts.pitch === undefined || tts.pitch === '' ? 0 : tts.pitch).replace(/[^\d+-]/g, ''),
        ttsVolume: String(tts.volume === undefined ? 100 : tts.volume),
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
          min: props.min,
          max: props.max,
          step: props.step,
          onChange: event => props.onChange(event.target.value),
        }),
        props.hint ? h('span', { className: 'dsh-vs-hint' }, props.hint) : null,
      );
    }

    function SelectField(props) {
      return h('div', { className: 'dsh-vs-field' + (props.wide ? ' dsh-vs-span-2' : '') },
        h('span', { className: 'dsh-vs-label' }, props.label),
        h('select', {
          className: 'dsh-vs-select',
          value: props.value,
          onChange: event => props.onChange(event.target.value),
        }, (props.options || []).map(option =>
          h('option', { key: option.value, value: option.value }, option.label))),
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
      const [checking, setChecking] = useState(false);
      const [testing, setTesting] = useState(false);
      const [testStatus, setTestStatus] = useState('');
      const [error, setError] = useState('');
      const [notice, setNotice] = useState('');
      const formRef = React.useRef(null);
      const firstRender = React.useRef(true);
      const saving = React.useRef(false);
      const pending = React.useRef(false);
      const testAbort = React.useRef(null);   // 在飞试听的 AbortController（新顶旧）
      const testSeq = React.useRef(0);        // 试听代际：旧回执不许覆盖新状态
      formRef.current = form;

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
        apiCall(api, '/state').then(state => {
          if (cancelled) return;
          setForm(formFromState(state));
          void runCheck(api);
        }).catch(e => {
          if (cancelled) return;
          setError(String(e && e.message ? e.message : e));
        });
        return () => { cancelled = true; };
      }, []);

      function validationError(current) {
        const browserPort = current.browserPort === '' ? false : Number(current.browserPort);
        if (browserPort !== false
          && (!Number.isInteger(browserPort) || browserPort < 1 || browserPort > 65535)) {
          return '浏览器调试端口必须是 1-65535 的整数。';
        }
        const chatPort = Number(current.chatPort);
        if (!Number.isInteger(chatPort) || chatPort < 1 || chatPort > 65535) {
          return '聊天服务端口必须是 1-65535 的整数。';
        }
        return '';
      }

      // 保存和试听共用同一份“面板当前 tts 值”的换算
      function ttsPayloadOf(current) {
        const pitch = String(current.ttsPitch || '').trim();
        return {
          engine: current.ttsEngine,
          voice: current.ttsVoice,
          rate: Number(current.ttsRate) || 0,
          pitch: pitch && Number(pitch) !== 0 ? (Number(pitch) > 0 ? '+' + Number(pitch) : pitch) : '',
          volume: Number(current.ttsVolume),
        };
      }

      function ttsResultText(r) {
        const engine = {
          'edge-stream': '微软神经音（常驻通道）', 'edge-tts': '微软神经音（逐句兜底）', sapi: '本地系统嗓（SAPI）',
        }[r.engine] || r.engine;
        return '已试听：' + engine + '（首声 ' + (r.firstMs ?? r.ms ?? '?') + 'ms）。';
      }

      async function ttsTest() {
        const current = formRef.current;
        if (!current) return;
        const api = apiConfig();
        if (!api) {
          setError('设置接口未注入，请重启 DSH。');
          return;
        }
        // **新顶旧**（和陪看发声同一原则）：上一次还在跑就掐掉重来。
        // 按钮永不吞点击 —— 跑着的时候静默空转，用户看到的就是「点了没反应」。
        if (testAbort.current) {
          try { testAbort.current.abort(); } catch { /* 已经结束 */ }
        }
        const controller = new AbortController();
        testAbort.current = controller;
        testSeq.current += 1;
        const seq = testSeq.current;
        setTesting(true);
        setTestStatus('试听中…（合成器常驻时约半秒出声；再点一次可重试）');
        try {
          const r = await apiCall(api, '/tts-test',
            { text: current.ttsTestText, tts: ttsPayloadOf(current) }, controller.signal);
          if (seq !== testSeq.current) return;   // 已被更新的一次顶掉，回执作废
          setTestStatus(r.ok ? ttsResultText(r) : '试听失败：' + (r.reason || '未知原因'));
        } catch (e) {
          if (seq !== testSeq.current) return;
          setTestStatus('试听失败：' + String(e && e.message ? e.message : e));
        } finally {
          if (seq === testSeq.current) {
            setTesting(false);
            testAbort.current = null;
          }
        }
      }

      async function save() {
        const current = formRef.current;
        if (!current) return;
        if (saving.current) {
          pending.current = true;
          return;
        }
        const api = apiConfig();
        if (!api) {
          setError('设置接口未注入，请重启 DSH。');
          return;
        }
        const invalid = validationError(current);
        if (invalid) {
          setError(invalid);
          setNotice('');
          return;
        }
        saving.current = true;
        setError('');
        setNotice('');
        try {
          const video = {
            browserPort: current.browserPort === '' ? false : Number(current.browserPort),
          };
          const watch = { chatPort: Number(current.chatPort) };
          const voice = { adapter: current.adapter };
          const win = { style: current.windowStyle };
          const tts = ttsPayloadOf(current);
          await apiCall(api, '/save', { video: video, watch: watch, voice: voice, window: win, tts: tts });
          setNotice('已自动保存。悬浮窗样式立刻生效；声音参数下一场陪看生效；聊天端口改动在下次启动 DSH 后生效。');
        } catch (e) {
          setError(String(e && e.message ? e.message : e));
        } finally {
          saving.current = false;
          if (pending.current) {
            pending.current = false;
            setTimeout(() => { void save(); }, 0);
          }
        }
      }

      useEffect(() => {
        if (!form) return undefined;
        if (firstRender.current) {
          firstRender.current = false;
          return undefined;
        }
        const timer = setTimeout(() => { void save(); }, 550);
        return () => clearTimeout(timer);
      }, [form && form.browserPort, form && form.chatPort, form && form.adapter, form && form.windowStyle,
        form && form.ttsEngine, form && form.ttsVoice, form && form.ttsRate, form && form.ttsPitch,
        form && form.ttsVolume]);

      if (!form) {
        return h('div', { 'data-dsh-vs': 'watch', className: 'dsh-vs dsh-vs-loading' }, error || '正在加载设置…');
      }

      const visibleChecks = checks.filter(item => item.id !== 'browser' && item.id !== 'chat' && item.id !== 'voice');
      const connectionChecks = checks.filter(item => item.id === 'browser' || item.id === 'chat' || item.id === 'voice');
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
            h(SelectField, {
              label: '引擎',
              value: form.ttsEngine,
              options: [
                { value: '', label: '自动 —— 默认本地 SAPI；配了 edgeTts 路径/环境变量才走云端' },
                { value: 'sapi', label: '本地 SAPI —— 文本不出机器（系统嗓）' },
                { value: 'edge', label: '微软 Edge —— 神经音色（文本会发给微软）' },
              ],
              hint: '选 Edge = 要念的文本离开这台机器；不介意再选。',
              onChange: value => setForm(prev => ({ ...prev, ttsEngine: value })),
            }),
            h(SelectField, {
              label: '人声选择',
              value: form.ttsVoice,
              options: [
                { value: 'zh-CN-XiaoxiaoNeural', label: '中文-普通-女声 晓晓' },
                { value: 'zh-CN-XiaoxuanNeural', label: '中文-普通-女声 晓萱' },
                { value: 'zh-CN-XiaoyiNeural', label: '中文-普通-女声 晓伊' },
                { value: 'zh-CN-YunxiNeural', label: '中文-普通-男声 云希' },
                { value: 'zh-CN-YunjianNeural', label: '中文-普通-男声 云健' },
                { value: 'zh-CN-YunyangNeural', label: '中文-多风格-男声 云扬' },
                { value: 'zh-CN-YunxiaNeural', label: '中文-普通-男声 云夏' },
                { value: 'zh-CN-YunzeNeural', label: '中文-普通-男声 云泽' },
                { value: 'zh-CN-liaoning-XiaobeiNeural', label: '中文-辽宁-女声 晓北' },
                { value: 'zh-CN-shaanxi-XiaoniNeural', label: '中文-陕西-女声 晓妮' },
              ],
              hint: 'Edge 引擎的神经音色；本地 SAPI 只有系统嗓，选了不生效。',
              onChange: value => setForm(prev => ({ ...prev, ttsVoice: value })),
            }),
            h(TextField, {
              label: '朗读速度',
              value: form.ttsRate,
              type: 'range',
              min: -10,
              max: 10,
              step: 0.5,
              hint: '当前 ' + form.ttsRate + ' 档（约 ' + Math.round(Number(form.ttsRate) * 3) + '%）；-10 ~ +10。',
              onChange: value => setForm(prev => ({ ...prev, ttsRate: value })),
            }),
            h(TextField, {
              label: '朗读声调',
              value: form.ttsPitch,
              type: 'range',
              min: -20,
              max: 20,
              step: 1,
              hint: '当前 ' + (Number(form.ttsPitch) > 0 ? '+' : '') + form.ttsPitch + 'Hz；负数更低沉、正数更清亮。',
              onChange: value => setForm(prev => ({ ...prev, ttsPitch: value })),
            }),
            h(TextField, {
              label: '朗读音量',
              value: form.ttsVolume,
              type: 'range',
              min: 0,
              max: 100,
              step: 5,
              hint: '当前 ' + form.ttsVolume + '；100 = 不增不减。',
              onChange: value => setForm(prev => ({ ...prev, ttsVolume: value })),
            }),
            h(TextField, {
              label: '试听文本',
              value: form.ttsTestText,
              placeholder: '这是一句试听文本，听起来怎么样？',
              hint: '按面板当前参数念一句；试听不保存设置。',
              onChange: value => setForm(prev => ({ ...prev, ttsTestText: value })),
            }),
            h('div', { className: 'dsh-vs-field' },
              h('span', { className: 'dsh-vs-label' }, '试听'),
              h('button', {
                className: 'dsh-vs-btn dsh-vs-btn-primary',
                onClick: () => { void ttsTest(); },
              }, testing ? '试听中…（点击重试）' : '试听'),
              h('span', { className: 'dsh-vs-hint' }, testStatus || '点一下出声；结果会写明实际用的引擎。'),
            ),
          ),
          form.voiceEnvOverrides.length
            ? h('p', { className: 'dsh-vs-effective' },
                '环境变量优先：' + form.voiceEnvOverrides.join('、') + '；这里的改动不会覆盖它们。')
            : null,
        ),
        h('section', { className: 'dsh-vs-section' },
          h('div', { className: 'dsh-vs-section-head' },
            h('h3', { className: 'dsh-vs-section-title' }, '悬浮窗样式'),
          ),
          h('div', { className: 'dsh-vs-grid' },
            h(SelectField, {
              label: '外观预设',
              value: form.windowStyle,
              wide: true,
              options: [
                { value: 'auto', label: '自动 —— 远程/录屏用纯色，其余实时玻璃' },
                { value: 'live', label: '实时玻璃 —— 跟着桌面模糊（好看，吃 CPU）' },
                { value: 'frost', label: '静态磨砂 —— 不吃性能（低配机选这个）' },
                { value: 'solid', label: '纯色 —— 最省，背后不透' },
              ],
              hint: '改完立刻生效，不用重开窗口。实时玻璃每帧都要抓屏再模糊 —— 卡就换成静态磨砂：不抓屏、只画一张预生成的底板。',
              onChange: value => setForm(prev => ({ ...prev, windowStyle: value })),
            }),
          ),
        ),
        h('section', { className: 'dsh-vs-section' },
          h('div', { className: 'dsh-vs-section-head' },
            h('h3', { className: 'dsh-vs-section-title' }, '连接状态'),
          ),
          connectionChecks.length
            ? h('div', { className: 'dsh-vs-deps' }, connectionChecks.map(check =>
                h('div', { className: 'dsh-vs-dep', key: check.id },
                  h('span', {
                    className: 'dsh-vs-dot'
                      + (check.ok ? '' : optionalIds[check.id] ? ' is-warn' : ' is-bad'),
                  }),
                  h('div', { className: 'dsh-vs-dep-main' },
                    h('div', { className: 'dsh-vs-dep-name' }, check.label || check.id),
                    h('div', { className: 'dsh-vs-dep-detail', title: check.detail || '' }, check.detail || ''),
                  ),
                )))
            : h('p', { className: 'dsh-vs-hint' }, checking ? '正在检查…' : '尚未检查。'),
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
          h('span', { className: 'dsh-vs-status' + (error ? ' is-error' : ''), role: 'status' },
            error || notice),
        ),
      );
    }

    function BundleConfig(props) {
      return props && props.view === 'page' ? h(SettingsTab) : null;
    }

    function apply(ctx) {
      ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: 'dsh-watch-together',
      }, BundleConfig));

      /**
       * **设置里单独一栏**（和 see-now / storyboard 同一种接法）。
       *
       * 只有 `plugins.bundle.config` 时，入口藏在"插件 → 组合包配置"里 —— 用户按名字翻不到，
       * 社区反馈就是"我是不是没装这个插件"（storyboard 那边已经踩过一模一样的坑）。
       *
       * 数据源不变：`src/settings/server.js` 通过 `webserver/index-inject` 把带 token 的 URL
       * 注成全局 `__DSH_WATCH_TOGETHER_SETTINGS__`，所以这一栏里 `apiConfig()` 照样能读写。
       * `order` 排在 see-now(43)、视频分镜(44) 前面，三个"看"的设置挨在一起。
       */
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'watch-together',
        order: 42,
        label: () => '一起看视频',
      }, () => h(SettingsTab)));
    }

    exports.apply = apply;
    exports.inject = ['slots'];
    return module.exports;
  },
});
