# 接口与解耦（0.2.0+）

这个版本把三件事拆开了：**识别**（找视频/建分镜）、**声音**（TTS/语音总
线）、**悬浮窗**（谁显示、显示成什么样）。陪看循环不再直接 import 其中任何
一个实现，只调用 `src/interfaces.js` 暴露的三个接口。

## 1. 组合根

```js
import { createWatchInterfaces } from 'dsh-watch-together/interfaces';

const api = createWatchInterfaces();
api.recognition.segment(args);     // 识别
api.recognition.manifest(result);  // 清单文本
api.window.message(entry);         // 窗口消息
api.window.meta(text);             // 系统行
api.window.control('rename', '新名字');
api.tts.due({ at, segment, ... }); // 声音事件
```

`register.js` 在注册工具时创建一份，`handler.js` 每次执行可以注入自己的
`interfaces`；测试或伴生插件不需要启动真实窗口/识别器。

| 接口 | 模块 | 版本常量 | 职责 |
|---|---|---|---|
| `recognition` | `src/recognition-interface.js` | `RECOGNITION_INTERFACE_VERSION` | `segment` / `manifest` / `cues` |
| `tts` | `src/tts-interface.js` | `TTS_INTERFACE_VERSION` | 订阅、到点台词、已念/跳过、适配器 |
| `window` | `src/window-interface.js` | `WINDOW_INTERFACE_VERSION` | 开/关/藏、消息、系统行、控制、TTS 事件、动作回读 |

每个接口都是 frozen 对象；缺少依赖时在**创建时**报错（`recognition` 缺
`runStoryboard` 等），而不是陪看跑到一半才炸。

## 2. 窗口线协议

窗口实现不需要 import 插件代码，只读写两个 JSONL 文件（默认在
`dsh-video-storyboard/cache`，`DSH_VIDEO_CACHE_DIR` 可覆盖）：

| 文件 | 方向 | 一行 |
|---|---|---|
| `window-events.jsonl` | 插件 → 窗口 | `{"v":1,"type":"message|meta|control|tts", ...}` |
| `window-outbox.jsonl` | 窗口 → 插件 | `{"v":1,"type":"say|rename|collapse|...", ...}` |

消息事件保留 `role/text/at/t`，与 `chat.jsonl` 相同。窗口按
`(role, text, at)` 去重，所以迁移期间 `chat.jsonl` 和协议流同时存在也不会
出现两遍；旧版插件仍然只写 `chat.jsonl` 时，窗口也能正常工作。

Node 侧：`src/window-protocol.js`（`appendWindowEvent` /
`readWindowActions`）。Python 侧：`examples/floating-chat/window_protocol.py`
（`WindowProtocol`）。两边只共享线格式，不共享实现。

## 3. 悬浮窗样式

`examples/floating-chat/window.py` 是交互外壳（位置/拖动/缩放、麦克风、
改名、折叠、入场动画、气泡、meta、发送）。玻璃由独立模块渲染：

底稿直接是 PR #15 的 `glass_window.py`（现名 `window.py`），没有另写一套
近似样式。两条运行路径形式完全一致：

| 入口 | 实现 | 说明 |
|---|---|---|
| `window.py` | PR #15 的 CPU 实时捕获/模糊/透镜 | 默认；三块玻璃、气泡、位置、麦克风都来自这份 |
| `glass_window_gpu.py` | PR #15 的 GPU 伴生 | `import glass_window as G`，只把每帧捕获→模糊→折射→合成搬到 GPU；UI/交互仍是同一份 |

GPU 需要 `moderngl` 和 OpenGL 3.3；没有就继续用 CPU 入口。`DSH_GLASS_WDA=0`
可关闭抓屏排除，方便录屏/截图；`DSH_GLASS_PREVIEW=1` 是纯预览模式。

## 4. 兼容性

- 没有 `window-events.jsonl`：窗口继续增量读 `chat.jsonl`。
- 没有 Python 窗口：浏览器前端读同一份 `chat.jsonl`，不受影响。
- 没有 TTS 订阅者：`tts.due()` 返回事件但没人念，陪看照常。
- 旧版 `createWatchInterfaces` 调用方：`watchTools` 的 `interfaces` 参数可
  选，不传就创建默认组合。
