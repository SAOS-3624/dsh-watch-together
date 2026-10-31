#!/usr/bin/env node
/**
 * bin/lines.mjs — 写台词最短的路：**不看图，只给秒数和句子**。
 *
 * 为什么有它：每写一段台词都要先等一张 storyboard 图（400~700 vision token）
 * 再写 3 句，代价全花在"看图"上。而台词需要的信息只有两个：
 * 这段在说什么、那句话在第几秒 —— 字幕里都有，纯文本。
 *
 * 五个子命令：
 *
 *   scan   看一段的候选句（**纯文本**，8~10 句，两三百字）
 *   auto   不过模型：按打分直接选 3 句写进稿子（省事模式，只是复述字幕）
 *   set    自己写：`--at 195 --text "…"` 可重复，写完立刻生效
 *   list   这支片子现在有哪些段写过台词、各几句
 *   cues   导出原始字幕（排查"为什么候选是这几句"）
 *
 * 例子：
 *   node bin/lines.mjs scan --input https://www.bilibili.com/video/BV1xxx/ --from 180 --size 180
 *   node bin/lines.mjs auto --input <url> --from 180 --size 180 --count 3
 *   node bin/lines.mjs set  --input <url> --from 180 --at 200 --text "…" --at 250 --text "…"
 */

import { parseArgs } from 'node:util';

import { loadCues, pickCandidates, autoPick, sentencesBetween } from '../src/lines-util.js';
import { readBridge } from '../src/position-bridge.js';
import { linesOverview, readSlot, saveLines } from '../src/watch-lines.js';

const HELP = `用法：node bin/lines.mjs <scan|auto|set|list|cues> --input <url|路径> [选项]

  scan   --from <秒> --size <秒> [--max 10] [--json]   这一段有哪些可用的句子（纯文本）
  auto   --from <秒> --size <秒> [--count 3] [--dry]   直接选几句写进稿子，不过模型
  set    --from <秒> --at <秒> --text <句子> [--at … --text …]
  list   [--from <秒>]                                 已经写过台词的段
  cues   [--from <秒> --size <秒>]                     原始字幕（每句一行）

公共选项：--cookies <文件> --refresh（忽略字幕缓存）--quiet`;

function parse() {
  const { values } = parseArgs({
    options: {
      input: { type: 'string', short: 'i' },
      from: { type: 'string' },
      to: { type: 'string' },
      size: { type: 'string' },
      max: { type: 'string' },
      count: { type: 'string' },
      at: { type: 'string', multiple: true },
      text: { type: 'string', multiple: true },
      cookies: { type: 'string' },
      json: { type: 'boolean', default: false },
      dry: { type: 'boolean', default: false },
      refresh: { type: 'boolean', default: false },
      quiet: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });
  return values;
}

const mmss = (s) => {
  const n = Math.max(0, Math.round(Number(s) || 0));
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
};

function need(values, key) {
  const v = values[key];
  if (v === undefined || v === null || String(v).trim() === '') {
    console.error(`缺少 --${key}`);
    console.error(HELP);
    process.exit(2);
  }
  return String(v);
}

async function main() {
  const values = parse();
  const cmd = process.argv[2];
  if (values.help || !cmd || cmd === 'help') {
    console.log(HELP);
    return;
  }
  const input = need(values, 'input');
  const size = Number(values.size ?? 120);

  const cuesRes = await loadCues(input, {
    cookies: values.cookies ?? null,
    refresh: values.refresh === true,
  });
  if (!cuesRes.ok) {
    console.error(`拿不到字幕：${cuesRes.reason}（没有字幕就只能看图写，用 watch_together）`);
    process.exit(1);
  }
  if (!values.quiet) {
    // 顺手报一下"现在播到哪儿了" —— 省掉一次专门的 statusOnly 调用。
    // 只读扩展写的位置文件（5 秒内有效），不去连 CDP，快且不会打扰浏览器。
    const now = await readBridge({ maxAgeMs: 120_000 }).catch(() => null);
    const where = now ? ` · 当前 ${mmss(now.pos)}${now.paused ? '（暂停）' : ''}` : '';
    console.error(`# 字幕 ${cuesRes.cues.length} 条（${cuesRes.source}${cuesRes.lang ? `, ${cuesRes.lang}` : ''}）${where}`);
  }

  if (cmd === 'cues') {
    const from = Number(values.from ?? 0);
    const to = values.to !== undefined ? Number(values.to) : from + size;
    const sents = sentencesBetween(cuesRes.cues, from, to);
    for (const s of sents) console.log(`${s.at.toFixed(1)}\t${mmss(s.at)}\t${s.text}`);
    if (sents.length === 0) console.error('（这一段没有可用的句子）');
    return;
  }

  if (cmd === 'scan') {
    const from = Number(values.from ?? 0);
    const to = values.to !== undefined ? Number(values.to) : from + size;
    const cands = pickCandidates(cuesRes.cues, { from, to, max: Number(values.max ?? 10) });
    if (values.json) {
      console.log(JSON.stringify(cands, null, 1));
      return;
    }
    console.log(`段 ${mmss(from)}–${mmss(to)}｜候选 ${cands.length} 句（挑 2~3 句写进 lines，用 set）`);
    for (const s of cands) console.log(`${String(s.at).padStart(7)}\t${s.text}`);
    return;
  }

  if (cmd === 'auto') {
    const from = Number(values.from ?? 0);
    const to = values.to !== undefined ? Number(values.to) : from + size;
    const picked = autoPick(cuesRes.cues, { from, to, count: Number(values.count ?? 3) });
    if (picked.length === 0) {
      console.error('这一段没有可用句子');
      process.exit(1);
    }
    const lines = picked.map((p) => ({ from, at: p.at, text: p.text }));
    if (values.dry) {
      console.log(JSON.stringify(lines, null, 1));
      return;
    }
    const n = await saveLines(input, lines, {});
    console.log(`已写入 ${n} 句 → 段 ${mmss(from)}–${mmss(to)}`);
    for (const l of lines) console.log(`${String(l.at).padStart(7)}\t${l.text}`);
    console.log('（auto 只是复述字幕原文；要"评论"就 scan + set）');
    return;
  }

  if (cmd === 'set') {
    const from = Number(values.from ?? 0);
    const ats = values.at ?? [];
    const texts = values.text ?? [];
    if (ats.length !== texts.length || ats.length === 0) {
      console.error('--at 与 --text 要一一对应，且至少一组');
      process.exit(2);
    }
    const lines = ats.map((at, i) => {
      const raw = String(at).trim();
      // at 允许直接给数字秒，也允许给 mm:ss
      const sec = /^\d+(\.\d+)?$/.test(raw)
        ? Number(raw)
        : (() => {
          const m = raw.match(/^(\d+):(\d+(?:\.\d+)?)$/);
          return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
        })();
      return { from, at: Number.isFinite(sec) ? sec : raw, text: String(texts[i]) };
    });
    const bad = lines.find((l) => typeof l.at === 'string');
    if (bad) {
      console.error(`--at 只认秒数或 mm:ss，收到：${bad.at}`);
      process.exit(2);
    }
    const n = await saveLines(input, lines, {});
    console.log(`已写入 ${n} 句 → 段 ${mmss(from)}–${mmss(from + size)}`);
    for (const l of lines) console.log(`${String(l.at).padStart(7)}\t${l.text}`);
    return;
  }

  if (cmd === 'list') {
    const ov = await linesOverview(input, {});
    if (ov.length === 0) {
      console.log('这支片子还没有写过台词');
      return;
    }
    for (const s of ov) {
      const slot = await readSlot(input, s.from, {});
      console.log(`段 ${mmss(s.from)}（${s.count} 句）`);
      for (const x of slot) console.log(`   ${JSON.stringify({ at: x.at, text: x.text })}`);
    }
    return;
  }

  console.error(`不认识的子命令：${cmd}`);
  console.error(HELP);
  process.exit(2);
}

main().catch((e) => {
  console.error(`失败：${e?.message ?? e}`);
  process.exit(1);
});
