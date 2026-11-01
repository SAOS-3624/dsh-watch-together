/**
 * watch-detail.test.mjs — `detail` 档位必须真的透传进分镜管线。
 *
 * 这条测试原来在 `dsh-video-storyboard` 的 `test/board.test.mjs` 里，但它测的是
 * **陪看的行为**（`runWatchPass` 把 detail/ocr/minGap 怎么交给 `runStoryboard`），
 * 所以跟着工具一起搬过来了。留在那边会变成"删掉陪看就得删一条看起来无关的测试"。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runWatchPass } from '../src/watch-run.js';

test('陪看把 detail 透传进管线，并按档位收紧清单预算', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'board-watch-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    const seen = {};
    const deps = {
      cache: new Map(),
      saveImage: async ({ data }) => data,
      runStoryboard: async (opts) => {
        seen.opts = opts;
        return { sheets: [{ png: Buffer.from('x'), cells: [] }] };
      },
      formatManifest: (result, opts) => { seen.fmt = opts; return 'm'; },
      probe: async () => ({ ok: true, sessions: [] }),
    };

    await runWatchPass(
      { input: 'w.mp4', cursor: 106, segment: 120, lead: 15, detail: 'high' },
      deps,
    );
    assert.equal(seen.opts.detail, 'high', 'detail 必须传进 runStoryboard');
    assert.equal(seen.opts.ocr, true);
    // 0.6.0 起管线不再收 `minGap`：切点近邻合并不是"拍脑袋定一个间隔"，
    // 而是档位算法按密度自己压（见 storyboard 的 tiers.js）。陪看这边靠 maxFrames 兜住。
    assert.equal(seen.opts.minGap, undefined, '管线已不收 minGap');
    assert.equal(seen.opts.maxFrames, 5, '陪看一段默认 5 帧');
    assert.equal(seen.opts.maxSheets, 1, '陪看一段只发一张图');
    assert.equal(seen.fmt.maxCellChars, 400, '清单每格字数跟着 detail 走');
    assert.equal(seen.fmt.maxChars, 6000, 'high 档位给更大的总预算');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
