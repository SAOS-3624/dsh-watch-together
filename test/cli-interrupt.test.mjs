/**
 * cli-interrupt.test.mjs — 插话链路里**丢消息**这一类 bug 的回归网。
 *
 * 这里测的是 `bin/watch.mjs` 导出的那两个 watcher（CLI 走的是这条路，
 * 插件走的是 src/chat-store.js 那个，见 chat.test.mjs / interrupt.test.mjs）。
 * 三件事历史上都真的漏过用户的话，而且漏得无声无息：
 *
 *   ① 一批里有多条用户消息 → 只报第一条，其余永久消失
 *   ② 每个 cue 都是**新进程**，基线取"当前条数" → 两次 cue 之间说的话没人看见
 *   ③ 宿主把**老消息事后补写**进会话文件 → 被当成新插话，打断自己
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cueBusy, makeChatWatcher, makeInterruptWatcher } from '../bin/watch.mjs';

function tempDir(tag) {
  return mkdtempSync(join(tmpdir(), `cli-${tag}-`));
}

/** 按统一文本流的格式追加若干条（role 默认 user） */
function appendRows(file, rows) {
  for (const r of rows) {
    appendFileSync(file, `${JSON.stringify({ role: 'user', at: Date.now(), ...r })}\n`, 'utf8');
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------- 自己的聊天框（带游标） */

test('聊天框：一批两条用户消息，分两次报出来（不能吞掉第二条）', async () => {
  const dir = tempDir('batch');
  try {
    const file = join(dir, 'chat.jsonl');
    const cursorFile = join(dir, 'cursor.json');
    const poll = makeChatWatcher({ file, cursorFile });

    appendRows(file, [{ text: '第一句' }, { text: '第二句' }]);
    assert.equal(poll()?.text, '第一句');
    assert.equal(poll()?.text, '第二句', '同批的第二条不该丢 —— 模型回完话再来取剩下的');
    assert.equal(poll(), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('聊天框：非用户消息（台词/插话）不报，也不该堵住后面的用户消息', async () => {
  const dir = tempDir('noise');
  try {
    const file = join(dir, 'chat.jsonl');
    const cursorFile = join(dir, 'cursor.json');
    const poll = makeChatWatcher({ file, cursorFile });

    appendRows(file, [{ role: 'line', text: '剧本台词' }, { role: 'assistant', text: '模型插话' }]);
    assert.equal(poll(), null, '台词和插话都不是用户的话');
    appendRows(file, [{ text: '这才是我说的' }]);
    assert.equal(poll()?.text, '这才是我说的');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('聊天框：换进程后从游标接着读 —— 两次 cue 之间说的话不丢（本条是主 bug）', async () => {
  const dir = tempDir('cursor');
  try {
    const file = join(dir, 'chat.jsonl');
    const cursorFile = join(dir, 'cursor.json');
    // 第一个 cue 进程：读到第 2 条
    appendRows(file, [{ text: '旧的' }, { text: '旧的2' }]);
    const first = makeChatWatcher({ file, cursorFile });
    first();                      // 消费掉非用户消息之外的东西（这里都是 user）
    // "模型在思考/建图"这段时间用户说话了 —— 此时没有任何 cue 进程在跑
    appendRows(file, [{ text: '空窗期说的第一句' }, { text: '空窗期说的第二句' }]);
    // 第二个 cue 进程：基线必须落在**游标**上，不是"现在的条数"
    const second = makeChatWatcher({ file, cursorFile });
    assert.equal(second()?.text, '空窗期说的第一句', '跨进程的空窗期消息必须收得到');
    assert.equal(second()?.text, '空窗期说的第二句');
    assert.equal(second(), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('聊天框：已交付的消息不会被下一个进程再报一遍', async () => {
  const dir = tempDir('no-repeat');
  try {
    const file = join(dir, 'chat.jsonl');
    const cursorFile = join(dir, 'cursor.json');
    const poll = makeChatWatcher({ file, cursorFile });
    appendRows(file, [{ text: '我已经回过这句了' }]);
    assert.equal(poll()?.text, '我已经回过这句了');
    // 模拟下一次 cue（新进程）
    assert.equal(makeChatWatcher({ file, cursorFile })(), null, '游标已推进，不该重复交付');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('聊天框：上次陪看没回完的残留不当新插话（流早就不动了）', async () => {
  const dir = tempDir('stale');
  try {
    const file = join(dir, 'chat.jsonl');
    const cursorFile = join(dir, 'cursor.json');
    // 很久以前留下的、一直没被消费的消息
    appendRows(file, [{ text: '昨天陪看没回完的话', at: Date.now() - 40 * 60_000 }]);
    writeFileSync(cursorFile, JSON.stringify({ n: 0, at: Date.now() - 40 * 60_000 }), 'utf8');
    assert.equal(makeChatWatcher({ file, cursorFile, staleMs: 1000 })(), null, '跨会话残留不该打断新一轮');
    // 而"安静看片时刚说的话"必须收得到（流的最后一条是新的）
    appendRows(file, [{ text: '刚才说的' }]);
    assert.equal(makeChatWatcher({ file, cursorFile, staleMs: 1000 })()?.text, '刚才说的');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------- 宿主会话 jsonl */

function sessionLine(text, ts = Date.now(), role = 'user') {
  return `${JSON.stringify({ type: 'message', role, content: text, timestamp: ts })}\n`;
}

test('会话文件：一次进来多条用户消息，一条一条给，不丢', async () => {
  const dir = tempDir('session-batch');
  try {
    const file = join(dir, 's.jsonl');
    writeFileSync(file, '', 'utf8');
    const w = makeInterruptWatcher(file);
    assert.ok(w);
    // 同一个 chunk 里来了两条（模型思考久了就会这样）
    appendFileSync(file, sessionLine('第一条') + sessionLine('第二条'), 'utf8');
    assert.equal(w.poll()?.text, '第一条');
    assert.equal(w.poll()?.text, '第二条', '第二条不该被同批丢掉');
    assert.equal(w.poll(), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('会话文件：宿主"事后补写"的老消息不算插话（别打断自己）', async () => {
  const dir = tempDir('session-late');
  try {
    const file = join(dir, 's.jsonl');
    writeFileSync(file, '', 'utf8');
    const w = makeInterruptWatcher(file);
    // 时间戳比 watcher 创建时刻还早 = 这是本轮起手之前的话，被宿主演习补写进来
    appendFileSync(file, sessionLine('本轮的起手消息', Date.now() - 60_000), 'utf8');
    assert.equal(w.poll(), null, '补写的老消息会让自己误以为用户在插话');
    // 真正新的插话仍然收得到
    appendFileSync(file, sessionLine('刚才插的这句'), 'utf8');
    assert.equal(w.poll()?.text, '刚才插的这句');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('会话文件：写了一半的行留到下次，补齐才报', async () => {
  const dir = tempDir('session-partial');
  try {
    const file = join(dir, 's.jsonl');
    writeFileSync(file, '', 'utf8');
    const w = makeInterruptWatcher(file);
    const full = sessionLine('还没写完').trimEnd();   // 故意不加换行
    appendFileSync(file, full, 'utf8');
    assert.equal(w.poll(), null, '半行不能当成一条消息');
    appendFileSync(file, '\n', 'utf8');
    assert.equal(w.poll()?.text, '还没写完');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('会话文件：只有模型自己说话时不报插话', async () => {
  const dir = tempDir('session-self');
  try {
    const file = join(dir, 's.jsonl');
    writeFileSync(file, '', 'utf8');
    const w = makeInterruptWatcher(file);
    appendFileSync(file, sessionLine('这是模型自己说的', Date.now(), 'assistant'), 'utf8');
    appendFileSync(file, `${JSON.stringify({ type: 'tool', timestamp: Date.now() })}\n`, 'utf8');
    assert.equal(w.poll(), null);
    // 文件确实被读过（没有残留）
    assert.equal(readFileSync(file, 'utf8').split('\n').filter(Boolean).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('会话文件：没有会话文件时不炸，返回 null', () => {
  assert.equal(makeInterruptWatcher(join(tempDir('nope'), 'missing.jsonl')), null);
});

/* ------------------------------------------------- 双 cue 防护 */

test('双 cue 防护：另一个进程还活着就占线；pid 已死 / 不在阻塞 / 没状态文件都放行', async () => {
  const dir = tempDir('busy');
  try {
    const file = join(dir, 'cue-state.json');
    assert.equal(cueBusy(file), null, '没有状态文件 = 没人占线');

    // 起一个真活着的进程，拿它的**真实 pid**（bash 的 $! 给的是 job id，不是 OS pid）
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},5000)'], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 300));
    writeFileSync(file, JSON.stringify({ phase: 'blocking', at: Date.now(), pid: child.pid }), 'utf8');
    assert.ok(cueBusy(file), '还活着的 cue 必须被认成占线');

    // 进程被强杀后留下的状态（pid 已不存在）：放行，否则陪看永远起不来
    writeFileSync(file, JSON.stringify({ phase: 'blocking', at: Date.now(), pid: 999_999 }), 'utf8');
    assert.equal(cueBusy(file), null, 'pid 已死 = 残留状态，不算占线');

    // 正常结束留下的状态
    writeFileSync(file, JSON.stringify({ phase: 'end', at: Date.now(), pid: child.pid }), 'utf8');
    assert.equal(cueBusy(file), null, 'phase 不是 blocking 就不占线');

    // 自己写的当然不算别人
    writeFileSync(file, JSON.stringify({ phase: 'blocking', at: Date.now(), pid: process.pid }), 'utf8');
    assert.equal(cueBusy(file), null, '自己的状态不该拦住自己');

    child.kill();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
