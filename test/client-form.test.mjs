/**
 * 组合包页表单的**点击行为**回归（用户可见行为）。
 *
 * 2026-11-21 用户报「有时候点了试听没反应」：跑着的试听把按钮 `disabled` + 代码里
 * `if (testing) return` —— 第二次点击是**静默空转**，越等越像坏了。这里守的行为：
 *   1. 点击永远有即时反馈；跑着再点 = 掐断旧的、重新开始（新顶旧，和陪看发声同一原则）；
 *   2. 试听结果行写明实际出声的引擎和首声耗时（延迟问题就看它）；
 *   3. 声音滑块改动自动保存，负载带完整 tts 参数。
 *
 * 用 test/helpers/client-harness.mjs 在 Node 里真实挂载 lib/client.js（伪 DOM 记录树、
 * fetch 打桩带 AbortSignal），组件代码一行不改、真实执行。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { click, findAll, input, mountClient, seededState, settle, textOf } from './helpers/client-harness.mjs';

function stubFetch({ onTest }) {
  return (url, opts = {}) => {
    const path = String(url);
    if (path.endsWith('/state')) return Promise.resolve({ ok: true, json: async () => seededState() });
    if (path.endsWith('/check')) return Promise.resolve({ ok: true, json: async () => ({ checks: [] }) });
    if (path.endsWith('/tts-test')) return onTest(opts);
    return Promise.resolve({ ok: true, json: async () => seededState() });
  };
}

const hangUntilAborted = (calls) => (opts) => {
  const call = { aborted: false };
  calls.push(call);
  return new Promise((resolve, reject) => {
    if (opts.signal) {
      opts.signal.addEventListener('abort', () => {
        call.aborted = true;
        reject(new Error('aborted'));
      });
    }
    // 3 秒才回执：足够模拟「起了合成器还没出声」的窗口
    setTimeout(() => resolve({
      ok: true,
      json: async () => ({
        ok: true, engine: 'sapi',
        ms: 5, firstMs: 5, text: '嗯。',
      }),
    }), 3000);
  });
};

test('点试听永远有动静：跑着再点 = 掐断重来，不是静默没反应', async () => {
  const calls = [];
  const harness = mountClient({ fetch: stubFetch({ onTest: hangUntilAborted(calls) }) });
  try {
    await settle(30); // 等 /state 载入
    const button = () => findAll(harness.root, (n) => n.type === 'button' && /^试听/.test(textOf(n)))[0];
    const status = () => textOf(findAll(harness.root,
      (n) => n.type === 'span' && /试听中|已试听|试听失败/.test(textOf(n)))[0] || {});

    assert.ok(button(), '声音区要有试听按钮');
    assert.equal(click(button()), true, '第一次点击要启动试听');
    await settle(0);
    assert.match(status(), /试听中/, '点击后必须立刻有反馈');

    // 用户等不及又点了一下 —— 这一下必须掐断旧的、重新开始
    assert.equal(click(button()), true, '跑着的时候按钮不许禁用、不许吞点击');
    await settle(0);
    assert.equal(calls.length, 2, '第二次点击必须顶掉重来（现状：静默没反应）');
    assert.equal(calls[0].aborted, true, '旧的那次要被 AbortSignal 掐断');
    assert.match(status(), /试听中/, '重试也要立刻有反馈');
  } finally {
    harness.restore();
  }
});

test('试听结果行要写明实际出声的引擎和首声耗时', async () => {
  const harness = mountClient({
    fetch: stubFetch({
      onTest: (opts) => Promise.resolve({
        ok: true,
        json: async () => ({
          ok: true, engine: 'edge-stream',
          ms: 900, firstMs: 420, text: '这是一句试听文本',
        }),
      }),
    }),
  });
  try {
    await settle(30);
    const button = () => findAll(harness.root, (n) => n.type === 'button' && /^试听/.test(textOf(n)))[0];
    click(button());
    await settle(20);
    const status = () => textOf(findAll(harness.root,
      (n) => n.type === 'span' && /已试听/.test(textOf(n)))[0] || {});
    assert.match(status(), /微软神经音（常驻通道）/, '结果行要写明实际出声的引擎');
    assert.match(status(), /420|首声/, '结果行要报首声耗时（延迟问题就看它）');
  } finally {
    harness.restore();
  }
});

test('声音滑块改动自动保存，负载带完整 tts 参数', async () => {
  const saves = [];
  const harness = mountClient({
    fetch: (url, opts = {}) => {
      const path = String(url);
      if (path.endsWith('/save')) {
        saves.push(JSON.parse(opts.body));
        return Promise.resolve({ ok: true, json: async () => seededState() });
      }
      return Promise.resolve({ ok: true, json: async () => seededState() });
    },
  });
  try {
    await settle(30);
    const volume = () => findAll(harness.root,
      (n) => n.type === 'input' && n.props && n.props.type === 'range' && n.props.max === 100)[0];
    assert.ok(volume(), '声音区要有「朗读音量」滑块（0-100）');
    input(volume(), '60');
    await settle(700);   // 自动保存 550ms 防抖
    assert.ok(saves.length >= 1, '改动要自动保存');
    const tts = saves.at(-1).tts;
    assert.equal(tts.volume, 60, '保存负载要带音量');
    assert.equal(typeof tts.voice, 'string', '保存负载要带音色');
    assert.equal(typeof tts.rate, 'number', '保存负载要带语速');
  } finally {
    harness.restore();
  }
});
