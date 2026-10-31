# 声音 / 语音播报 使用教程

> 这一篇只讲一件事：**怎么让陪看把到点的台词念出声来**，以及怎么换成你喜欢的音色（比如微软晓萱）。
> 看完这篇，你应该能做到：跑一次陪看，到点的台词用你选的音色念出来。
>
> 配套文档：整体玩法看 [`WATCH.zh.md`](./WATCH.zh.md)，浏览器接入看 [`BRIDGE.zh.md`](./BRIDGE.zh.md)。

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

- **开发模式（你自己 clone 的源码）**：`<仓库>/dsh-watch-together/examples/voice-edge-tts/index.mjs`
  - 你现在的路径就是 `D:/deepseek/3-Life/dsh-watch-together/examples/voice-edge-tts/index.mjs`
- **装成 npm 包后**：`<项目>/node_modules/dsh-watch-together/examples/voice-edge-tts/index.mjs`

下面两步都用这个**绝对路径**。

### 第 2 步：挂载适配器（写 `voice.json`）

新建（或覆盖）`~/.dsh/voice.json`，内容就一行路径：

```json
{
  "adapter": "D:/deepseek/3-Life/dsh-watch-together/examples/voice-edge-tts/index.mjs"
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
加一个 ffplay 启动，短句也要 0.6~2 秒）。悬浮窗里的台词等的是 `spoken`：

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

- `state`：`'due'` = 到点该念；其它状态（如已念过、被插话覆盖）忽略。
- `text`：要念的台词。
- `at`：墙钟毫秒时间戳（用来打时间码，不是播放位置）。

---

## 7. 排错表

| 现象 | 原因 | 怎么办 |
|---|---|---|
| 完全没声音，stderr 也没有 `[voice …]` 行 | 适配器没挂上 | 查 `~/.dsh/voice.json` 是否存在、`adapter` 路径对不对（用绝对路径最稳） |
| 有 `[voice …]` 日志，但听不到声音 | edge-tts 没装 或 ffplay 没有，已退到系统声音但系统声音也被占 | 看 stderr 有没有 `[voice] edge-tts 没找到，退回系统声音`；装 edge-tts / 确认 ffplay 在 PATH |
| 出声了，但音色不对（不是晓萱） | `tts.json` 的 `voice` 没写对，或被别的文件覆盖 | 确认 `~/.dsh/tts.json` 里 `voice` 是 `zh-CN-XiaoxuanNeural`；跑 `node watch.mjs voices` 核对 |
| 想确认现在用的是不是晓萱 | —— | 跑 `node watch.mjs say "测试"`，听音色 |
| `doctor` 说一切正常，但就是没声音 | 正常——`doctor` 不查声音 | 以 stderr 的 `[voice …]` 为准 |
| 改了 `tts.json` 没生效 | 没重启陪看 | 重启陪看进程 |
