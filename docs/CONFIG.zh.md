# 陪看 · 服务配置手册

> 这一篇只解决一件事：**把陪看依赖的那几个外部服务配好**，让它能准确知道你在看什么、
> 看到第几秒、并且真的念得出声。
>
> 只想先跑起来：装好 `ffmpeg` + 装一次浏览器扩展，就已经能用了（字幕走 B 站 CC）。
> 下面每一节都标了「不配会怎样」，照着缺什么补什么。

---

## 0. 一张表：到底要配哪些

| 服务 | 必装？ | 它负责 | 不配会怎样 | 配置位置 |
|---|---|---|---|---|
| **ffmpeg** | **是** | 解码、抽帧、切片、转 wav | 一张图都出不来 | `PATH` 或 `DSH_FFMPEG_PATH` |
| **浏览器扩展**（推荐） | 强烈建议 | 把真实播放进度报到本机 | 只能开专用窗口 + 调试端口 | 装扩展即可，见 §3 |
| **B 站 cookies** | 看片子 | 拿 CC 字幕 / 下载 | 只能靠 ASR，或拿不到弹幕字幕 | `~/.dsh/video.json` → `cookies` |
| **yt-dlp** | 看 B 站 | 下视频、抓字幕 | 分镜和字幕都拿不到 | `DSH_YTDLP_PATH` 或 `PATH` |
| **ASR 服务** | 没字幕才要 | 没有 CC 字幕时给出句子时间码 | 台词只能靠段边界估，会偏 | `~/.dsh/asr.json` |
| **声音适配器** | 想出声才要 | 把到点的台词念出来 | 完全静音（功能正常） | `~/.dsh/voice.json` |
| **TTS 音色** | 想出声才要 | 用哪个嗓子念 | 用中性默认音色 | `~/.dsh/tts.json` |
| **Python + tkinter** | 想要悬浮窗才要 | 独立悬浮聊天窗 | 只能用网页版聊天记录页 | 系统装 Python |

**配置文件都放 `~/.dsh/`**（Windows 是 `C:\Users\<你>\.dsh\`）。桌面版 DSH **读不到 `setx` 设的
环境变量**，所以能用文件配的一律写文件；环境变量只当临时覆盖。

先跑一次自检，它会按依赖逐项告诉你是哪一条不通：

```bash
node bin/watch.mjs doctor
```

---

## 1. ffmpeg（必装）

陪看自己不解码，解码全在 `dsh-video-storyboard` 里，用的是 `ffmpeg` / `ffprobe`。

查找顺序（不用改系统 PATH 也能用）：

1. `DSH_FFMPEG_PATH` / `FFMPEG_PATH`（指向 `ffmpeg.exe`）
2. `DSH_FFMPEG_DIR`（指向 `bin` 目录）
3. `$DSH_HOME/tools/ffmpeg/bin`、`$DSH_HOME/bin`
4. `PATH`

```jsonc
// ~/.dsh/video.json（可选，覆盖查找顺序）
{ "ffmpeg": "D:/tools/ffmpeg/bin/ffmpeg.exe" }
```

验证：

```bash
ffmpeg -version
node bin/watch.mjs doctor      # 看 ffmpeg 那一行是不是 OK
```

> `ffplay` 是 `ffmpeg` 自带的 **播放器**，声音适配器用它放音。装 ffmpeg 时别只拷
> `ffmpeg.exe` 一个文件 —— `ffplay.exe` 不在就放不出声（会退回系统声音）。

---

## 2. 字幕：有 CC 用 CC，没有才 ASR

台词的锚点是"这句话第几秒开始说"，这个数字只能来自字幕或 ASR —— **不能用段边界估**，
估出来的时间点会早十几秒，用户当场就能看出来。

优先级：**B 站 CC 字幕（`ai-zh` 优先）→ 同目录 `.srt/.ass` → ASR**。

### 2.1 B 站 cookies

有 cookies 才能拿到字幕和视频。两种来源：

```jsonc
// ~/.dsh/video.json
{ "cookies": "C:/Users/你/.dsh/bili-cookies.txt" }   // Netscape 格式
```

或者环境变量 `DSH_VIDEO_COOKIES`。没配时插件会尝试**从浏览器直接读**（开着浏览器就行）：

```bash
node bin/watch.mjs login        # 从浏览器读 cookie 落盘 + 验一下登录态
```

cookie 文件是**凭证**，不要提交进任何仓库（本仓库的 `.gitignore` 已经排掉了
`.secrets/`、`cookies.txt`、`cookies-*.txt`）。

### 2.2 yt-dlp

```bash
pip install -U yt-dlp
# 或者单独放一个 exe，然后指过去：
# DSH_YTDLP_PATH=D:/tools/yt-dlp.exe
```

查找顺序：`DSH_YTDLP_PATH` → `PATH`。验证：

```bash
node bin/watch.mjs subs 0 60     # 能打出句子时间轴就说明整条链路通了
```

### 2.3 ASR 服务（可选，没字幕时才需要）

没有 CC 字幕的片子（很多直播切片、录屏、本地文件）靠 ASR 给句子时间码。默认走
**OpenAI 兼容接口**：`POST {baseUrl}/audio/transcriptions`，`model` 自己填。

```jsonc
// ~/.dsh/asr.json
{
  "baseUrl": "http://127.0.0.1:8000/v1",
  "key": "local-key",
  "model": "paraformer-zh-2024-03-09",
  "language": "zh",

  // 可选：术语校正（错误写法 → 正确写法），专有名词很有效
  "terms": { "四零六零": "RTX 4060" },
  // 可选：热词，交给支持偏置的模型
  "hotwords": "星际争霸 显卡 帧率",

  // 可选：让插件顺手**托管这个服务**（不在跑就拉起来，空闲就退）
  "manage": {
    "start": ["D:/asr-local/.venv/Scripts/python.exe", "D:/asr-local/server-sherpa.py"],
    "idleMs": 5000,
    "waitMs": 60000
  }
}
```

| 字段 | 说明 |
|---|---|
| `baseUrl` | 兼容 OpenAI 的地址，**带 `/v1`** |
| `key` | 放在文件里，或者用环境变量 `DSH_ASR_KEY`（桌面版读不到 setx，优先写文件） |
| `model` | 服务端认的名字；云服务例：`FunAudioLLM/SenseVoiceSmall` |
| `manage.start` | 命令行数组。**必须写绝对路径**，插件不会帮你找 Python |
| `manage.idleMs` | 空闲多久自动退（省内存） |

`asr.json` 改完**立刻生效**（按文件 mtime 重读），不用重启宿主。

> 本机 ASR 很吃内存（paraformer 常驻约 3.5 GB）。**别和剪辑软件同开**，内存提交耗尽会
> 直接把桌面拖崩。

---

## 3. 播放位置（最影响体感的一项）

位置只有一个来源：你正在看的那个页面里 `<video>` 的 `currentTime`。把它取出来有两条路。

### 3.1 浏览器扩展（推荐，一次装好永久用）

```bash
node bin/watch.mjs install-extension     # 或者双击 scripts/install-extension.cmd
```

命令会把扩展复制到一个固定目录、把路径放进剪贴板、打开扩展管理页，然后**一直等**你装完；
装好它会自己打「✓ 扩展装上了」，你播个视频它再打「✅ 全部完成」。
手把手的截图级步骤见 [BRIDGE.zh.md](./BRIDGE.zh.md)。

它为什么能工作：扩展在页面里读 `currentTime`，**每秒** POST 到 `http://127.0.0.1:9377/api/position`。

- 这个 9377 服务由插件（或 `node bin/watch.mjs chat`）起；**没起服务时扩展上报会失败**，
  popup 里会直接写「连不上 127.0.0.1:9377」。
- 只上报**当前可见标签页**的位置，所以开两个视频页不会互相打架。
- 上报内容只有：`pos / dur / title / url / paused / ended`。**不读页面内容，不发外网。**

验证：

```bash
node bin/watch.mjs doctor            # 「扩展」那一行有没有心跳时间
node bin/watch.mjs bridge            # 前台盯着收到什么（Ctrl+C 退出）
```

### 3.2 调试端口（备用：不想装扩展 / 扩展读不到的站点）

Chromium 136 之后**不允许在默认 profile 上开调试端口**，所以这条路必须开一个**专用窗口**
（有独立 `user-data-dir`，第一次要在里面登录 B 站）：

```bash
scripts/start-edge-debug.cmd          # 端口 9333
scripts/start-edge-debug.cmd 9444     # 换端口
```

```jsonc
// ~/.dsh/video.json
{ "browserPort": 9333 }
```

> **别用 9222**：那是 DevTools 的惯例端口，很多 Electron 应用（包括 WorkBuddy）就占着它，
> 连过去读到的是别人的界面。

两条通道都通时，插件**优先用扩展**（更新更勤，每秒一次 vs 每 15 秒一次）。

---

## 4. 声音（想让台词念出来才配）

核心**不带任何 TTS 引擎**：它只在正确的播放时刻把台词作为事件发出去。
"念"是外挂，由适配器负责。

### 4.1 挂一个适配器

```jsonc
// ~/.dsh/voice.json
{ "adapter": "D:/code/dsh-watch-together/examples/voice-edge-tts/index.mjs" }
```

或者环境变量 `DSH_VOICE_ADAPTER`。也可以写成包名（`"my-voice-adapter"`）。
挂不上只写一行 warn，**不影响插件启动**。

自带一个能直接用的：`examples/voice-edge-tts` —— edge-tts 合成 → `ffplay` 播放 →
失败退回 Windows 系统声音。它每句会在 stderr 打一行时间码，调试时比音频本身还有用：

```
[voice 03:11.4] 钓上来了，池子里那条比他想的配合。
```

### 4.2 音色 / 引擎

```jsonc
// ~/.dsh/tts.json —— **适配器自己的配置**，核心不读
{
  "voice": "zh-CN-XiaoxuanNeural",
  "rate": 0,
  "edgeTts": "C:/Users/你/.workbuddy/binaries/python/envs/tts/Scripts/edge-tts.exe"
}
```

```bash
pip install edge-tts          # 或者装进一个 venv，把 edge-tts.exe 路径写进 edgeTts
node bin/watch.mjs say "试一下声音"
node bin/watch.mjs voices     # 列出可选音色（不联网的那几个是系统声音）
```

`rate` 是**语速偏移**（-10 ~ 10），不是"每秒几个字"。

### 4.3 它的节奏是怎么控制的

台词按视频位置逐句发，但**声音引擎是串行的**（一句念完才轮到下一句）。所以：

- 上一句还在念时，下一句**不会**被塞进去排队（排队会让声音越拖越远）；
- 拖过迟到宽限（3 秒）的那句直接作废 —— **宁可少说一句，也不要越说越晚**；
- 适配器自己也有兜底：排队超过 3.5 秒就放弃这一句，并发一条 `skipped` 事件，
  悬浮窗据此**不显示**这句（没出声的字不该出现在屏幕上）。

想让它少丢词：让模型每段少写两句（交付说明里会给出每句落点和"太密"的警告）。

---

## 5. 悬浮窗（可选）

`examples/floating-chat/window.py` 是个真·独立悬浮窗：无边框、置顶、半透明、拖动、回车发送。

```bash
pythonw examples/floating-chat/window.py     # 无控制台
```

- 必须用**带 tkinter 的 Python**：python.org 官方安装包勾上 tcl/tk；Windows 商店版自带。
- 想用「麦」按钮（语音输入）还需要 `sounddevice` + `numpy`：
  `pip install sounddevice numpy`；缺了只是按钮不可用，窗口照常。
- 它和网页版（<http://127.0.0.1:9377/>）读的是同一个 `chat.jsonl`，两个一起开也不打架。

---

## 6. 文件都落在哪

| 东西 | 路径 | 说明 |
|---|---|---|
| 聊天流 | `<cache>/chat.jsonl` | 台词 / 插话 / 你说的话，一个文件三种 role |
| 陪看状态 | `<cache>/watch.json` | 看到哪、每段台词队列、素材账本 |
| 播放位置 | `<cache>/position.json` | 扩展每秒上报，5 秒过期 |
| 字幕缓存 | `<cache>/subs-<key>.json` | 同一支片子只抓一次（`--refresh` 强制重抓） |
| 测量延迟 | `<cache>/latency.json` | 自动标定的"读进度→交付"耗时 |
| 分镜产物 | `$WATCH_OUT` 或 `~/.dsh/watch/out` | CLI 出的宫格 PNG / 清单 md |

`<cache>` 在 Windows 是 `%LOCALAPPDATA%\dsh-video-storyboard\cache`，
可用 `DSH_VIDEO_CACHE_DIR` 覆盖（测试/多套配置时很有用）。

想清干净：删掉这个目录即可（`watch.json` 和 `chat.jsonl` 都会重建）。

---

## 7. 一页排错

| 症状 | 先看这里 |
|---|---|
| 一张图都出不来 | `doctor` 里 ffmpeg 那行；`DSH_FFMPEG_PATH` 指到 `ffmpeg.exe` |
| 台词"比画面早" | `doctor` 里位置那行；扩展没上报就会外推，外推会偏 |
| 台词一句都没有 | 段里没写词 → 交付说明会写 `[DELIVERY INCOMPLETE]`；或字幕没取到（§2） |
| 有字没声 | `~/.dsh/voice.json` 的 `adapter` 路径；`node bin/watch.mjs say "测试"` |
| 声音越来越晚 | 台词太密。这是设计上的取舍：**少说一句，而不是越说越晚**（§4.3） |
| 悬浮窗打不开 | 用的是不是带 tkinter 的 Python（托管版没有） |
| 扩展装了没反应 | 9377 服务没起：`node bin/watch.mjs bridge` 或让插件跑起来 |
| 位置读不到 | 扩展停用了 / 页签切走了 / 专用窗口关了（`doctor` 会分别说） |

更多：`node bin/watch.mjs help`（CLI 全部子命令）、[BRIDGE.zh.md](./BRIDGE.zh.md)（扩展安装）、
[VOICE.zh.md](./VOICE.zh.md)（声音适配器怎么写）。
