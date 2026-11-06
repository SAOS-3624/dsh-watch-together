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

### 运行时端口

`src/runtime-ports.js` 是核心模块取接口的唯一入口：

```js
import { installPorts, getTtsPort, getWindowPort } from 'dsh-watch-together/public-api';

installPorts({ tts: api.tts, window: api.window }); // 组合根注入
getTtsPort().due({ at: 12, text: '...' });
getWindowPort().message({ role: 'assistant', text: '...' });
```

`chat-store.js` / `watch-loop.js` / `watch-actions.js` / `input-surface.js`
只 import 这个端口模块，不再 import `voice.js`、`floating-window.js` 或
`window-protocol.js`。没有注入时端口提供历史默认实现（speech-bus + 自带
Python 窗口），所以 CLI 和既有测试行为不变。

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
改名、折叠、入场动画、气泡、meta、发送）。玻璃由独立模块渲染，各层不知道
对方存在：

| 文件 | 职责 |
|---|---|
| `glass_geometry.py` | 一套尺寸的全部贴图：玻璃遮罩、边缘折射坐标、内框透镜、染色层。`Geometry` 是不可变值对象；气泡变宽用 `with_shapes()` 换一个新对象，尺寸相关的图直接复用 |
| `glass_capture.py` | 抓屏（外扩 PAD、零尺寸守卫、录屏模式挖掉自己）、`MotionTracker`（静态跳帧 + 运动强度，**拖动窗口也算动**）、麦克风图标、圆角收尾 |
| `glass_cpu.py` | CPU 合成：1/4 缩小 → 高斯 → 边缘折射 → 内框透镜 → 2x 合成 → 染色 → 色散 → 残影 |
| `glass_gpu.py` | 同一件事在 moderngl 上做；`native=True` 时走全分辨率采样 |
| `glass_static.py` | 不吃性能的两档：`frost`（预生成的磨砂底板：冷色渐变 + 细噪点 + 1px 亮边）、`solid`（纯色）。**不抓屏**，只在尺寸/气泡形状变化时重画一张 |
| `window.py` | 上面的编排 + Tk 窗口、聊天流、交互 |
| `window_widgets.py` | `Fonts`（字体缓存）、`ChatFeed`（chat.jsonl 增量视图）、`TextLayer`（逐字翻色） |

两条运行路径输出逐像素一致（同一背景均差 0.07、99% 像素差 ≤1）。切后端：

| 开关 | 效果 |
|---|---|
| 默认 | CPU |
| `DSH_GLASS_GPU=1` | GPU（1/4 采样） |
| `DSH_GLASS_NATIVE=1` | GPU + 全分辨率采样（边缘透镜没有 1/4 放大的像素感） |
| `python glass_window_gpu.py` | 等价于 `DSH_GLASS_GPU=1` 起窗 |
| `DSH_GLASS_MAX_FPS=120` | 把目标帧率上限从默认 60 抬到 120（更费 CPU；120fps 的抓屏+合成预算只有 8.3ms） |

样式预设走 `~/.dsh/watch-window.json` 的 `glass`（设置页可改，热切换）：

| 值 | 效果 |
|---|---|
| 不写 / `auto` | 远程/录屏 → `solid`，其余 → `live` |
| `live` | 实时玻璃（抓屏 + 模糊） |
| `frost` | 静态磨砂，不抓屏；换尺寸/气泡才重画（约 11ms） |
| `solid` | 纯色底板，不抓屏、不设 WDA |

`DSH_GLASS_LIVE=1` / `DSH_GLASS_FROST=1` / `DSH_GLASS_SOLID=1` 只对这一次启动强制指定。

GPU 需要 `moderngl` 和 OpenGL 3.3；起不来时会打印一行原因并回落到 CPU，
窗口照开。`DSH_GLASS_WDA=0` 可关闭抓屏排除，方便录屏/截图；
`DSH_GLASS_PREVIEW=1` 是纯预览模式；`GLASS_FORCE=1` 每帧强制重合成（调试很费 CPU）。

> 拆分前这里是单文件 1931 行，`W/H/SHAPES/MASK/OVERLAY/WARP_X/BOX_MAPS` 十几个
> 模块级全局靠 `global` 在 `rebuild_geometry()` 里一起改写，GPU 还得
> `import glass_window as G` 去读它们 —— 窗口一缩放就可能拿到上一帧的坐标。
> 现在全部收进 `Geometry`，谁要什么就传进去。

## 4. 兼容性

- 没有 `window-events.jsonl`：窗口继续增量读 `chat.jsonl`。
- 没有 Python 窗口：浏览器前端读同一份 `chat.jsonl`，不受影响。
- 没有 TTS 订阅者：`tts.due()` 返回事件但没人念，陪看照常。
- 旧版 `createWatchInterfaces` 调用方：`watchTools` 的 `interfaces` 参数可
  选，不传就创建默认组合。
