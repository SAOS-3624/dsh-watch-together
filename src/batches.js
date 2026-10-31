/**
 * batches.js — 批次时长表：开头短、逐段加长、最后稳定。
 *
 * 为什么不是固定批次：固定 5 分钟意味着**第一次说话要等将近 5 分钟**。
 * 用户刚点开视频，最想要的是"它已经跟上了"这个确认感，而不是等满一个批次。
 *
 * 所以开头短、后面逐渐加长：
 *
 *   1 分钟 → 2 分钟 → 3 分钟 → 4 分钟 → 5 分钟 → 5 分钟 → …
 *
 * 短批次只在起步时出现，代价是那几分钟多跑几次分镜；稳定后回到 5 分钟一档，
 * 长期成本和固定批次一样。
 *
 * 这个模块是**唯一的批次边界来源**：循环用它排段、工具用它找"当前在第几段"，
 * 两边必须用同一张表，否则会出现"它说 04:00 开始、实际建的是 03:00 那段"。
 */

/**
 * 默认余量（秒）。用户定的：**少于 5 分钟不保险**。
 * 按段数算的话，开头 1/2/3 分钟一段，"两段"只有 2 分钟。
 */
export const DEFAULT_LOOKAHEAD = 300;

/** 默认起步：1/2/3/4 分钟，之后稳定到 segment */
export const DEFAULT_RAMP = Object.freeze([60, 120, 180, 240]);
/** 稳定档（秒） */
export const DEFAULT_SEGMENT = 300;

/**
 * @param {object} o
 * @param {number} [o.segment] 稳定后的批次长度（秒）
 * @param {number[]|null} [o.ramp] 起步阶梯；不传 = 用默认阶梯；传 null/[] = 全程等长
 */
export function makePlan({ segment = DEFAULT_SEGMENT, ramp } = {}) {
  const steady = Number(segment) > 0 ? Number(segment) : DEFAULT_SEGMENT;
  // undefined = 用默认阶梯；null / [] = 明确不要阶梯（库/测试的等长行为）
  const source = ramp === undefined ? DEFAULT_RAMP : ramp;
  const steps = Array.isArray(source) && source.length > 0
    ? source.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0)
    : [];

  const sizeAt = (index) => {
    const i = Math.floor(Number(index));
    return Number.isFinite(i) && i >= 0 && i < steps.length ? steps[i] : steady;
  };

  // ramp 阶段用前缀和；稳定阶段是线性的，按公式取起点，不再把整条时间轴展开成数组。
  // 旧实现固定只算 513 个起点：10 小时、1 分钟一段（600 段）之后，indexAt 就永远
  // 停在 512，segmentAt 会把后面所有的位置都报成 05:07 左右那一段。
  const prefix = [0];
  for (let i = 0; i < steps.length; i += 1) prefix.push(prefix[i] + steps[i]);
  const rampEnd = prefix[steps.length];

  const startAt = (index) => {
    const i = Math.floor(Number(index));
    if (!Number.isFinite(i) || i <= 0) return 0;
    if (i < steps.length) return prefix[i];
    return rampEnd + (i - steps.length) * steady;
  };

  /** 前 513 段的起点（保留给老调用方查看；真正的边界由 startAt 计算） */
  const starts = Array.from({ length: 513 }, (_, i) => startAt(i));

  const indexAt = (pos) => {
    const p = Math.max(0, Number(pos) || 0);
    if (steps.length > 0 && p < rampEnd) {
      // 找最后一个 from <= p 的 ramp 段。
      let lo = 0;
      let hi = steps.length - 1;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi + 1) / 2);
        if (prefix[mid] <= p) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    }
    return steps.length + Math.floor((p - rampEnd) / steady);
  };

  return {
    segment: steady,
    ramp: steps,
    sizeAt,
    starts,
    indexAt,
    /** 覆盖 pos 的那一段 */
    segmentAt(pos) {
      const i = indexAt(pos);
      const from = startAt(i);
      const size = sizeAt(i);
      return { index: i, from, to: from + size, size };
    },
    /**
     * 从第 index 段开始，往后取 count 段。
     *
     * **只给边界，不给"什么时候说"**。交付时刻由调用方按 `to - lead` 自己算（见
     * `position.js` 的 `shouldSpeak`）。这里曾经顺手产出 `sayAt: to - 15`，
     * 于是提前量在代码里有三个来源（批次表的 15、循环的 15、调用方的 lead）——
     * 传 `lead: 30` 时只有一条路生效，另外两条照样按 15 秒触发。
     */
    from(index, count) {
      const out = [];
      const start = Number(index);
      const n = Number(count);
      if (!Number.isFinite(start) || !Number.isFinite(n) || n <= 0) return out;
      const base = Math.max(0, Math.floor(start));
      const take = Math.floor(n);
      for (let k = 0; k < take; k += 1) {
        const i = base + k;
        const from = startAt(i);
        const size = sizeAt(i);
        out.push({ index: i, from, to: from + size, size });
      }
      return out;
    },
    /** 是否还处在"加长阶段"（给 statusOnly 看） */
    isRamping(index) {
      return index < steps.length;
    },
  };
}

/** 人类可读的阶梯描述，例如 "1m → 2m → 3m → 4m → 5m" */
export function describePlan(plan) {
  const head = plan.ramp.map((x) => `${Math.round(x / 60)}m`).join(' → ');
  const tail = `${Math.round(plan.segment / 60)}m`;
  return head ? `${head} → ${tail}（之后固定）` : tail;
}

/**
 * 从**当前位置**往后，要备到哪一段为止，才能保证"已就绪时长 ≥ lookahead"。
 *
 * 为什么按位置而不是按段数：段长是变的（1/2/3/4/5 分钟）。按段数算只能在"段首"保证
 * 5 分钟，用户在段中间时就不够了；按位置算，答案永远是"到 pos + lookahead 为止"。
 *
 * 返回的是**连续段列表（含当前段）**：第一个的 from ≤ pos，最后一个的 to ≥ pos + lookahead
 * （片尾取到最后一段为止）。
 *
 * @param {object} plan      makePlan() 的结果
 * @param {number} pos       当前播放位置（秒）
 * @param {number} lookahead 余量（秒），0 表示只要当前段
 */
export function windowFor(plan, pos, lookahead = 300) {
  const target = Math.max(0, Number(lookahead) || 0);
  const out = [];
  const start = plan.indexAt(pos);
  for (let i = 0; i < 512; i += 1) {
    const seg = plan.from(start + i, 1)[0];
    if (!seg) break;
    out.push(seg);
    if (target <= 0) break;
    if (seg.to - pos >= target) break;
  }
  return out;
}
