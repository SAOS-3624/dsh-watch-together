/**
 * test/helpers/client-harness.mjs — 在 Node 里**真实挂载** `lib/client.js` 的迷你壳。
 *
 * 为什么需要：组合包页表单只在 DSH 宿主里渲染，但「用户点按钮」的行为必须有人守
 * （2026-11-21 用户报「点了试听没反应」正是这种行为 bug，源码级断言守不住）。
 * 这里只做三件事：①伪 DOM 记录渲染树；②hooks 运行时（useState/useEffect/useRef）；
 * ③fetch 打桩（带 AbortSignal）。组件代码本身一行不改、真实执行。
 */

import vm from 'node:vm';
import { readFileSync } from 'node:fs';

/* ---------------------------------------------- 伪 DOM（只记录，不渲染） */

function el(type, props) {
  return { nodeType: 'element', type, props: props || {}, children: [] };
}

function text(value) {
  return { nodeType: 'text', value: String(value) };
}

export function findAll(node, pred, out = []) {
  if (!node) return out;
  if (node.nodeType === 'element') {
    if (pred(node)) out.push(node);
    for (const child of node.children) findAll(child, pred, out);
  }
  return out;
}

export function textOf(node) {
  if (!node) return '';
  if (node.nodeType === 'text') return node.value;
  return (node.children || []).map(textOf).join('');
}

/** 模拟浏览器点击：**disabled 的按钮点了就是没反应**（这正是被守的行为之一）。 */
export function click(node) {
  if (!node || node.nodeType !== 'element') return false;
  if (node.props.disabled) return false;
  const handler = node.props.onClick;
  if (typeof handler !== 'function') return false;
  handler({ target: node });
  return true;
}

/** 模拟输入：走 onChange（client.js 的 TextField 包了一层 event.target.value）。 */
export function input(node, value) {
  if (!node || typeof node.props.onChange !== 'function') return false;
  node.props.onChange({ target: { value } });
  return true;
}

/* ---------------------------------------------- 迷你 React（hooks + 重渲染） */

function createMiniReact() {
  let hookStates = [];
  let hookIndex = 0;
  let pendingEffects = [];
  let dirty = false;
  let rootFn = null;
  let container = null;

  function scheduleRender() {
    if (dirty) return;
    dirty = true;
    Promise.resolve().then(() => { dirty = false; render(); });
  }

  function build(node) {
    if (node === null || node === undefined || node === false) return null;
    if (typeof node === 'string' || typeof node === 'number') return text(node);
    if (typeof node.type === 'function') return build(node.type(node.props));
    const record = el(node.type, node.props);
    for (const child of node.props.children || []) {
      const built = build(child);
      if (built) record.children.push(built);
    }
    return record;
  }

  function render() {
    pendingEffects = [];
    hookIndex = 0;
    const vdom = rootFn();
    container.children = [];
    const built = build(vdom);
    if (built) container.children.push(built);
    const effects = pendingEffects;
    pendingEffects = [];
    for (const effect of effects) {
      if (typeof effect.slot.cleanup === 'function') {
        try { effect.slot.cleanup(); } catch { /* 与 React 对齐：清理失败不影响 */ }
      }
      const ret = effect.fn();
      effect.slot.cleanup = typeof ret === 'function' ? ret : null;
    }
  }

  const React = {
    createElement(type, props, ...children) {
      const flat = [];
      const addAll = (list) => {
        for (const child of list) {
          if (Array.isArray(child)) addAll(child);
          else if (child !== null && child !== undefined && child !== false) flat.push(child);
        }
      };
      addAll(children);
      return { type, props: { ...(props || {}), children: flat } };
    },
    useState(init) {
      const i = hookIndex++;
      if (!(i in hookStates)) hookStates[i] = { v: typeof init === 'function' ? init() : init };
      const slot = hookStates[i];
      return [slot.v, (next) => {
        const value = typeof next === 'function' ? next(slot.v) : next;
        if (value === slot.v) return;
        slot.v = value;
        scheduleRender();
      }];
    },
    useRef(init) {
      const i = hookIndex++;
      if (!(i in hookStates)) hookStates[i] = { current: init };
      return hookStates[i];
    },
    useEffect(fn, deps) {
      const i = hookIndex++;
      const prev = hookStates[i];
      const changed = !prev || !prev.deps || !deps
        || deps.length !== prev.deps.length
        || deps.some((d, j) => d !== prev.deps[j]);
      hookStates[i] = { deps, cleanup: prev && prev.cleanup };
      if (changed) pendingEffects.push({ fn, slot: hookStates[i] });
    },
    __mount(fn, target) {
      rootFn = fn;
      container = target;
      render();
    },
  };
  return React;
}

/* ---------------------------------------------- 挂载 client.js */

/**
 * @param {{ fetch: Function, settingsUrl?: string }} o
 *   `fetch(url, opts)` 打桩；opts 里带 AbortSignal（掐断要用）。
 * @returns {{ root: object, React: object, restore: () => void }}
 */
export function mountClient({ fetch: fetchStub, settingsUrl = 'http://127.0.0.1:1/dsh-watch-together/settings?token=t' }) {
  let handoff = null;
  const previous = {
    window: global.window,
    fetch: global.fetch,
    settings: global.__DSH_WATCH_TOGETHER_SETTINGS__,
  };
  global.window = { __ModuleLoader__: { load: (mod) => { handoff = mod; } } };
  global.fetch = fetchStub;
  global.__DSH_WATCH_TOGETHER_SETTINGS__ = { url: settingsUrl };

  const source = readFileSync(new URL('../../lib/client.js', import.meta.url), 'utf8');
  vm.runInThisContext(source, { filename: 'lib/client.js' });

  const React = createMiniReact();
  const mod = handoff.factory((name) => {
    if (name === 'react') return React;
    throw new Error('harness 没有这个模块：' + name);
  });
  let component = null;
  mod.apply({
    slots: {
      inject: (_name, callback) => callback(),
      register: (_options, comp) => { component = comp; },
    },
  });

  const root = el('root', {});
  React.__mount(() => component({ view: 'page' }), root);
  return {
    root,
    React,
    restore() {
      global.window = previous.window;
      global.fetch = previous.fetch;
      global.__DSH_WATCH_TOGETHER_SETTINGS__ = previous.settings;
    },
  };
}

/** 等微任务/定时器把 useEffect 里的 fetch 链走完。 */
export function settle(ms = 10) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 现成的 /state 响应（够 formFromState 用即可）。 */
export function seededState(overrides = {}) {
  return {
    video: { browserPort: false },
    watch: { chatPort: 9377 },
    voice: { adapter: '', envOverrides: [] },
    tts: {
      engine: 'edge', voice: 'zh-CN-XiaoxiaoNeural', rate: 0, pitch: '+0', volume: 100,
      replace: [],
    },
    window: { style: 'auto' },
    paths: {},
    ui: { adapterPlaceholder: '示例.mjs 或包名；留空关闭', adapterHint: '示例提示。' },
    ...overrides,
  };
}
