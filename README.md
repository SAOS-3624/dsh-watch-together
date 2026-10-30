# dsh-watch-together

> 陪一个只会读文字的模型**一起看视频**：跟着你的真实播放进度一段段往下看，在你快看完这一段时把画面和台词递过来。
>
> 名字全小写，带横杠 —— 和 `dsh-video-storyboard` 同一个风格。

---

## 它和 `dsh-video-storyboard` 是什么关系

**两个插件，一个依赖。** 这不是一个包里的两个开关。

| | `dsh-video-storyboard` | **`dsh-watch-together`（本包）** |
|---|---|---|
| 版本 | **0.5.x** | **0.1.0** |
| 工具 | `video_storyboard` / `video_zoom` / `video_probe` / `video_locate` | `watch_together` |
| 干什么 | 把一段视频变成**一张可引用的宫格**（一次性、全片或指定窗口） | 跟着播放进度**一段一段看下去** |
| 依赖方向 | 不依赖陪看（`storyboard → watch` = 0 处） | **依赖视频识别**，单向 |

陪看天生建立在视频识别之上：它每次交付的那一格画面和清单，都是调用 `dsh-video-storyboard` 的
`runStoryboard()` 算出来的。所以本包把 `dsh-video-storyboard` 写成**普通依赖**（`^0.5.0`），
`npm i dsh-watch-together` 会连它一起装上 —— 装的是**库代码**，不会因此多注册四个 `video_*` 工具
（工具由各自的插件入口注册）。

想只要视频识别、不要陪看：装 `dsh-video-storyboard` 就行，本包不会被拖进来。

## 安装

```bash
npm i dsh-watch-together        # 会一并装 dsh-video-storyboard
```

前置条件（ffmpeg / yt-dlp / ASR）跟 `dsh-video-storyboard` 完全一样，
见那个包的 [README](https://github.com/SAOS-3624/dsh-video-storyboard#readme) 与 `docs/INSTALL.zh.md`。

陪看自己额外需要一台装了 `winrt` 的 Python（读系统媒体控件用）：

```bash
pip install winrt-runtime winrt-Windows.Media.Control winrt-Windows.Foundation
```

插件按这个顺序找解释器：`DSH_PYTHON` 环境变量 → `~/.dsh/asr.json` 里 `manage.start` 用的那个
（你为 ASR 配的 venv 很可能也装在这里）→ PATH 上的 `python` / `python3`。
找到后会真的 `import` 一次验证，验证不过就当作没有，**不会因为路径对就当成能用**。

## 怎么用

```js
watch_together({ input: "D:/Movie/xxx.mp4" })   // 每 20 秒左右调一次
```

### 它怎么工作

```
用户看到 05:12  →  插件算下一段（05:12–07:12）   ← 这 8 秒用户还在看，等得起
用户看到 07:00  →  这一段早算好了，直接把图递出来  ← 感知延迟 0
```

**AI 先看完，卡着用户的进度说话。** 计算发生在用户在看的当口，所以感觉像一起看。

| 参数 | 默认 | 说明 |
|---|---|---|
| `ramp` | `[60,120,180,240]` | **变速启动**：开头短、逐段加长，第一次说话不用等 5 分钟 |
| `segment` | 300 秒 | 稳定后的批次长度（阶梯走完后固定在这一档） |
| `depth` | 2 | 保留几个批次（当前 + 下一个）。前面的用完，后面的顶上，同时算再下一个 |
| `lead` | 15 秒 | **段末前多少秒交付**。不是段末——两格交界处插话最突兀 |
| `cells` | 5 | 每段一张图 |
| `cursor` | 自动 | 用户看到第几秒；不给就从系统读 |

### 变速启动：先短后长

```
1 分钟 → 2 分钟 → 3 分钟 → 4 分钟 → 5 分钟 → 5 分钟 → …
 └─ 45 秒就说第一句           └─ 之后稳定，不再加长
```

固定 5 分钟一档意味着**第一次开口要等将近 5 分钟**。刚点开视频时最需要的是"它已经跟上了"，
所以开头几批短一些，代价只是那几分钟多跑几次分镜。

```js
watch_together({ ramp: [30, 60, 120] })   // 更激进的起步
watch_together({ ramp: [] })              // 全程等长，不要阶梯
```

### 双缓冲：永远留一个批次在后面

```
批次 1 正在看  ┃  批次 2 已建好  ┃  （空闲时开始建批次 3）
批次 1 用完    →  批次 2 顶上，同时开始建批次 3
```

建一个批次要 2–10 秒，而看一个批次要 `segment` 秒，所以**总有时间在空闲里把它建完**。
实测 4 次交付全部 **0.0 秒**（命中预取），批次之间无缝。

## 进度从哪来（不需要装播放器插件）

读 Windows 的**系统媒体控件**（SMTC）。任何接了它的播放器都行：

- **本地文件**：VLC / PotPlayer / 电影和电视
- **网页**：Edge / Chrome 播 B 站

实测输出：

```
MSEdge | playing | pos=5.9s | dur=68.0s | 鲸鱼陪看：让 DSH 里的她看得见你的屏幕
```

读不到时它会**明说读不到**并要你自报（`cursor: 750` 或 `"12:30"`），**不会猜**——
猜错一次，后面每一段都是错的。

> SMTC 探测靠 `src/watch_smtc.py`，它**必须和 `src/watch-probe.js` 放在同一层**。
> 早期版本把它落在上一级目录，于是 `execFile` 找不到脚本、探测恒定失败，
> 而错误信息只说 "Command failed"。搬包时已经把它放到正确位置。

### 想要毫秒级准？开浏览器的调试端口

SMTC 的刷新是稀疏的。浏览器里那个 `<video>.currentTime` 才是**真值**，只要求浏览器带调试端口启动：

```bash
# 用一个独立 profile，这样不会影响你正在开的 Edge
"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" ^
  --remote-debugging-port=9333 --user-data-dir="%USERPROFILE%/.dsh/edge-watch"
```

然后告诉插件端口 —— 三种写法任选（**桌面版读不到 `setx` 的环境变量，所以推荐写文件**）：

```jsonc
// ~/.dsh/video.json
{ "browserPort": 9333 }
```

```bash
DSH_BROWSER_DEBUG_PORT=9333      # 或者环境变量
```
```js
watch_together({ browserPort: 9333 })   // 或者单次传参
```

> 端口别用 9222：那是 Chrome DevTools 的惯例端口，**WorkBuddy 自己就占着**（实测读到的会是它的界面）。

开了之后：**位置毫秒级准**（实测 `pos=8.374`），而且**当前页面地址就是源**：
B 站页面直接拿到 BV 链接；`file:///D:/x.mp4` 直接还原成本地路径。**不用搜索、不用下载、不用问用户。**

### 为什么进度会"读不到"（重要）

Edge 播网页视频时，Windows 媒体控件的 `Position` **只在事件发生时刷新**：起播、暂停、拖动、切集。
连续播放期间它可能几分钟不动（实测两次刷新隔过 143 秒、216 秒）。

所以插件区分三种可信度：

| 可信度 | 判断依据 | 行为 |
|---|---|---|
| `fresh` | 10 秒内刷新过 | 直接信 |
| `extrapolated` | 刷新旧了但在播 | 按墙钟往前推，**说话前要多越过 15 秒**才开口 |
| `unknown` | 超过 45 秒没刷新 | **不推、不说**，明确要你给 `cursor` |

位置刷新下来的那个值本身是准的（真机对表 3 次，误差都 ≤1 秒）——
**错的是"刷新时刻到此刻"这一段**，所以不能把冻结值当实时值。

`watch_together({ statusOnly: true })` 可以随时看钟的状态：读到第几秒、可不可信、为什么没说话。

## 接声音（核心不发声，声音你自己接）

这个包**不带任何 TTS 引擎**，也不读 `~/.dsh/tts.json`。它只做两件事：

1. 在**正确的播放时刻**把台词交出去；
2. 每次结果里带上 `speech` 事件，`at` 是这句话在时间轴上的位置。

念不念、用什么念、念多快，全由你（或宿主）决定。

### 事件长什么样

`watch_together` 交付一段时，返回值里有：

```json
"speech": [
  { "at": 191, "text": "钓上来了，池子里那条比他想的配合。", "state": "scheduled", "segment": 180 }
]
```

后台循环里某句到点时，会把同一条推给你，`state` 变成 `"due"`。

### 同进程：订阅

```js
import { onSpeech } from 'dsh-watch-together/voice';

const off = onSpeech(async ({ state, text }) => {
  if (state !== 'due') return;      // scheduled 只是清单，不是"现在念"
  await mySpeak(text);              // ← 你自己的引擎
});
```

**有人订阅时**：到点的台词直接交给订阅者，循环**不会**再叫醒模型（省 token，也避免同一句被说两遍）。
**没人订阅时**：台词照旧走"叫醒模型、模型自己说"那条路 —— 功能完整，只是安静。

> 只做展示的订阅者要传 `{ voice: false }`（聊天框就是这么干的）：否则循环会以为"有人会念"，
> 从此不再叫醒模型 —— 陪看会**默默地**变成哑巴。

### 现成适配器：`examples/voice-edge-tts`

带了一个可以直接用的适配器：edge-tts 合成 → `ffplay` 播放 → 失败退回系统声音。
每一句都会在 **stderr 打一行时间码**：

```
[voice 03:11.4] 钓上来了，池子里那条比他想的配合。
```

调试时最想知道的就是"它到底是第几秒吐出来这句话"，这行比音频本身还有用。

启用只要一个文件：

```json
// ~/.dsh/voice.json
{ "adapter": "D:/deepseek/3-Life/dsh-watch-together/examples/voice-edge-tts/index.mjs" }
```

或者环境变量 `DSH_VOICE_ADAPTER=<同样的路径>`。插件启动时 `import()` 它，挂不上只写一行 warn，
**不会**影响插件启动。

### 最小适配器（一分钟）

```js
// my-voice.mjs
import { execFile } from 'node:child_process';

export function attach({ onSpeech }) {
  return onSpeech(({ state, text }) => {
    if (state === 'due') execFile('say', [text], () => {});   // macOS；换成你自己的引擎
  });
}
```

`attach(api)` 收到 `{ onSpeech, speechSubscribers, emitSpeech, lastSpeech }`，返回一个退订函数即可。

## 聊天框 / 悬浮窗：一条统一的文本流

插话那句和剧本台词**走同一条流**，一起显示在聊天框里，也一起被念出来：

| role | 是什么 | 会念 |
|---|---|---|
| `line` | 剧本台词（到点由循环写进来） | 是 |
| `assistant` | 模型插话时说的那句 | 是 |
| `user` | 你自己打的字 | 否 |

它们都落在 `chat.jsonl`（`%LOCALAPPDATA%\dsh-video-storyboard\cache\` —— 缓存目录由
`dsh-video-storyboard` 管，两个插件共用一份）。

**模型自己说的话怎么进到框里？** 靠 `say`：

```js
watch_together({ say: "你看这条，鱼比人还紧张。" })
```

插件读不到模型的正常回复，所以插话时想让用户**看见并听见**，就得把这句话交给 `say`。

### 悬浮窗（不用浏览器）

`examples/floating-chat/window.py` 是个**真·独立悬浮窗**：无边框、置顶、半透明、
按住顶部拖动、回车发送、Esc 关闭。用标准库 tkinter，不装任何第三方包。

```bash
pythonw examples/floating-chat/window.py     # 无控制台
```

> **一定要用带 tkinter 的 Python**：Windows 商店版自带；python.org 官方安装包勾上 tcl/tk 也有。
> WorkBuddy 托管的那份**没有** tkinter。

它和浏览器那个框看的是同一个文件，两个一起开着也不打架。

## 命令行（没有 DSH 宿主时）

`bin/watch.mjs` 是给**没有 `watch_together` 工具的会话**（比如普通的终端 AI）用的壳，
import 的是同一份 `src/`：

```bash
node bin/watch.mjs doctor      # 自检：运行时、python、端口、缓存
node bin/watch.mjs start       # 起陪看服务
node bin/watch.mjs wait 180    # 等用户点开片子
node bin/watch.mjs status      # 看当前进度与下一步该跑什么
node bin/watch.mjs seg auto    # 出宫格 + 句子时间轴
node bin/watch.mjs cue '[[字幕from,"台词"]]'
```

`node bin/watch.mjs help` 就是完整用法。

## 它不是全片概览

- 一次只看一段，看完再下一段
- 想细看某一格 → `video_zoom({ cellId: 3 })`（那是 `dsh-video-storyboard` 的工具）
- 每段 5 格 ≈ 1,000–1,300 token；90 分钟片约 4.5–6 万 token（是一次性概览的 4–6 倍，换的是"有时间顺序"）

## 代码结构

```
src/
  index.js          插件入口：只注册 watch_together，并挂上声音与聊天框
  register.js       watch_together 的注册入口
  tool-spec.js      watch_together 的 schema ＋ 兜底校验
  handler.js        watch_together 的 execute

  watch-loop.js     后台循环：每段到点自己叫醒模型
  watch-run.js      一次陪看调用：读位置、建这一段、到点交付
  watch-modes.js    各种等待模式
  watch-actions.js  单发命令（status / voices / speak / cookies / wake / stop）

  watch.js          门面：转发下面三个
  watch-probe.js    播放位置：起 python 读 SMTC（唯一碰平台的地方）  + watch_smtc.py
  watch-state.js    看到哪儿了：watch.json 读写 ＋ 段长/交付点算术
  watch-lines.js    该说什么了：位置轴上的台词队列

  watch-source.js   这次看的是哪个源
  watch-browser.js  "浏览器在不在"＋没有就拉起来＋读一次位置
  position.js       位置可信度与推算
  resolve-playing.js  系统媒体控件在放什么
  latency.js        交付延迟记录与补偿
  batches.js        变速启动与批次窗口
  timer.js          到点提醒

  voice.js          门面 ─┬ speech-bus.js    订阅总线（谁在听、谁真会出声）
  voice-adapter.js  ──────┘ 按路径挂外部引擎
  speech.js         台词语速/后延的估算

  chat.js           门面 ─┬ chat-store.js    chat.jsonl 读写
  chat-view.js      ──────┤ 两个 HTML 模板
  chat-server.js    ──────┘ localhost 四条路由

  time.js           mmss（秒 → "mm:ss"），只有一份实现
```

依赖是**单向**的：这里的模块可以 `import 'dsh-video-storyboard/...'`，反过来永远不会发生
（那个包里出现一个指向本包的 import 就是循环依赖，构建会直接红）。

## 许可

MIT。见 [LICENSE](LICENSE)。
