# 声音 / 语音播报 使用教程

> 这一篇只讲一件事：**怎么让陪看把到点的台词念出声来**，以及怎么换成你喜欢的音色（比如微软晓萱）。
> 看完这篇，你应该能做到：跑一次陪看，到点的台词用你选的音色念出来。
>
> 配套文档：服务怎么配看 [`CONFIG.zh.md`](./CONFIG.zh.md)，浏览器接入看 [`BRIDGE.zh.md`](./BRIDGE.zh.md)。

---

## 0. 先搞清楚：陪看"本身"不会出声

陪看的核心只干一件事：**在正确时刻把台词作为一个事件发出去**。它里面**没有任何一行发声代码**——
没有 TTS 引擎、没有"用哪个音色"这种参数。

所以"出声"是一个**可选的外挂**：你接一个"消费者"（代码里叫声音适配器），它订阅那些事件、把台词念出来。
不接的话，陪看功能完全正常，只是安静——到点的台词照样会叫醒模型让模型自己说，只是不帮你念。

本包自带一个**能出声的现成适配器**：`examples/voice-edge-tts/index.mjs`。
它做的事很直白：收到台词 → 用微软 edge-tts 合成 → 用 ffplay 播放。还顺手在 stderr 打一行时间码：

```
[voice 03:11.4] 这一幕其实是个梦境
```

调时序时这行比声音还有用——你能直接看到"这句话到底在第几秒吐出来的"。

---

## 1. 三步接好声音（最常用的路）

总共要动两个文件，都在你的 **`~/.dsh/` 目录下**（不是仓库里，也不是 npm 包里）：

| 文件 | 干嘛 | 不写会怎样 |
|---|---|---|
| `~/.dsh/voice.json` | **挂载**适配器（告诉核心"用哪个发声模块"） | 没外挂 → 安静 |
| `~/.dsh/tts.json` | **选音色 / 语速**（适配器读这里的 `voice`） | 用中性默认音色 |

> `~/.dsh/` 在 Windows 上一般是 `C:\Users\<你的用户名>\.dsh\`。
> 这两个文件都不在包里，所以你**发布给别人时不会把你的音色带过去**（见第 6 节）。

### 第 1 步：确认适配器在

适配器文件是 `examples/voice-edge-tts/index.mjs`。它随包一起装在：

- **开发模式（你自己 clone 的源码）**：`<你 clone 的目录>/dsh-watch-together/examples/voice-edge-tts/index.mjs`
- **装成 npm 包后**：`<项目>/node_modules/dsh-watch-together/examples/voice-edge-tts/index.mjs`

下面两步都用这个**绝对路径**。

### 第 2 步：挂载适配器（写 `voice.json`）

新建（或覆盖）`~/.dsh/voice.json`，内容就一行路径：

```json
{
  "adapter": "<你 clone 的目录>/dsh-watch-together/examples/voice-edge-tts/index.mjs"
}
```

> 把上面路径换成你机器上适配器的真实绝对路径（开发模式填仓库路径；装成包填 node_modules 路径）。
> `D:/...` 这种带盘符的路径是支持的，也可以填相对路径或包名。
>
> 不想写文件也行，用环境变量代替：`DSH_VOICE_ADAPTER=<同样的路径>`。

**看到什么算成功**：这一步没"成功提示"，它只是告诉核心"加载这个模块"。真正有没有挂上，看第 3 步跑起来后的日志。

### 第 3 步：选音色（写 `tts.json`）

新建（或覆盖）`~/.dsh/tts.json`：

```json
{
  "voice": "zh-CN-XiaoxuanNeural",
  "rate": 0
}
```

字段说明：

- `voice`：**神经音色名**。微软一堆中文神经音色，常用的有：
  - `zh-CN-XiaoxuanNeural`（晓萱，温柔女声）
  - `zh-CN-YunxiNeural`（云希，沉稳男声）
  - `zh-CN-XiaoxiaoNeural`（晓晓，活泼女声）
  - `zh-CN-YunyangNeural`（云扬，新闻男声）
  - 想翻全部，跑 `node watch.mjs voices`（见第 5 节）。
- `rate`：**语速**，可省略。
  - `0` = 默认；正数加快（如 `20` 快 20%），负数放慢（如 `-15` 慢 15%）。
- 想指定某个 edge-tts 可执行文件，加 `"edgeTts": "C:/path/to/edge-tts.exe"`；一般不用，适配器会自动找（见第 4 节）。

> **没写 `voice` 会怎样**：适配器退回中性默认 `zh-CN-YunxiNeural`，并在 stderr 打一行提示让你去配。
> 所以你不写这文件也能出声，只是不是你想要的音色。

---

## 2. 验证它真的出声了

`doctor` 命令**不检查声音**（声音是陪看跑起来时才挂载的，doctor 看不出来）。所以判断依据是**跑起来后的日志**。

**最简验证**：直接跑一次陪看（看个视频，或本地文件）。到点的那段台词，你会在 stderr 看到：

```
[voice 03:11.4] 这一幕其实是个梦境
```

并且**同时听到声音**。有这行 + 有声音，就接好了。

**只想立刻试一句、不想等陪看**：手动念一句（这条走 edge-tts，读的就是你 `tts.json` 里的 `voice`）：

```bash
node watch.mjs say "你好，我是晓萱"
# 强制用系统声音（不装 edge-tts 时兜底）：
node watch.mjs say "你好" sapi
```

**想看看有哪些音色可以换**：

```bash
node watch.mjs voices
```

改完 `tts.json` 的 `voice` 再跑 `say`，音色就变了。

---

## 3. 换音色 / 调语速

改 `~/.dsh/tts.json` 的 `voice`（换声）或 `rate`（调速），**重启陪看即生效**，不用重装。

例：想换成沉稳男声、稍慢一点：

```json
{ "voice": "zh-CN-YunxiNeural", "rate": -10 }
```

---

## 4. 依赖从哪来（三级降级，缺了也不崩）

适配器启动时会自己找依赖，按下面顺序，缺一级退一级，**永远不会因为"音色没装"就让陪看哑火**：

| 缺什么 | 后果 |
|---|---|
| `edge-tts`（`pip install edge-tts`） | 退回 Windows 系统声音（SAPI） |
| `ffplay`（ffmpeg 自带） | 合成出的 mp3 放不出来，但**日志照打** |
| 两个都没有 | 只打日志，不影响陪看 |

- **edge-tts 装哪**：推荐装进独立 venv，适配器会按这个顺序找它：
  1. `tts.json` 里的 `edgeTts` 字段
  2. 环境变量 `DSH_TTS_BIN`
  3. `~/.dsh/tts-venv/.../edge-tts`（Windows: `Scripts/edge-tts.exe`）
  4. `~/.workbuddy/binaries/python/envs/tts/Scripts/edge-tts.exe`
  5. PATH 里能找到的 `edge-tts`
- **ffplay**：ffmpeg 自带，放 PATH 即可。
- 适配器找不到 edge-tts 时会在 stderr 说一句 `[voice] edge-tts 没找到，退回系统声音`，这是预期降级，不是报错。

---

## 5. 发布给别人时，为什么不会带上你的晓萱

这是故意设计的两层隔离：

1. **适配器在包里，但默认中性音色**：`examples/voice-edge-tts/index.mjs` 随包发布，但它不在 `tts.json` 里写死任何音色——
   你没配 `voice` 时它用 `zh-CN-YunxiNeural`，提示你自己配。所以包里**没有任何人的具体音色**。
2. **真正的音色配置在 `~/.dsh/tts.json`**：这个文件在你的用户目录，不在仓库、不在 npm 包。
   挂载文件 `~/.dsh/voice.json` 同理也在用户目录。

结果：你 `npm publish` 出去的只是一段"默认中性音色 + 读用户自己 tts.json"的代码。
别人装上后，在他的 `~/.dsh/tts.json` 里写 `"voice": "zh-CN-XiaoxuanNeural"` 才会用晓萱——
**你的晓萱不会出现在别人的安装里**。

---

## 6. 自己写个适配器（最小模板）

不想用 edge-tts？任何能读事件、念文本的东西都能当适配器。最小可用版本：

```js
// my-voice.mjs
export function attach(api) {
  const off = api.onSpeech((e) => {
    if (e.state !== 'due') return;          // 只念"到点该念"的台词
    const when = (e.at / 1000).toFixed(1);  // e.at 是墙钟毫秒
    console.error(`[voice ${when}s] ${e.text}`);
    // 在这里调用你自己的 TTS / 硬件 / 别的什么
    myTtsSay(e.text);
  });
  return () => off();   // 返回 detach，核心卸载时调用
}
```

### 一定要上报"真的出声了"：`api.emitSpoken(e)`

`due` 只说明**该念了**。从 `due` 到"真的有声音"之间还隔着一整套合成（edge-tts 一次网络往返
加一个 ffplay 启动，短句也要 0.6~2 秒）。**不要等 due 才开始合成**：核心会在台词写好、
还没到点时先发 `scheduled`（未来 1 分钟内，每句一次），适配器可以据此预合成；到点再播放，
首声就不用再等网络。示例适配器已经这么做。悬浮窗里的台词等的是 `spoken`：

```js
api.onSpeech((e) => {
  if (e.state !== 'due') return;
  const audio = await synth(e.text);     // 合成：这段时间还没有声
  api.emitSpoken(e);                     // ← 开始播放那一瞬上报，字就在这一刻出现
  play(audio);
});
```

**别把它报晚了**：字是在收到 `spoken` 之后才写盘的，报晚了就变成"声音先到、字后到"。
报早一点没关系（宁可字早点），报晚了才是要修的那种不同步。

不上报也不会丢字：展示层有 2.5 秒兜底（`DSH_WATCH_CAPTION_FALLBACK_MS`），只是回到旧行为
——字比声音早，等合成完才出声。

`api.onSpeech` 收到的事件关键字段：

- `state`：`'due'` = 到点该念（**播放只处理这个**）；`'scheduled'` = 还没到点，
  可以现在预合成（**不要现在播放**）；
  `'spoken'` = 适配器上报的"开始出声了"；`'skipped'` = 放弃这句（见下）。
- `text`：要念的台词。
- `at`：**这句对应的播放位置（秒）**，不是墙钟 —— 打时间码用它。
- `input` / `segment`：哪一支片子的哪一段（多支片子交叉时用得上）。

> **`scheduled` 一定带有限的 `at`**：预取要靠它排"哪句更近"，没写 `at` 的台词不会进这个窗口。
> 适配器自己也别用 `Number(at)` 判空 —— `Number(null)` 是 `0` 且算有限数，会被当成"最早的一句"
> 占满预取队列，之后既踢不掉旧的、也进不来新的，预取就静默失效了（不报错）。判 `at == null` 才是对的。

### 追不上就放弃：`state: 'skipped'`

引擎是串行的（一句念完才轮到下一句）。台词一密，队列就会越来越长，声音离画面越来越远。
核心已经按"上一句念完才发下一句"节流，但适配器自己最好也有一道兜底：

```js
const MAX_LAG_MS = 3500;
let chain = Promise.resolve();
api.onSpeech((e) => {
  if (e.state !== 'due') return;
  const queuedAt = Date.now();
  chain = chain.then(async () => {
    if (Date.now() - queuedAt > MAX_LAG_MS) {
      // 排太久了：不念，并告诉展示层"这句没有声音"，别把字摆出来
      api.emitSpeech?.({ at: e.at, text: e.text, state: 'skipped' });
      return;
    }
    await speak(e.text);
  });
});
```

收到 `skipped` 之后，悬浮窗会撤掉那句的兜底定时器，**屏幕上不会出现一句没出声的台词**。


### 想知道"接下来念什么 / 现在播到哪"：`api.upcoming()` / `api.position()`

`due` / `scheduled` 是核心**推**给你的；这两个是你自己**拉**的。都是只读：

```js
// 接下来 20 秒内会念的句子（按 at 升序；没写好 / 没写 at 的不在里面）
const next = await api.upcoming({ horizonSec: 20 });
// → [{ at: 205, text: '……', segment: 120 }]

// 现在播到第几秒
const p = api.position();
// → { pos: 203.4, dur: 600, confidence: 'fresh', staleMs: 820 }
```

**`at` 和 `pos` 的单位都是播放秒**（不是墙钟毫秒）。`segment` 是这句所属段的段首秒数，
和 `due` / `scheduled` 事件里的 `segment` 同一个口径 —— 做预合成缓存时按它对齐。

`confidence` 三档，别忽略它：

| 值 | 含义 | 该怎么用 |
|---|---|---|
| `fresh` | 刚读到（≤5 秒）或视频暂停中 | 直接信 |
| `extrapolated` | 读数有点旧，按时钟往前推的 | 用来判断"这句过期没有"够用，**别算毫秒级同步** |
| `unknown` | 太久没读到（>60 秒），连还在不在播都不知道 | `pos` 是 **`null`**，别拿它做差值 |

> `unknown` 时 `pos` 给的是 `null` 而不是 `0`：`0` 会让"我合成的音频离当前位置晚了 300 秒"
> 这种判断成立，然后默默把音频全丢掉 —— 表现就是"有时候不出声"，还没有任何报错。

典型用法：预合成完之后记下当时的位置，播放前再问一次，差太多就丢掉（用户拖了进度条）：

```js
const atSynth = api.position();
const audio = await synth(text);
const now = api.position();
if (now.confidence === 'unknown') return playAnywayOrSkip(audio);
if (now.pos - atSynth.pos > 8 || now.pos < atSynth.pos - 1) return;   // 跳过了，这段音频已经过期
play(audio);
```

**核心不替你做合成、不缓存音频，也不重试** —— 这条边界是有意的（core #27）：
核心一旦管音频生命周期，就会出现第二个声音引擎跟它抢话；而且"这台机器合成慢要不要重试"
核心根本没法知道。


---

## 7. 为什么延迟只有 0.2 秒（常驻合成器）

> 这一节是给"想搞清楚它快在哪"的人看的。只想让它出声，前面几节就够了。

适配器有两条路，默认走新的：

| 路 | 怎么干活 | 一句的代价 |
|---|---|---|
| **常驻**（默认） | 一个 python 进程 + 一条 WebSocket + 一个 ffplay，一直活着 | 首块 **170~200ms**；预取命中 **~0ms** |
| 逐句（兜底） | 每句起一个 `edge-tts.exe`、合成到临时 mp3、再起一个 `ffplay` | **2.4~3.0 秒** |

老路慢不是因为网络，是因为四笔**固定开销每句重付一遍**：pip 的 exe shim 拉 python（~600ms）、
解释器冷启动（~600ms）、`import edge_tts`（~700ms）、WebSocket 建连（620~760ms），
再加上 ffplay 启动与 demuxer 探测（~400ms）。

常驻版把这三件事各自省掉：

- **进程只起一次** → 前 1.9 秒消失；
- **连接复用**：一条 WebSocket 上连发多句（Azure 协议本来支持）。实测连续 20 句首块
  `min 182 / avg 200 / max 235ms`，不退化。服务端在 `turn.end` 后约 **30 秒**关连接，
  所以空闲超 25s 就主动断，下次用重建（620~760ms）——**不会拿死连接去发请求**（那是丢句子）；
- **ffplay 常驻**：一个进程从 stdin 连续吃 mp3 帧，句与句之间不用重启。
  启动时先喂 0.3 秒静音把 demuxer 探测（~200ms）提前花掉。

预取也和以前不一样：`scheduled` 到了就把整句合成好放内存，`due` 时只写管道 ——
所以"到点"和"出声"几乎是同一刻。

**开关**：

```bash
# 强制走老路（怀疑常驻通道有问题时，用来排除）
DSH_TTS_STREAM=0

# 看 ffplay 的时间码（M-A 一路涨 = 真的在播，不是管道里堆着）
DSH_TTS_FFPLAY_LOG=info

# 调音量（0~100，默认 100）
DSH_TTS_VOLUME=60
```

**它不会因为挂了就没声音**：python 找不到、`daemon.py` 缺了、进程起不来 ——
任何一种情况都退回逐句那条路，日志里会有一行
`[voice] 常驻合成器起不来：…` 或 `[voice] 常驻合成器停了（…），下一句起退回逐句合成`。

---

## 8. 排错表

| 现象 | 原因 | 怎么办 |
|---|---|---|
| 完全没声音，stderr 也没有 `[voice …]` 行 | 适配器没挂上 | 查 `~/.dsh/voice.json` 是否存在、`adapter` 路径对不对（用绝对路径最稳） |
| 有 `[voice …]` 日志，但听不到声音 | edge-tts 没装 或 ffplay 没有，已退到系统声音但系统声音也被占 | 看 stderr 有没有 `[voice] edge-tts 没找到，退回系统声音`；装 edge-tts / 确认 ffplay 在 PATH |
| 出声了，但音色不对（不是晓萱） | `tts.json` 的 `voice` 没写对，或被别的文件覆盖 | 确认 `~/.dsh/tts.json` 里 `voice` 是 `zh-CN-XiaoxuanNeural`；跑 `node watch.mjs voices` 核对 |
| 想确认现在用的是不是晓萱 | —— | 跑 `node watch.mjs say "测试"`，听音色 |
| `doctor` 说一切正常，但就是没声音 | 正常——`doctor` 不查声音 | 以 stderr 的 `[voice …]` 为准 |
| 改了 `tts.json` 没生效 | 没重启陪看 | 重启陪看进程 |
| 每句都要等两秒才出声 | 没走常驻通道（stderr 里是 `[voice …] synth ready …` 而不是 `stream first=…`） | 看有没有 `[voice] 常驻合成器起不来：…`；确认 `DSH_TTS_STREAM` 不是 `0`；`python -c "import edge_tts"` 能不能跑通 |
| 第一句快、过一会儿又变慢 | 空闲超过 30 秒，服务端把连接关了，正在重建 | 正常现象（重建 ~700ms）。连着说话时不会发生 |
