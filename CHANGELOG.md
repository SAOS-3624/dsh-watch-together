# Changelog

All notable changes to **dsh-watch-together** are documented here.
This package starts its own version line at `0.0.7` — it is not a continuation of `dsh-video-storyboard`.

## [0.2.11] - 2026-11-03

> 悬浮窗从头拆了一遍（单文件 1931 行 → 五层），顺带修掉 GPU 路径三个真 bug。

### Changed — 玻璃拆成四层，去掉全部模块级可变全局

`window.py` 原来 1931 行，`W / H / SHAPES / MASK / MASK_HARD / OVERLAY /
OVERLAY_2X / WARP_X / WARP_Y / BOX_MAPS / HW / HH / BOX_UNION_2X / MIC_POS`
十几个模块级全局靠 `global` 在 `rebuild_geometry()` 里一次性改写；GPU 伴生
文件还得 `import glass_window as G` 去读它们，窗口一缩放就可能拿到上一帧的坐标。

| 文件 | 职责 |
|---|---|
| `glass_geometry.py` | 一套尺寸的全部贴图。`Geometry` 是不可变值对象，气泡变宽用 `with_shapes()` 换新对象，尺寸相关的遮罩/折射图直接复用 |
| `glass_capture.py` | 抓屏、`MotionTracker`、麦克风贴图、圆角收尾 —— CPU/GPU 共用一份 |
| `glass_cpu.py` | CPU 合成管线 |
| `glass_gpu.py` | 同一件事在 moderngl 上做 |
| `window.py` | 编排 + Tk 窗口 + 交互 |
| `window_widgets.py` | `Fonts` / `ChatFeed` / `TextLayer` |

顺手清掉的死代码和重复逻辑：

- `_add_text_shadows()` 是空实现，`_text_shadows` 有 11 处引用但永远是空的；
- `_hide_window()` 定义了但没有任何调用点；`EDGE_MASK` 算出来没人用；
- `_fit_lines` / `_text` 对每个字重新 `measure()` 一遍前缀 —— O(n²) 次 Tcl 调用，
  改成累积宽度；
- 每来一条消息就 `Entry.destroy()` 重建（丢输入法状态和光标），改成复用一个；
- `_preview_resize` / `_rebuild` / `_refresh_feed` 三份几乎相同的「清状态 + 重排 +
  贴图」；
- `tkfont.Font(...)` 每帧新建几百个 Tcl 对象 → `Fonts` 按尺寸缓存。

### Fixed — GPU 版的 OpenGL context 建在错误的线程上（每帧 `cannot create texture`）

`GpuRenderer` 原来在主线程构造。`moderngl.create_standalone_context()` 绑在创建
它的线程上，而 `render()` 跑在抓屏 worker 线程 —— 每帧抛 `cannot create texture`，
被 `_work()` 吞掉后只打印一行、窗口始终没有玻璃（截图里只剩文字浮在桌面上）。

改成首次 `render()` 时惰性创建（那时已经在 worker 线程）；真起不来就打印原因并
回落 CPU，不刷屏。

### Fixed — GPU 版在录屏模式下没挖掉自己（`moved` 恒真、永不跳帧）

`CaptureSource.to_image()` 会 `fill_own_rect()`，但 GPU 直接吃 `shot.bgra`、
绕过了那一步 —— 背景里永远带着本窗口，`moved` 每帧为真：静态跳帧一次都不触发，
还叠出自我反馈的拖尾（0.2.7 修过同一个坑，只修了 CPU 侧）。补了数组版
`fill_own_rect_array()`。

实测 700×665 / 150% DPI / 同一桌面、同一条消息：

| | CPU 版 | GPU 版（修前） | GPU 版（修后） |
|---|---|---|---|
| CPU | 43.2% 单核 | 87.9% | **32.1%** |
| 内存 | 93 MB | 195 MB | 193 MB |

### Fixed — `DSH_GLASS_NATIVE=1` 一直是个假开关

`run-glass.cmd` 写着「走 GPU 路径」，但 `window.py` 从来没 import 过
`glass_window_gpu` —— 设了只是让 CPU 路径去读一个没人用的变量。现在
`DSH_GLASS_GPU=1` / `DSH_GLASS_NATIVE=1` 真的选后端；`glass_window_gpu.py`
仍可单独起窗（等价于 `DSH_GLASS_GPU=1`）。

### Fixed — GPU 版拖动窗口没有运动模糊、反而做静止才该做的色散

0.2.9 修的 `box_changed → moved` 只落在 CPU 路径上，GPU 那份还是老判断。现在
两条路径共用 `MotionTracker`，同一个判断只有一处实现。

### Fixed — GPU 版形状变化后混入上一帧残影

`_invalidate_glass()` 只清了 CPU 的 `_prev_out`，GPU 的 `_prev_valid` 还留着。
现在几何一变统一走 `renderer.invalidate()`，两边一起清。

### Fixed — 折叠时 `slabs_for()` 算出负高度矩形

折叠后窗口只有 78px，`bot = (o, h-o-70, ...)` 的 y0 大于 y1，PIL 直接抛
`y1 must be greater than or equal to y0` —— 点一下 ▾ 就 traceback。高度不够时
只返回标题栏那一块。

### Performance

- 高斯从 PIL `ImageFilter.GaussianBlur` 换成 `cv2.GaussianBlur`（有 OpenCV 时）；
- GPU 首次渲染 **1137 ms → 79 ms**（几何贴图改用 cv2 缩放，不再 PIL 逐通道）；
- 静止时的探针从 60fps 降到 30fps —— 单次 `grab()` 就要 7ms，空转等于白烧
  40% 单核；有变化时 `idle` 立刻归零、下一拍恢复全速；
- 文字翻色从「每个字 `crop()` + `np.percentile`」改成整帧转一次灰度再切片。

### 验证

- 视觉：同一背景同一消息，新旧玻璃帧逐像素对比 **均差 0.068、99% 像素差 ≤1**；
- 交互：折叠 / 展开 / 拖动 / 边缘缩放 / 滚轮 / 改名 / 发送 / 新消息增量 / 关闭
  全部实跑通过（810×625 与 760×560、折叠 78px 三种尺寸）；
- `node scripts/check-syntax.mjs` 56 files ok；`node --test` **317 pass / 0 fail**。

## [0.2.10] - 2026-11-03

> GPU 路径其实一直是坏的，顺便量了一下它到底省不省。

### Fixed — GPU 路径的 GLSL 用了保留字，着色器从来没编译成功过

`glass_window_gpu.py` 的 FRAG 里有一行 `vec3 patch = mix(edgep, strong, e);`。
`patch` 是 GLSL 1.5 起保留的 tessellation 关键字，编译直接失败：

```
GLSL Compiler failed
ERROR: 0:24: 'patch' : syntax error
```

`_work()` 里那句 `except` 把异常吞掉、每帧打一行 `GPU capture failed, falling back to CPU`，
然后继续走 CPU —— **所以 `glass_window_gpu.py` 从来没真正跑起来过**，用户能看到的最大线索
就是一句每帧刷屏的日志。更糟的是它每帧重建一次 program/FBO 又失败，实测内存涨到 **2.3 GB**。

改个名（`patch` → `tile`）。修完日志干净、内存 200 MB、画面和 CPU 版一致。

### 实测 — GPU 不比 CPU 省（这台机器上）

i9-12900HX / RTX 4060 Laptop / 窗口 700×665 / 150% DPI / 静态桌面：

| 路径 | CPU（单核） | 内存 |
|---|---|---|
| CPU（正常模式） | **49.6%** | 100 MB |
| GPU（`glass_window_gpu.py`） | 115.6% | 200 MB |
| CPU（`GLASS_FORCE=1`，调试） | 146% | 111 MB |

两边都有静态跳帧，GPU 多出来的是每帧把 BGRA 上传成纹理（约 2.6 MB/帧）+ moderngl 的
Python 层调用开销；而 CPU 版在这么小的窗口上本来就够快。GPU 路径更适合「窗口很大 + CPU 较弱」，
不是无脑更优 —— **默认继续用 CPU**。

## [0.2.9] - 2026-11-03

> 一条根因修得很漂亮的 bug：拖动窗口时的动态模糊。

### Fixed — 拖动窗口没有动态模糊（合 PR #49，作者 @ggfgfgf-on，对应 #48）

现象是「`GLASS_FORCE=1` 下能看到那种黏黏的拖尾，正常启动看不到」，我一开始以为是
`_motion_blur` 的衰减公式问题 —— 猜错了。

真正的原因在这行：

```python
if self._sig is not None and box == self._sig_bbox and sig.shape == self._sig.shape:
```

拖动窗口时抓取区域 `box = (gl, gt, gr, gb)` 每帧都在变，`box == self._sig_bbox` 永远不成立，
`moved` 一直是 `False`。于是：

- `_motion_blur` 一路乘 0.55 衰减到 0，混合那步一次都不执行；
- 反而每帧都在做 `apply_chroma(panel, 1.7)`（那是「没在动」时的色散补偿）。

`FORCE` 之所以看起来有效，只是因为它跳过静态跳帧、帧数更多，更容易凑出连续可混合的帧 ——
它并没有修掉这个判断。

现在 `_sig_bbox` 已存在且 `box` 变了，就把这一帧标成 `moved = True`：抓取区域变了，
旧区域的像素本来也不能直接做差，但这确实是运动。静止窗口仍走原来的像素差判断，
不会变成常驻拖影。和 #42 不冲突 —— `_invalidate_glass()` 会把 `_sig_bbox` 清成 `None`，
形状变化后的第一帧不会误判成 `box_changed`。

### 说明 — 静止画面下没有动态模糊是设计

同一轮确认：`if moved` 这层是故意留的，运动模糊不是常驻滤镜。静止时混上一帧只会把文字和边缘
永久糊一层，还会让 `_motion_blur` 维持在高位，停下后回不到清晰；CPU 每帧做一次 `Image.blend` 也不便宜。

想要「低速拖尾」可以做配置项（类似 `motionBlurFloor`，默认 0），但不改默认行为。

## [0.2.8] - 2026-11-03

> 三个社区 PR（都是 @ggfgfgf-on）+ 一批失效入口的清理。

### Fixed — 多 P / 选集页面读错 `<video>`（合 PR #45，对应 #44）

旧实现按 `duration` 挑播放器，遇到 B 站多语言版本这种页面，会挑中一个隐藏的 13 分钟长视频，
上报的 `pos` 直接跳到 13:42，插件判定「换片了」，陪看中断。

新逻辑：先排除不可见 / 零尺寸 / `opacity: 0` 的候选，再按在视口里占据的面积排序；
播放中只加一档权重（不能压过更大的主播放器）；认画中画和全屏；整页都不可见才退回全部。

### Fixed — 气泡形状变化后不重合成（合 PR #42）

静态跳帧只看 `_sig_bbox`，只清 `_sig` 不够。气泡/内框形状变了之后，如果桌面本身静止，
worker 会一直 `return None`，新遮罩和新色散要等用户动一下鼠标才出现。
`FORCE` 模式下看不出来，只在真机静置时暴露。

### Fixed — `_tick` 每 4ms 重读一次配置（合 PR #47，fixes #46）

`not capturable()` 每拍读一次 `watch-window.json` —— `__init__` 早就把结果缓存在
`self._cappable` 了，这里纯属白花。0.2.7 引入的疏漏，谢谢抓出来。

### Fixed — 删掉失效的 `run-glass*.cmd`，并去掉里面的本机绝对路径（#43）

玻璃渲染重写之后 `DSH_WATCH_GLASS_TTL/FPS/CHROMA/BLUR/SAT` 和 `DSH_GLASS_ACRYLIC`
已经没有任何代码读取，但那几个脚本还在设置它们：双击 `run-glass-acrylic.cmd` 以为开了
亚克力，实际还是普通软件模糊。静默失效比报错更糟。

现在只留一个 `run-glass.cmd`，开头列清哪些变量废弃、哪些真正有效；解释器也不再写死
本机路径（先找 PATH 上的 `pythonw`，再退 `py -3`）—— 这个仓库是公开的。

## [0.2.7] - 2026-11-03

> 五个社区 PR 一起收（都是 @ggfgfgf-on 提的），外加录屏模式的两个真 bug。

### Fixed — 录屏/截图根本拍不到窗口

窗口一直开着 `WDA_EXCLUDEFROMCAPTURE`（防截图/直播泄露，这是对的），
但社区贡献者要调玻璃管线就必须能录。原来只有环境变量 `DSH_GLASS_WDA=0` 一个入口，
**而插件拉起窗口时不会传环境变量** —— 于是用户在 `~/.dsh/watch-window.json` 里写了
`"capturable": true` 也没人读，录出来永远是空桌面。

现在 `capturable()` 真的读配置：环境变量（临时）→ 配置项（持久）→ 默认排除。

### Fixed — 录屏模式下"字一直在闪"、拖尾越滚越浓

`capturable: true` 关掉 WDA 之后，**mss 抓背景时把窗口自己也抓进去了**。玻璃拿它当背景
等于"透过自己看自己"，形成反馈回路：背景里带着上一帧的字 → 亮度判据一直抖 → 字色来回翻；
背景一直在变 → `moved` 一直为真 → 一直混合上一帧 → 越滚越浓的假拖尾（静止画面也在"动"）。

现在录屏模式下把窗口矩形用**周边均值**刷平（试过按上下边缘插值，相邻列颜色不同会变成
一根根竖条，更难看）。窗口外 PAD 一圈仍是真背景，边缘透镜照常。
实测同一位置连续 6 帧：帧差从"每次都在变"降到 **0.00**。

### Added — 窗口心跳

`<cache>/window-heartbeat`，`_tick` 里每秒最多写一次。宿主那侧靠它区分"进程还在"和
"窗口真的在画"——只看 pid 的话，pid 被复用或界面卡死时永远认为窗还开着，于是再也不重开。

### Fixed — GPU 抓屏越界（合 PR #40，作者 @ggfgfgf-on，fixes #39）

GPU 路径的 `capture_gpu()` 有自己一份 `sct.grab()`，没做 `gr-gl/gb-gt` 守卫；
窗口被拖出屏幕时每帧抛 `Region has zero or negative size`，被 `_work()` 吞掉后背景永久停在旧帧。
补上和 CPU 路径一样的检查。

### Fixed — 台词 `at: null` 被存成第 0 秒（合 PR #38，作者 @ggfgfgf-on）

`Number(null) === 0`，显式写 `at: null` 的台词全被当成"第 0 秒"，回读时挤在片头。

### Fixed — 本机 API 的 CORS 与聊天游标（合 PR #35，作者 @ggfgfgf-on，fixes #33 #34）

- 聊天/位置 API 原来对**任意网页**放开 CORS，可被跨站写入；改成只认白名单。
- `chat.jsonl` 被清短之后，聊天页的游标永久卡在越界位置；改成越界自动归零。
- 新增 `test/chat-server-guards.test.mjs`。

### Fixed — 卸载时没 detach voice adapter（合 PR #31，作者 @ggfgfgf-on，fixes #30）

适配器订阅了 speech bus，插件卸载却没退订 —— `speechSubscribers()` 一直 > 0，
重载后循环误以为"有人会念"，模型再也不会被叫醒。

### Added — 设置页自动保存（合 PR #32，作者 @ggfgfgf-on）

改一项存一项，不用再点保存；顺带补了声音环境变量提示与连接状态。

## [0.2.6] - 2026-11-02

> 陪看的声音还差最后一步：到点才开始合成。这一轮把"合成"从关键路径上挪开。

### Added — `scheduled` 事件（合 PR #36，作者 @ggfgfgf-on）

- 循环每一拍把**未来 60 秒内、已经写好且带 `at`** 的台词以 `scheduled` 广播一次（每句一次；
  只在有会出声的订阅者时发）。它不参与"该不该念"的判断，只给适配器时间预合成。
- `upcomingLines(input, { after, before })`：只读的"未来台词"查询，不消费稿件。

### Changed — 示例适配器预合成

- `examples/voice-edge-tts`：`speakEdge` 拆成 `synthEdge`（只合成）+ `playEdge`（播放并删临时文件）；
  `scheduled` 到达即合成，按 `input|segment|text` 缓存（上限 6 条，满时踢 `at` 最远的一条），
  `due` 优先播缓存。日志多出 `prefetched` / `synth`、`ready Nms`、`wait Nms`。
- `MAX_QUEUE_LAG_MS` 的计时从 `due` **到达**起算，合成时间本来就算在里面 ——
  预取因此还降低了"排队太久被丢弃"的概率，不只是首声早一点。

### Fixed — 评审补丁（`5fa1307`、`bd5b3c7`）

- **跨段时缓存 key 对不上**：`dueLine` 跨段挑 `at` 最小的一句，选中上一段的句子时 `due` 报的却是
  当前段，和 `scheduled` 的 `segment` 不一致 → 缓存白做、首声又晚回 0.6~2 秒。
  `dueLine({ meta: true })` 现在多返回 `from`，`speak()` 用它。
- **`Number(null) === 0`**：没写 `at` 的台词会被当成"at=0"挤进预取窗口；适配器 `prefetch()` 同理，
  6 个槽位被 at=0 占满后永久失效。两处都改成显式判空。

## [0.2.5] - 2026-11-02

> 0.2.4 里 PR #28 留下的两个 GPU 尾巴，作者当天补了 PR #29 收掉，外加气泡留白微调。

### Fixed — GPU 内框边缘（合 PR #29，作者 @ggfgfgf-on）

- **底部输入/发送框发黑**：内框边缘原来直接拿 `small` 的 render target 当 sampler，
  贴边小框会采到边界外。现在单独拷一份 blur(1.45) 到 `edgeblur` FBO 再采样
  （注释里写明「直接当 sampler 会触发驱动崩溃」，所以宁可多一次 copy）。
- **内框边缘的折射/扭曲丢了**：CPU 里 `edge_w=0` 是边缘（取折射样本）、`=1` 是中心
  （取强模糊），Shader 里方向是反的。改成 `mix(edgep, strong, e)` 后恢复。

### Changed — 气泡留白

- 横向 14→18，纵向 `+4`→`+16`，正文按 `(bh - lines*ls)/2` 垂直居中。
  字不再贴着气泡边，短消息也不会挤成一条。

## [0.2.4] - 2026-11-02

> 0.2.3 发出去 20 分钟就发了这个 —— 因为它带着一个肉眼可见的毛病：
> **气泡里的字会一直黑白闪**。另外收了社区 PR #28。

### Fixed — 字一直在黑白闪

气泡是透明的，背后就是桌面/视频/网页。`_adapt_text` 每 0.12 秒按
`p50 < 0.50` **硬切**白字 `#f2f8ff` / 深字 `#07111d`，画面一动亮度就在阈值附近
来回穿 —— 同一段抖动序列 **16 次采样翻 15 次**，肉眼就是"字一直在闪"。
（这段逻辑 0.2.1 就在，只是 0.2.3 的气泡更透、更容易撞上。）

- **滞回**：白的要暗到 0.38 才翻深，深的要亮到 0.62 才翻白，中间的 0.38~0.62 保持现状。
- **连续两次同向才切**：单帧跳变忽略，最坏 0.24 秒换一次色。
- 顶部细条同样处理（0.48 硬切 → 0.36/0.60 滞回），并在 `_build_ui` 重建时把
  `_bar_color` 归位，免得条和缓存对不上。
- 结果：同样 16 次抖动翻 **0 次**；真·明暗切换仍然生效（慢一个采样周期）。

### Changed — 玻璃合成管线（合 PR #28，作者 @ggfgfgf-on）

- **小框边缘不再硬切**：气泡/输入框边缘原来直接用未模糊的 raw、中心却是
  blur(2.6)，中间二值 edge 一刀切，有一圈"割裂"。现在边缘走 blur 1.45 的帧，
  再用 smoothstep 过渡。GPU 侧同步；贴边小框仍从 raw 取（用 warped 会采到边界外
  的黑边，底部输入/发送框会发黑）。
- **CPU 补齐 GPU 才有的效果**：外缘 R/B 径向色散（2x 合成图上做，索引图按尺寸缓存，
  缩放重建时释放）、上一帧运动混合。GPU 的 `blend` 改成只在检测到移动时混，
  停下立刻干净；移动帧跳过色散，先保住拖动/滚动响应。
- **麦克风回到玻璃帧合成**（`MIC_POS` / `MIC_LIGHT` / `MIC_DARK`），不再在 Canvas
  上单独建图。这是回退 0.2.3 里 #22 的 Canvas 方案 —— 好处是位置与上游仓库对齐、
  会被玻璃一起处理；代价是依赖合成帧。
- **消息气泡改成自适应宽高**：按正文实测折行，时间戳移到气泡上方不再进框，
  替掉 #22 的固定 88px 四框。短消息不再撑满整行。
- 兼容层改动态代理，GPU 能看到缩放/气泡的新坐标；缩放重建时释放色散索引缓存。

> 验证：311 测试全绿；清空 `chat.jsonl` 冷启动实跑，1 条短消息 / 4 条混合长度
> （含多行、超长）都正常渲染，输入/发送框无发黑。

## [0.2.3] - 2026-11-02

> 主题：**悬浮窗这一轮收口** —— 社区提的 #22 / #23 / #25 / #26 / #27 全部合进来，
> 核心与 TTS / 悬浮窗之间的依赖收成 `runtime-ports`。
> 播放位置、台词锚点、语音调度这些**一处没动**；变的只有窗口和它下面那层接口。

### Added — 核心只认 runtime-ports（合 PR #22）

- 新增 `src/runtime-ports.js`：**唯一**给出 TTS / 悬浮窗适配器的地方。
  `chat-store` / `watch-loop` / `watch-actions` / `input-surface` 不再直接
  `import` `voice.js` / `floating-window.js` / `window-protocol.js`。
- `installPorts()` / `resetPorts()` / `getTtsPort()` / `getWindowPort()` 从 `public-api` 导出，
  宿主或测试可以注入自己的实现；裸 `import` 仍拿历史默认（speech bus + 内置窗口），
  CLI 和老测试照旧能跑。
- `test/decoupling.test.mjs` 守这条线：核心模块一旦直接依赖实现就红。

### Changed — 悬浮窗气泡与折叠重做（合 PR #22）

- **气泡改成「时间头 + 正文折行」**：`_fit_lines()` 按框宽/框高折行，标点不落行首，
  超长截断加省略号；四条气泡统一 88px 并吃满内容宽度，不再为了塞下文字把字号压到 9。
- **折叠不再重建整窗几何**：只缩窗口 + 只画标题栏。原来 `rebuild_geometry(78)` 会在
  `rounded_mask` 抛 `y1 must be >= y0`，**折叠直接异常**（main 上可复现）。
- **每 1.8 秒重新置顶一次**：DSH 抢焦点后浮窗不再被压下去。
- **麦克风改 Canvas 矢量图标**，不再往合成帧上贴第二层；GPU 路径同步去掉。
- 补三处收尾：空态分支还在用已删掉的 `bh` → 清空 `chat.jsonl` 冷启动直接 `NameError`，
  窗口起不来；标题改回**双击**改名（单击要留给按住拖动）；折叠态跳过抓屏，
  否则遮罩尺寸不符会每帧刷一条 `images do not match`。

### Fixed

- **拖到屏幕外不再花屏**（合 PR #23）—— `_x` / `_y` 只在启动时读一次，拖动后已过期；
  加上越界钳位后仍可能算出 0 或负的抓屏尺寸，`mss` 抛 `Region has zero or negative size`，
  异常在 `_work()` 里被吞掉只打一行的结果是：每帧一条日志、背景永远画不出来。
  现在拖动/缩放分支都钳位，并在抓屏前直接挡掉非正尺寸。
- **`window` 接口的 hide/show 兼容只返回布尔的实现**（合 PR #25）—— 以前拿返回值当对象解构，
  实现只回 `true` 时 `hide` 变成静默失败。
- **snapshot 模式不再被 `_tick` 重新打开 WDA**（合 PR #26）—— worker 已暂停，
  下一拍却把 WDA 开回来，窗口再次从截图/录屏里消失，`_snapshot_mode` 等于没做。
- **折叠不再跳回原位、折叠背景有圆角、标题栏排版收紧**（合 PR #27）——
  `_sync_pos()` 在 `_release` 与 `toggle_collapse` 前同步真实坐标（`_x/_y` 过期会让窗口弹回启动位置）；
  折叠态按 78px 重新贴圆角遮罩，不再直接裁 `_last_frame` 留一条硬边；
  `_save_geometry` 存**展开高度**，否则下次启动按 78px 恢复；折叠时 `_tick` 不再消费旧队列，
  避免 560px 的帧贴回 78px 画布闪一下；状态点/名字/计数统一到 y=38 中线，字号 21→16。
  实测对照 main：拖到 (300,220) 折叠后停在 (300,220)、配置写 `760x560+300+220`，
  main 会跳回 (1720,480) 并写 `760x78`。

### Docs

- **README 挂上赞赏码**（微信，`docs/images/reward-qr.png`）。写法上明确一句：
  打赏**不解锁任何东西**，也不影响这个项目以后的授权方式 —— 它仍然是 Apache-2.0。

## [0.2.2] - 2026-11-01

只改元数据，不动行为。

- `package.json` 补 `dsh.catalog`（category / 中英双语 summary / capabilities）——
  社区插件市场直接读 npm 上带 `dsh-plugin` 关键词的包，每天同步一次、没有提交入口；
  有 `dsh.catalog` 时市场页面展示的是这里写的分类和摘要，没有就退回 npm description。

## [0.2.1] - 2026-11-01

两项都是从社区审计（#18 / #16）来的，各配了回归用例。

### Added — 插件设置页（合 PR #11, closes #10）

设置直接渲染在 DSH 插件详情页（`plugins.bundle.config`），不再用 iframe / 内嵌滚动窗口；
「设置 → 内置插件」的 tab 也还在。

- 表单：`browserPort`（共享 `video.json`）、`chatPort`（`watch.json`）、语音适配器（`voice.json`）。
- **依赖自检**：ffmpeg/ffprobe、Python、`dsh-video-storyboard`、浏览器扩展、悬浮窗脚本；
  缺什么就直接给官方下载入口，已装的显示「已安装」。插件**不会**静默安装或替你执行下载。
- 修核心包误报：`dsh-video-storyboard/package.json` 不在 `exports` 里，改成解析 `dist` 信息。

### Changed — 悬浮窗换成实时捕获管线，模块拆成接口（合 PR #20）

- **窗口实现换代**：`examples/floating-chat/window.py` 以 PR #15 的实时捕获管线为底稿重写
  （1454 行，原 3372 行）。每帧抓屏 → 1/4 尺度模糊 → SDF 边缘折射 → 透镜采样 → 合成，
  静帧时整条管线跳过。**依赖变化**：`mss` 和 `numpy` 从可选变必需，缺了窗口起不来。
- **保留并补齐交互**：双击标题改名、▾ 折叠/展开、系统行（meta）、发送回写、位置保存、
  麦克风图标、滑入动画。输入框仍是"画布上画字 + 2×2 的 Entry 只收 IME/键盘"。
- **模块解耦**：`src/interfaces.js` 组合识别 / TTS / 悬浮窗三个接口，`handler.js` 与
  `watch-loop.js` 只调接口、不再直接 import 实现（`docs/INTERFACES.zh.md`）。
- **窗口线协议**：插件写 `window-events.jsonl`、窗口写 `window-outbox.jsonl`，
  Python 侧 `window_protocol.py` 只共享线格式；旧版只写 `chat.jsonl` 时窗口继续兼容。

### Fixed — 无音轨视频不再卡在"缺台词"门槛（fixes #18）

`noListen` 之前只改了文案，**没有参与 `hasLines`** —— 无可等台词时 `segLines` 为空，
`hasLines` 恒为 false，于是 `spoken` / `lastDelivered` 都不写，每次调用都落回同一段、
永远带 `[DELIVERY INCOMPLETE]`。这不是"模型不肯写台词"，是状态机不推进。

- `noLinesNeeded = Boolean(noListen)` 参与 `hasLines`：没音轨 / 没配 ASR / 连不上 / 这段真静音时，
  画面这一半就算交付完成。
- 没有台词可等时**不再提示"先取字幕"**（取了也不会有），也不说"本段台词已就绪"。
- `[听音]` 段补一句"这一段也没有台词可等，用你看见的画面说一句即可，别编对白"。
- **普通视频的台词门槛保持原样**：有声有字幕但没写台词，仍然 `complete=false`。

### Fixed — 叫醒失败不再刷屏，确定性失败不再空等（fixes #16）

`no-session-controller`（当前进程没有 DSH 会话控制器）和 `no-session-id` 是**确定性**失败，
以前每次都要等 800ms 再重试，并且每次都往 `chat.jsonl` 写一条 `[一起看] 叫醒失败`；
持续故障时悬浮窗会被几十条一样的 meta 刷满。

- 这两类失败**不重试**；其他偶发失败仍重试一次。
- 失败提示按 `(sessionId, reason)` 节流：**60 秒内只显示第一条**，静默期里折叠掉的次数
  在下一次显示时带上（"同类失败另有 19 次已折叠"）。
- `no-session-controller` 的提示补一句可行动的说明（从 DSH 里启动，或先关掉陪看循环）。

## [0.2.0] - 2026-11-01

这一版把悬浮窗的玻璃重做了。三块独立玻璃、底色真正跟着背景走、静帧不空转、
边缘不再是"放大贴纸"而是把框外画面折进来；同时把「听不到声音」这件事从
"模型答不上来"变成"能直接说清原因"。

### 听不到声音，不再只有一个答案

用户反馈（2026-11-01，B 站评论区）：「能看视频，但是听不了」「没有音轨」。
文档里写清楚了要装 ASR，但**运行时没有任何地方告诉用户这件事** —— 模型只能回一句"我听不到"，
用户于是以为插件坏了（同一个问题在评论区被问了十几遍）。

- `explainCuesFailure()`：把每种原因翻成**一句能直接说给用户听的话**（没配 ASR / 装了连不上 /
  这份副本没音轨 / 听了但没说话 / 字幕要登录）。`transcriptOnly` 的返回和陪看交付共用这一份文案，
  不再各写一遍。
- `asrCues` **不再把"没配 key"和"服务连不上"糊成 `asr-empty`**（那是"这片子没人说话"，
  一个会误导人的结论）。没配 key 时连请求都不发 —— 以前会照发，401 被吞掉。
- 陪看交付新增 `[听音]` 段（同一部片子只详说一次，之后一句短的）：用户问"你怎么听不到声音"时，
  模型手里终于有依据。**没句子时门槛改成"用画面说一句、别编对白"**，而不是硬逼出一段台词。
- 修 `findCachedMedia`：拿不到 BV 号时原来会 `return video` —— 返回媒体目录里碰到的**第一个**
  `video.mp4`，于是拿**另一部片子**的音轨去转写。台词全错，而且一句都不报。

### 玻璃底色跟着背景走

用户原话：「太卡顿，而且刷新很慢……经常是背景换了，液态玻璃还没动，还没变颜色。」

根因不在渲染算法，在**缓存永不过期**：整屏截图只在开窗那一刻做一次（`_stage` 的注释还写着
"之后无论拖到哪儿都是裁一刀"），所以对面视频换场景、桌面换壁纸，这块玻璃永远是开窗时的颜色。
拖动结束后那个"8 秒才值得重截"的判定也救不了**静止**的窗口 —— 而陪看时窗口恰恰是静止的。

现在：

- **按 TTL 定时重截**（`DSH_WATCH_GLASS_TTL`，默认 **600ms**，0 = 关掉回到旧行为）。
- **截屏在子线程**（抓屏 + 1/4 缩放 + 模糊 + 色散 + 提饱和），主线程只做裁片 + 贴图（1~2ms）。
  Tk 对象一个都不在子线程碰 —— 屏幕尺寸、缩放系数都在主线程读好再传。
- **优先用 `mss` 抓屏**（可选依赖，见 `examples/floating-chat/requirements-glass.txt`）：
  整屏 38ms vs ImageGrab 71ms，全管线从 ~200ms 降到 ~98ms，所以 TTL 才敢压到 600ms。
  没装就自动退回 ImageGrab。
- **新增 `_repaint_glass()`：只换玻璃不动内容**。`_paint()` 末尾会 `_reflow()` 重排所有气泡，
  为了换一层底色付这个代价不值得；现在只 `delete("panel")` 再贴一张。
- `_glass_busy` 防重入：上一发没回来就跳过这一拍；窗口隐藏/折叠时根本不截。

实测（本机 2560×1600 / 150% 缩放，TTL=500ms）：3 秒内 6 次截屏，底板时间戳推进 3.3 秒，稳定。
抓屏基准：mss 38.3ms / ImageGrab 71.0ms；mss 全管线（抓 + 1/4 缩 + 模糊）98.6ms。

**依赖**：Pillow + 可选 `mss`（**0.1MB**、纯 Python 无编译）。numpy 不需要。

**踩到的坑**：第一版把 `_glass_ttl_start()` 插进了 `poll()` 末尾（那个方法每 200ms 自己再排一次），
于是每拍都重启一条定时链 —— 实测 3.2 秒触发 16 次、截屏频率飙到 9Hz。加了 `_glass_started` 锁。

### 液态玻璃重做（本轮）

三块**分离**的玻璃（标题栏 / 主体 / 输入栏，中间 10px 真缝，缝里透出桌面），
滚动条移到主体右侧外面，不占消息区。

- **`WDA_EXCLUDEFROMCAPTURE`**：让窗口从屏幕捕获里消失，于是抓"自己背后"时
  **不用把 `-alpha` 设 0 再恢复** —— 那个来回会逼 DWM 把整个桌面重排两次，
  视频在播时最贵，肉眼就是"松手闪一下"。`DSH_GLASS_WDA=0` 可关（录屏要用）。
- **静帧跳帧**：用未模糊的原图缩到 48×30 比灰度差，`mean>0.8` 才算动了；
  没动且运动已停 0.3 秒就直接复用上一帧，整条管线（抓屏 17ms + 糊 + 色散）全跳过。
  慢速滚动不会先停一两帧 —— 阈值比"定时到点就重算"灵敏。
- **边缘折射换成 SDF 法线向外采样**：老做法是"整图放大一点、再按边缘权重把放大版盖回"，
  边缘看到的是**自己被放大的内容**，像贴了层凸透镜贴纸。现在沿圆角矩形 signed distance
  field 的梯度法线**向外**取样本，边上一窄条里塞的是**框外**的画面，被压扁折进来。
- **底板 1/8 → 1/4**：1/8 放大 8 倍时边缘和背景细节都发虚。
- **文字可读性**：新增 `text_on_glass()`（整段文字 + 右下 1px 深色影子）和
  `on_glass_fill()`（按那个点的背景亮度决定用浅字还是深字）。影子用在气泡正文、
  标题栏名字、系统行、输入槽；翻色用在标题栏名字。
  **没有逐字建 item** —— 玻璃上几十像素内明暗本来就不变，整段取一次样就够，
  长列表滚动时 item 数不翻倍。

**依赖**：Pillow + 可选 `mss`；**numpy 也是可选**（只给 SDF 折射用，没装自动退回老折射）。

### 参考并移植了上游的 PR

- **#13 `feat/liquid-glass-speed`**：O(n²) → O(n) 的追加优化（只 layout 新气泡、resize debounce 70ms、
  Configure 合并到 16ms、after_idle 批量、mtime 缓存、玻璃尺寸没变不重画、拖动只画边框）。
  它的数据是 210 条消息从 14.22s 降到 605ms（23×）。**这次没合**：那个 PR 基于 1314 行的旧
  `window.py`，我们这边已经 2632 行（液态玻璃二版 + 本轮改动），冲突面太大；但思路（尤其
  "玻璃尺寸没变不重画"）以后可以逐条移植。
- **#15 `feat/live-glass-window`**：独立一套 `glass_window.py` / `glass_window_gpu.py`。
  **没有整包拿过来**（它是第二套 UI，切过去会丢掉气泡、meta、入场动画、折叠、改名这些交互），
  而是逐项移植了它的机制：`WDA_EXCLUDEFROMCAPTURE`、静帧跳帧、SDF 法线折射、1/4 底板、
  文字影子与按背景翻色。GPU 合成（moderngl）没有采用 —— 需要额外依赖且仅限 Windows/OpenGL 3.3+。

## [0.1.1] - 2026-11-01
**依赖升到 `dsh-video-storyboard@^0.6.0`。** 分镜从"固定宫格"改成"档位排布"——
一格 = 一个镜头、格子大小跟切点密度走，`boardOptions()` 返回的参数从
`cells / sheets / minGap` 换成 `maxFrames / maxSheets / minFrames`。旧的参数名在 0.6.0 里已经不存在，
所以这一版**必须**配 0.6.0 及以上，不能和 0.5.x 混装。

### 台词写完之后不再递整段清单（防剧透）

用户反馈"老是剧透后面的"。根因不是提示词不够狠：写台词时必须把整段 5 分钟的清单交出去，
写完它仍然留在上下文里，模型就会把它当成"我知道后面"的凭据 —— 光说"不许提"压不住真实内容。
现在台词一就绪就换成一句简报（"台词已就绪，清单不再提供"），模型手里真的没有后面的信息。

顺带在提示词里加了一句自问：「这句话是不是只有已经看过 xx 秒之后的人才写得出来？」
不确定的事用"现在"而不是"接下来"。

### Liquid glass, second pass — the window was still ugly (2026-11-01, later)

Verbatim feedback: "看一下 watch-together 的悬浮窗设计，太丑了现在" — the first liquid-glass pass
had the vocabulary right and the physics wrong. Five defects, all of them visible in a screenshot:

**The corners were not round.** `round_rect` and `squircle_mask` both used a superellipse with
`n = 5`, and at `n = 5` the curve is within 0.6% of the straight edge until the last few pixels —
a 22px radius rendered as a near-square corner with a tiny fillet. `squircle_mask` had a second,
independent bug: the row-solve was inverted (`x` grew from 0 instead of `r`), which cut the corners
out as *squares*. Both now use `n ≈ 2.2` and solve each row's span directly (O(h) instead of O(w·h),
and it buys 2× supersampling for free).

**The chrome was opaque.** The header was a `tk.Frame` and the composer a second one; Tk widgets
must have an opaque background, so the top and bottom strips of a "glass" window were dead black.
Both are now drawn on the canvas (status dot, title, count, `▾`/`✕` as hit-tested canvas items,
the input well as a rounded polygon). Only the `Entry` stays a real widget — it has to be opaque, so
it lives inside a deliberate *inset* well.

**Bubbles were paper.** Each one was filled with a flat `#3a4459`. They are now cut from the same
blurred backdrop as the panel (`plate()`), with only a white/blue wash on top — they transmit what
is behind them.

**Tint was global and blue.** One tint for the whole window, and a blue-grey `#171a21`, which fights
every colourful frame it sits on. Tint is now per-plate and *neutral*: measure that plate's mean
luminance and solve for "how opaque does the ink need to be to land under 84" (`a = (L-84)/(L-12)`).
Over a white page it darkens itself; over a dark scene it stays transparent.

**The sheen was made of lines.** Diagonals stacked with a 3px step left a visible weave across the
panel. Every gradient is now computed on a 16×16 canvas and upscaled bicubically.

Also added: **dispersion** (warm outside, cool inside, full strength around the whole chamfer and
stronger at the four corners, because a fillet has curvature everywhere but compound curvature at
the corners), **edge fading** in the message list (rows fade in/out across a 30px band instead of
popping at the clip boundary — suppressed on the side that has no more content, otherwise the newest
message is permanently the faintest), a **200ms entrance** per new bubble (8 frames: 10px rise +
alpha ramp + text colour lerp), and **smooth scrolling** (5 frames × 16ms) so the fade band has
something to fade across. The scrollbar moved out into the margin beside the panel.

Two long-standing bugs fell out of this: `Meta.paint` ended with a leftover `self.cv.tag_lower("bg")`
from the pre-canvas version — `Meta` has no `cv`, so the exception aborted `_reflow` mid-list and only
the newest message was ever visible; and the backdrop image was created after the messages without
`tag_lower`, so any repaint buried them.

### Performance — the glass was re-baked on every frame (2026-11-01, same session)

"背景的模糊还是很卡" — measured, not guessed. One panel plate cost **520ms**, a slab 90ms,
a bubble 28ms. The culprit was `_ring`: it built **two full-size fill masks and subtracted them**,
and every plate needs five or six rings (rim, soft rim, bottom shade, warm, cool, edge weight), so
a 665×594 panel spent ~100ms in that one function plus ~15ms per `squircle_mask`.

Three fixes, in order of payoff:

- **Ring solved per row, no intermediate images.** A ring's row is just two short segments — left
  and right — so the inner and outer x are solved directly (`_ring`), and middle rows are skipped
  entirely. O(h) instead of O(w·h), and no subtraction allocations. 100ms → 3.7ms.
- **Everything smooth is computed at ¼ scale.** `_corner_weight`, `_edge_weight` and `refract`'s
  bevel weight are soft blobs, not features: build them at 665/4 and upscale bilinearly. Gaussian
  blur cost drops 16×, and the bevel mask (14 rectangle outlines over the full image) went from
  ~20ms to ~1ms.
- **Supersampled masks now downsample with `Image.BOX`** instead of LANCZOS. For an exact 2×
  reduction BOX *is* the 2×2 average — same result, ~4× faster. `squircle_mask` 15ms → 4.9ms.

Result: panel 520 → **50ms**, slab 90 → **6.8ms**, bubble 28 → **8ms**; `_paint` with a warm cache
**1.3ms**, `_reflow` **0.5ms**, cold repaint (backdrop changed) **76ms**, window open **387ms**.

Also: the R/B channel-scaled displacement (`chroma_edge`) is now **off by default**
(`DSH_WATCH_CHROMA_EDGE=1` turns it back on). It cost two full-size channel resizes per plate
(+18ms) and was invisible — the backdrop is already blurred and inked, so there is no contrast left
at the rim to disperse. The visible dispersion is the warm-outside/cool-inside tint pair, which stays.

Finally, resizing no longer re-bakes: while the resize grip is held the panel is a bilinear scale of
the last baked plate (1.2ms instead of 50ms), and a precise re-bake happens 300ms after release.

### Performance, second pass — the backdrop was recomputed on every mouse release (2026-11-01)

"超级卡，绝对不止一两百毫秒" … "拖动根本不会刷新" … "碰到屏幕边缘松手百分百闪一下".

Measured, the picture was different from the first pass: `_paint` was already fast (1.3ms warm),
but **every time a drag or resize settled**, `_refresh_backdrop` cost **165ms** — and during the drag
the backdrop never updated at all, because refresh was debounced to 420ms after release.

What was actually slow, in order of payoff:

- **`_ring` built two full-size fill masks and subtracted them**, and every plate needs five or six
  rings. Rewritten to solve each row's inner and outer x directly and draw two short segments —
  O(h), no intermediate allocations. 100ms → 3.7ms per plate. (While rewriting it I dropped the
  `width` argument on the floor: the band came out as "from the edge to `inset`", which made a
  1px highlight vanish entirely and pushed the inner shade line onto the rim, darkening it. The
  tell was "the glass has no edge and looks grey". Fixed by solving both boundaries properly.)
- **Everything smooth is now built at ¼ scale and upscaled**: curvature weight, dispersion weight,
  and the bevel weight in `refract`. They are blobs, not detail. Gaussian cost drops 16×.
- **The "light" layers are pure geometry** — sheen, rim, inner shade, warm/cool fringes do not
  depend on the backdrop at all. They are composed once per size into `_light_overlay` and cached;
  a re-bake now pays one `alpha_composite` instead of six.
- Tint and wash are both flat colours over flat colours, so they are blended into a single colour
  and applied once. Mean luminance is measured on a 48×48 copy (the mean does not care about
  resolution). 2× supersampled masks downsample with `Image.BOX` instead of LANCZOS.
- **The stage is now one full-screen capture at ¼ resolution**, taken at open while the window is
  still withdrawn. Any later position is a *crop*, never a re-grab — the old "window + margin"
  stage ran out of bounds whenever the widget was near a screen edge, and falling out of bounds
  is exactly the "release → hitch → flash" the user was seeing.
- **Dragging refreshes live**: `_live_backdrop()` crops from the stage and `_paint_glass_only()`
  swaps only the panel and the two slabs — the header, bubbles and composer do not move relative
  to the window and are not redrawn. Throttled to 30ms (the mouse is 120Hz). Two hidden costs fell
  out of this: `_window_rect()` calls `update_idletasks()`, which silently ran a *full* repaint on
  every frame (+17ms), and position-only `<Configure>` events repainted the entire window.
- Bubble plates are invalidated by their own counter (`chat_glass_ver`), so a small drag no longer
  re-bakes six bubbles per frame; only panel/slab caches are dropped.
- Edge-of-screen windows now only need to *overlap* the stage, not sit inside it; the off-screen
  part is cropped short and padded. And a settle within 8s of the last capture does not re-capture
  at all — the stage is refreshed for free while the window is hidden.

Numbers (665×594 panel, 150% DPI): a panel plate 520ms → **7.7ms**, slab 90 → **0.9ms**, bubble
28 → **0.9ms**; `_paint` warm 1.3ms, `_reflow` 0.5ms; **dragging costs 24–28ms per frame (~38fps)
where it used to be frozen**; window open 510ms including the full-screen stage.

### Fixed — optional services must go through `ctx.get()`

`ctx?.attachments?.saveImage` looks like a runtime probe but throws in a real host: cordis's `ctx`
is a Proxy whose `get` trap **throws** `cannot get property "xxx" without inject` when a service was
not declared in `inject`. `?.` only guards `null`/`undefined`, not exceptions.

All optional-service lookups now go through `serviceOf(ctx, name)` (in `src/timer.js`): it prefers
`ctx.get(name)` — cordis's documented way to ask for an optional dependency, returning `undefined`
when absent — and only falls back to property access inside a `try`.

### Liquid-glass window, one stream, and a name you can change (2026-11-01)

Reported as: the scripted lines (warm amber, with a "台词" label) and the assistant's replies (cool
grey, labelled "陪看") read like two different people talking in one stream — and the window itself
looked like a plain dark panel.

**One stream, one look.** `ROLE` now maps `line` and `assistant` to the *same* colours, and the head
line shows **only the timestamp** — no "台词", no "陪看". Only the user's own messages keep a tint
(so you can still tell which side you are on).

**Timestamps are wall-clock now** (`HH:MM:SS`), for every role. Scripted lines used to show their
playback position (`01:26.0`) while everything else showed local time — two time bases in one
stream, so reading it meant converting in your head. Seconds are included because a segment runs
2–5 minutes and several messages share the same minute; `HH:MM` alone would make the stamps useless
for telling them apart. A message with no `at` gets no head line at all (an empty label still eats
a full line of height).

**Liquid glass.** Three things carry the effect, because tkinter cannot blur what is behind it:

- **24px+ radius** — and `round_rect` no longer uses `smooth=True`, which renders a 22px radius as
  roughly 14px (it smooths a polygon rather than following an arc). It now samples each corner arc
  directly.
- **A refractive edge**: a 1px inner highlight along the top, plus an outer border split into a lit
  upper half and a shadowed lower half — what a real piece of glass does.
- **Slight window transparency** (`-alpha 0.975`, `DSH_WATCH_GLASS_ALPHA` to tune, ≥1 disables).
  The desktop shows through just enough to read as glass without competing with the text.

Buttons and the input field are **pills** now (`Pill` class + a Canvas-backed field): a square
"发送" button next to a 24px-rounded panel was the most obviously un-Apple thing left.

**The title is editable.** Click the name in the header, type, press Enter — saved as `name` in
`~/.dsh/watch-window.json` and restored next launch. Committing uses an explicit `_editing` flag
rather than `winfo_ismapped()`, which is still `False` on the frame right after `pack()` and would
silently swallow a fast Enter.

**Fixed:** `meta` entries (wake failures, mic status) were falling through to the assistant bubble
style — a screenful of `[一起看] 叫醒失败` rendered as full-size cards. They now use the grey
one-line `Meta` row that already existed for exactly this.

**Fixed:** the saved geometry was clamped against `sw - 120` instead of the window's own width, so a
700px-wide window could be restored 580px off the right edge.

### No more self-made "queued messages", one reminder per interjection, and a hideable window (2026-11-01)

Reported as three things that turned out to be one root cause plus two design gaps.

**The queue strip.** `wakeSession` delivers through `agent.followup()`, which lands in the host
inbox's `next-turn`. DSH's `QueueDock` renders **every** row of `next-turn` and does not filter by
`source.kind` — so the plugin's own instructions showed up in the input box as pending messages the
user never typed ("插话栏自动出现"). Two consequences fixed here:

- **The hangup note no longer goes through `followup`.** Closing the window is still a hangup (clock
  stops, nothing is rebuilt, no lines are spoken), but the explanation is now written into
  `watch.json` and handed to the model on its next tool result (`takeHangupNote`). The watch loop
  already has the model blocked inside an interrupted tool call, so nothing is lost — and the queue
  strip stays empty. `markHungUp(input, env, note)` carries the text; taking it clears it.
- **`[未回应]` is emitted once per interjection.** It used to be appended to *every* tool result
  until the model answered with `say`, so one message from the user could be read as three separate
  events ("大肥鱼已经重复了"). `noteInterjected` also no longer restarts the clock when the same
  sentence arrives twice inside the 3-minute TTL.
- **The interjection prompt is two sentences, not a wall of ⚠️.** Same requirements
  (`say` first, `speakNow`, lines in the same call), a fifth of the length — it is rendered in the
  queue strip, so its size is user-visible.

### `window: "hide" | "show"` — put the window away without ending the watch

Closing the window means "I am done watching". Hiding it does not: the process stays alive, the
clock keeps running, lines keep being spoken, nothing is marked as hung up. Reported as
"如果有其他功能隐藏悬浮窗会更好".

- `watch_together({ window: "hide" })` writes `hidden: true` into `~/.dsh/watch-window.json`;
  `window.py` polls its config every 200 ms (`_sync_visible`) and does `withdraw()` / `deiconify()`.
  `withdraw` rather than `iconify`: an always-on-top floating window should leave no taskbar entry
  behind.
- `openFloatingWindow` clears `hidden` **before any early return**, so a window that was hidden when
  the process died does not come back invisible.

### Two-track prefetch (2026-11-01) — subtitles no longer wait for the pictures

The picture side is the slow one: a segment costs a download plus a scan (10–20 s, 20–90 s for the
first), while the text for the same window arrives in a few seconds (site CC: instant; local ASR
RTF 0.019 ≈ 6 s per 5-minute segment). They used to be produced and delivered as one package, so
the text sat in the slow batch's shadow. Now they are two independent tracks over the **same**
batch table and the **same** look-ahead window.

- **New subtitle track** (`transcribe` → `dsh-video-storyboard/transcript-pass`). Mirrors the picture
  track line for line: same `plan.indexAt` / `windowAt`, its own `transcribed` set. "Whoever's window
  is full stops first" falls out of `find()` returning `undefined` — no extra rule.
- **Two-part delivery.** When the text lands before its pictures, it is sent on its own
  (`[一起来看·台词] 03:00–06:00` + one timestamped sentence per line). When the picture batch
  arrives later it is built with `omitTranscript`, so the cells carry only times and the sentences are
  not repeated (measured: 17k vs 26k tokens per 2 hours, +50% when repeated).
- **`feedTranscriptLeadMs`** (default 0 = send as soon as it lands). Raise it to ~20000 if the
  two-part delivery feels chatty and you would rather wait for one combined message.
- **`transcriptTrack: false`** turns the whole track off.
- **Failures don't sink the loop.** A failed transcription is not marked as done, so the next tick
  retries; three failures in a row blacklist that segment for 10 minutes (a missing ASR service
  should not be hit every 2 seconds). The picture track is never blocked by it.
- **Cross-track timestamps now share one clock.** `transcribedAt` / blacklist times were stamped with
  `Date.now()` while the tick compares against the injectable `deps.now()`; the difference was
  negative by a trillion milliseconds, so the "skip for 10 minutes" and "wait N ms before feeding"
  gates were both permanently bypassed (feeding never fired at all).

### Experience pass (2026-11-01) — the minutes spent staring at nothing

Same code, same contract; what changes is what the user sees (or hears) while waiting.

- **A slow build now says something.** The first batch of a film needs a download plus a scan
  (20–90 s) and a tool call cannot speak — so the window stayed empty and the only signal was
  silence. After 4 s of building (`DSH_WATCH_SLOW_BUILD_MS`) one `meta` line is appended to the
  stream: 「正在取 03:00–06:00 这一段…」. Fast segments write nothing.
- **The measured latency is finally used on the main path.** `latency.js` has been calibrating
  "read position → result ready" for a while, but only the background clock (`shouldSpeak`) spent it;
  the blocking call still waited until `segment end - lead`, so on the same machine the clock spoke
  early and the tool call spoke late. `deliveryState` now uses `lead + aheadSeconds`, while the text
  still reports `lead` (what is pulled earlier is the work, not the sentence).
- **Calibration only counts deliveries.** Not-yet calls take tens of milliseconds and are not samples;
  recording them dragged the EWMA towards zero (and wrote `latency.json` on every poll).
- **The last batch is delivered at the tail.** The final segment's due point is `end - lead`, which for
  the last batch sits past the end of the film — the position never reaches it, so the user watched
  the ending and got nothing. Reaching/passing `dur - 1` now counts as due.
- **`speech` only lists lines that are still ahead.** It used to echo the whole draft, including the
  lines the same call had just pruned as past — the model read them as "still going to be spoken".
- **Delivery guidance trimmed ~45%** (≈1150 → ≈640 chars). It is resent every batch; the loop/pacing
  rules already live in the tool description, so only the hard rules stay here: write the lines,
  no spoilers, one sentence, `say` is the only visible channel.

### Reading pass over the loop (2026-11-01) — six real bugs, one hot path

No new features. Everything below was found by reading the code against its own comments and then
reproducing it; each fix carries a regression test that fails on the old code.

- **`lastDelivered: null` was read as batch 0.** A delivery blocked by the "no lines yet" gate writes
  `lastDelivered: null`, and `Number(null)` is `0` — exactly the first batch's start. That batch then
  counted as already delivered forever: `wait: true` woke up and answered "already delivered", image
  and manifest never handed over. Empty now stays `NaN`.
- **Same film, two URL forms → the loop restarted.** `samePlan` compared the raw `input` string, but the
  extension reports `…/BV1g3xN6hEuw/?trackid=…&spm_id_from=…` while the model usually holds the clean
  link. Every second call therefore looked like a new source, wiping `spoken` and re-waking segments
  that had already been delivered. It now compares `sessionKey()`.
- **`dur: null` became `0 s` on the bridge path.** `Number.isFinite(Number(s.dur))` passes for `null`,
  so a report without a duration set the baseline to 0; the next real reading (600 s) then differed by
  more than a second and was judged "video changed" — the clock stopped mid-film. `num()` in
  `position-bridge.js` and the baseline update now treat empty as empty.
- **`waitForVideo` lost the hangup.** The input surface is prepared once (`prepared ??=`), and the
  early pre-warm for `waitForVideo` passed no arguments — so `input`/`open` never reached it. Without
  `input` the recorded hangup could not be matched, the window was re-opened, and the call went off to
  wait for a video instead of returning `[hangup]`.
- **`dueLine` rewrote `watch.json` on every tick.** Its `dirty` flag was shared across segments: once one
  batch had pinned its un-timed lines, every later batch was written back unchanged — a full state write
  every 2 s for the rest of the film. The flag is per segment now.
- **`waitUntil` / `waitForRefill` lied about why they stopped.** Breaking out because the user paused (or
  the film ended) still produced "waited to the cap". The text now names the real reason.

Hot path, same area:

- `cachedCues()` re-read and re-parsed the whole subtitle file on every tick (`dueLine` asks several
  times per tick). It is memoised on `path + size + mtime` now, and returns the **same array** so that
  `makeLagFn`'s memo can be keyed on array identity. `makeLagFn` additionally sorts once and looks up
  by binary search instead of a linear scan of every cue. 2000 cues × 5400 lookups: **66.7 ms → 0.8 ms**
  (×83), and the disk read/parse per tick is gone.
- `lines-util.js` had its own `cacheDir()` that fell back to `~/AppData/Local` on every platform, so on
  Linux/macOS the subtitle cache landed in a directory that does not exist; it now uses the storyboard's
  `cacheDir()`. `findCachedMedia()` likewise uses `tmpdir()` instead of `LOCALAPPDATA/Temp`.
- Dead exports removed: `plan.starts` (a 513-element array allocated on every `makePlan`),
  `legacySessionKey`, `wasWritten`, `MATERIAL_PARTS`. The input surface failing to start no longer fails
  the whole call — it is reported in the result instead.

Three rounds on 2026-10-31. The through-line: the plugin knew something, and the model (or the user)
never found out — plus one window that needed to look like something people want to keep on screen.

### Long-video recap — merged, but opt-in

PR #2, after one round of review. Its first shape prepended a 420-character `[前情]` to **every**
delivery, partly built from the model's own scripted lines: second-hand context in a package whose
contract is "raw material only — never retell what the user just watched", at ~200 tokens per
segment, with no evidence it helped.

What shipped instead: off unless `recap: true` or `DSH_WATCH_RECAP=1` (`recap: false` beats the env
var); only **cached subtitle sentences**, never the model's lines; `recapSegments` 1–3 (default 2),
`recapMaxChars` 80–1200 (default 420); never reads past the current segment, never trims the live
transcript, no ASR, no network. Whether it actually reduces retelling is still **unmeasured** — it
stays opt-in until somebody measures it.

### Observability: `statusOnly` can now answer "why is it slow"

Promised in issue #4. `pos + reason` says *what* the clock thinks, not *where it is stuck*.

- `segment { index, from, to, delivered, total }` — which batch, its bounds, how many were delivered
  this session, how many the film has (`total` is `null` when the duration is unknown). The last batch
  index is taken at `dur - 1 ms`, because a duration that lands exactly on a boundary would otherwise
  report one batch too many.
- `speech { queued, lastLateSec, busyUntil }` — lines still waiting, how late the previous line was
  (from `dueLine`'s new `meta: true`, which also keeps the plain-string return for old callers), and
  when the serial voice engine frees up.
- `build { inflight, cached, lastMs }` — which batch is being built, how many are cached, how long the
  last build took. The cache is passed into the loop for reporting only; it never influences a decision.
- `queued` needs a disk read, so it is filled in `statusOnly` only, and a failure there is reported as
  `speech.queueError` instead of being swallowed (the first version of this swallowed a `ReferenceError`
  from a missing import and looked exactly like "there are no lines").

### The floating window, rebuilt

"这个悬浮窗太丑了" — fair. The old one was a borderless frame with a `Text` widget that painted
role-coloured **full-width stripes**, on a window Windows stretched from 96 dpi, reading the whole
`chat.jsonl` every 200 ms.

- **Real bubbles.** Each message is its own rounded card (Canvas background + wrapped Label), sized
  to its content: script lines in amber with a left rule, the model in slate, the user's own words
  right-aligned in blue. Above each one, a muted line saying who and when (`台词 04:12.3` for a
  scripted line, `我 21:16` for chat).
- **Per-monitor DPI awareness** before the window exists, and every size/font derived from the real
  scale factor. Unaware Tk windows are bitmap-stretched at 125/150%, which reads as "blurry and wrong".
- **Rounded window** via `-transparentcolor` (Windows only; falls back to square corners), a 1 px
  border, and a hand-drawn 6 px scrollbar that only appears when the list actually scrolls.
- **Does not steal focus.** `focus_force()` at startup meant pressing space to pause the video landed
  in the chat box; now the entry only takes focus inside the window.
- **Does not fight your scrolling.** New lines auto-scroll only if you were already at the bottom.
- **Incremental read.** Only the bytes appended since the last tick are parsed, and the first paint
  replays just the last 60 entries.
- Resizable from the bottom-right grip; position and size persist in `~/.dsh/watch-window.json`.

### Stop when the signal says stop: hangup, dead source, switched video

Reported as "换片或者我都关浏览器了还在念台词" and "关了悬浮窗 AI 还是会自动调出来，根本不会自动结束".
Both were the same shape: the plugin knew the source was gone, and kept talking anyway.

- **Speech now requires a believable position.** The line queue only fired when the position was
  `fresh`, or `extrapolated` within `SAFETY_AFTER_MS` (20 s — the normal gap between probes).
  Before, the only thing excluded was `paused`; `estimate()` happily extrapolates a dead source
  forward and `pos` stays finite, so closing the browser kept reading lines out for minutes.
  Nothing is spoken on an `unknown` position, and the position-unknown give-up dropped from
  10 min to 5 min (the watch should not sit there pretending).
- **Closing the floating window is a hangup, treated like an interjection.** The window is the only
  way to talk mid-watch, so closing it means "I'm done":
  - the clock stops and **really wakes the model** — `wake:false` (the default) used to silence this
    too, because it shared the `wake` path with the segment-end reminder. User actions (hangup,
    video changed, video ended, seek, unreadable position, high-frequency mode) now use a separate
    always-real channel (`wakeSignal`), and the message says **do not call watch_together again and
    do not read out any more lines**;
  - the guard is stored on the loop and can be turned on later (`resumed` path used to freeze it,
    so a window opened by an earlier call was never guarded);
  - the next tool call **does nothing at all**: no frame, no clock, no window (`[hangup]` result).
    `sameWatch` previously required `args.input`, which the model never sends — so every call looked
    like "a new watch" and re-opened the window the user had just closed.
- `wakeWithRetry` called an undefined `note()` in its failure branch (a `ReferenceError` swallowed by
  the ticker). Real wakes can fail, so it was reachable; now it records into `loop.logs`.

Tests: 247 pass, +4 in `test/hangup-guard.test.mjs` (dead source sends nothing, live source still
speaks, hangup wakes with the right wording, post-hangup call is inert).

### Interjections: speak first, then look

Reported as "它一声不吭先去 zoom，回来才说话". The root cause was not the model: a normal reply
never reaches the floating window — only `say` does and only `say` is spoken. So "think, then look,
then answer" was, from the user's side, complete silence for tens of seconds.

- One wording, one place (`src/interject.js`) for all five entry points (during a build, during the
  lookahead fill, during a blocking wait, `waitUntil`, `nextLine`). It now says exactly what to do:
  `watch_together({ say: "我看一眼", speakNow: true })` — one call, words written before any frame
  is built. `lines` and `say` can ride in the same call, so "台词优先" no longer means "stay silent".
- Unanswered interjections are **tracked**: the next tool result ends with `[未回应] …你还没回`,
  until a call actually carries `say` (expires after 3 min). Previously the reminder existed only
  inside the message that woke the model, which it had already scrolled past.
- `waitUntil` / `nextLine` called a function that **did not exist** (`chatResult`) — an interjection
  during either wait threw `ReferenceError` and the tool failed. Defined, and it reuses the same wording.
- Waiting for a video to appear returned a result **without `text`**, which the host's `output.schema`
  requires. That path now returns a proper result.

### Reply vs. scripted line: 12-second guard

Reported as "说话和插话的回复离太近，把后面那句改一下". Two lines spoken back to back on a serial
TTS chain means the second one either drifts or is dropped by the adapter (queue > 3.5 s → `skipped`).

- `say` now marks the voice engine busy for its full spoken length (`src/reply-guard.js`), so the
  loop stops feeding scripted lines while a reply is still playing. Previously only the loop's own
  lines updated that clock — a reply was invisible to it.
- Lines scheduled within 12 s of a reply are **withdrawn from the batch and handed back** to the
  model (`[lines·太近]`) with instructions to rewrite them around what was just said, or drop them.
  Withdrawn, not silently deleted: the user asked for "改一下", not "少一句".

### Switching videos is noticed in ~2 s, not ~15 s

- The per-tick bridge read (every 2 s) now does the switch / end-of-video / big-jump checks, and
  keeps the `dur`/`url` baseline up to date. Before, all three lived in the 15-second CDP probe
  branch only, so a switch could go unnoticed for a quarter of a minute — while the clock kept
  computing segment boundaries against the old film.
- The blocking wait in `watch-run` now compares each read against the film it started with and
  returns `[video-changed]` immediately. **This was the only reliable path**: the loop's wake goes
  through `followup()`, which is delivered *after* the current tool call returns — and that call was
  busy waiting.
- `sourceSwitched()` centralises the test, and `Number(null) === 0` is explicitly guarded: a
  not-yet-known duration used to look like a "0-second film" and stop the watch instantly.

### Cold start: don't wait a full minute for a video we can already identify

- The extension only reports while the tab is **visible** — and "一起看" is usually typed in another
  window. The position went stale after 5 s, the plugin concluded "no video", and sat in the 60 s
  wait. It now falls back to a **stale** sample (up to 2 min) to identify the film, marks the
  position `stale`, and lets the next fresh reading correct it.
- Automatic waiting (no `waitForVideo`) dropped from 60 s to **20 s**; explicit `waitForVideo: true`
  stays at 120 s.
- `probeBrowser()` is skipped when the extension already reports: one probe is `listTargets`
  (1.2 s) plus up to 8×1.5 s of CDP round-trips — pure overhead for a `browser:` line the extension
  just answered. The line now reads `browser: extension reporting <title> playing 03:20`.

Tests: 243 pass (`node --test`), 6 of them new in `test/interject-reply.test.mjs`.

## [0.1.0] - 2026-11-01
首个发布版本。要求 `dsh-video-storyboard@^0.5.11`（字幕轨用到它的 `./transcript-pass` 子路径）。

## [0.0.7] — 2026-10-31 (first release)
The first published version. One tool, `watch_together`: it follows the user's real playback
position, hands the model one storyboard + transcript per segment just before that segment ends,
and speaks the scripted lines at the second they belong to.

**Licence: Apache-2.0** (the package was developed under MIT and switched before the first
public release, to match `dsh-video-storyboard`). `LICENSE` is the full text, `NOTICE` states
what the project deliberately does **not** do — no hosted video, no uploaded position, no DRM or
paywall bypass, no bundled TTS engine.

### Repo hygiene — the extension's manifest and icons were never committed

`.gitignore` carried `manifest*.json` and `*.png` (meant for CLI artifacts). Those two rules also
swallowed `extension/manifest.json` and `extension/icons/*.png`, so a clone would have shipped an
extension **with no manifest** — completely broken, and nothing would have failed until someone tried
to load it. Both are now force-added, and the ignore rules are anchored (`/*.png`, `/*.meta.json`) so
they can only ever catch files at the repo root. Also: `* cookies*.txt` (a pattern with a space, which
never matched anything) is gone, `__pycache__` is out of the npm tarball via a new `.npmignore`, and
`npm test` no longer requires the sibling `dsh-video-storyboard` checkout — it falls back to the
installed copy, so a clone can run the suite.

### Docs — one page per service, and the stale one is gone

`docs/WATCH.zh.md` still explained how to configure things around the **OS media session (SMTC)**,
which was deleted a while ago: wrong rationale, wrong `confidence` values, wrong defaults. Deleted.
Replaced by [`docs/CONFIG.zh.md`](docs/CONFIG.zh.md): ffmpeg → yt-dlp + cookies → subtitles/ASR →
browser extension (9377) → debug port (9333) → voice (`voice.json` + `tts.json`) → floating window →
cache locations → a one-page troubleshooting table. Every entry says **what breaks if you skip it**.

`README.md` got a 30-second start, a "what to configure" table, a corrected parameter table
(`depth` is auto-by-time now, `lookahead` was missing), a CLI table that matches the 15 real
subcommands, a privacy note for the extension, and a dev section. `docs/VOICE.zh.md` gained
`state: 'skipped'` and a correction: `at` is a **playback second**, not a wall-clock timestamp.

### `doctor` — three levels, because "not configured" is not "broken"

`FAIL` used to be printed for things that are merely "not set up yet": a missing cookie file (only
needed for Bilibili), a closed debug port (the extension is the recommended channel), an extension
that is loaded but has no video playing. First-run users read that as "something is broken" and went
to reinstall the extension. Now: **OK / WAIT / FAIL**, only `plugin` and `ffmpeg` are fatal, and when
the extension has checked in but nothing is playing, `doctor` says `READY — 播个视频就能读到位置`
instead of "both position channels are down".

### Performance — the chat watcher no longer re-reads the whole log every 150 ms

The blocking-wait loop polls `chat.jsonl` every 150 ms. Each poll re-read `readChat()` and parsed
every line, so a two-hour session (thousands of entries) was decoding hundreds of KB several times a
second, and getting slower the longer the session ran. `makeChatWatcher()` now keeps a byte offset
and reads **only what was appended since last time** (falling back to a full re-read if the file
shrank, i.e. it was cleared). Measured on a 5000-line log: **0.061 ms per poll, independent of file
size**. `appendChat()` also stopped parsing the whole log to keep `at` monotonic — it reads the last
4 KB instead.

### Tool description — pacing is now a rule the model can follow

`watch_together`'s description tells the model to keep lines **≥ 6 s apart** and why: speech is
serialized, so a denser draft is thinned at runtime (engine busy → next line held; past the late
grace → dropped). The three previous rounds of "台词太早 / 太密" all came from the model not knowing
this budget.

### Fixed — speech piled up in the engine queue, and an interjection could no longer break a blocked wait

Two reports in one message: "吐字太快，台词会挤到一起，只有上一句念完才到下一句，话太密会导致语音越来越
滞后" and "悬浮窗插话不能让他从等待中出来 —— 这个功能之前是好的".

**The voice queue.** `examples/voice-edge-tts` chains every `due` event onto an unbounded serial promise
("two lines never overlap"). Lines are now scheduled at the right second, so when they arrive faster
than the engine can speak them the chain simply grows: speech drifts further from the picture with
every line, and the caption (written on `spoken`) drifts with it.

- `src/watch-loop.js` — the clock now keeps a **voice budget**: after handing out a line it records
  `voiceBusyUntil = now + speechSeconds(len)` and will not hand out the next one while the engine is
  still talking. A line that misses its window by more than the late grace is dropped by `dueLine`
  as usual: **speak one line less rather than one line later**.
- `src/speech.js` — `speechSeconds(chars)`: full spoken duration (`0.35 + chars/5`, 0.8–30 s).
  `speechLag()` stays as it was — that one answers "when may I start talking", this one answers
  "how long is the engine busy".
- `examples/voice-edge-tts` — safety net: if a queued line has been waiting more than 3.5 s it is
  **abandoned** (logged) instead of spoken, and the queue empties immediately.
- `src/speech-bus.js` / `src/chat-store.js` — a fourth state, `skipped`: the adapter reports that it
  gave up on a line, and `attachSpeechToChat` cancels the pending fallback timer for it. Without this
  the 2.5 s fallback would paint a caption for a line that was never spoken.

**The interjection.** `chat.jsonl` is a **consuming** channel: `poll()` marks a message read. The
blocking wait and the watch loop share one watcher, and the loop's handler is `followup()` — which
cannot interrupt a session that is sitting inside a tool call (the message is only processed when
the turn ends). So whichever polled first decided the outcome, and the loop (every 2 s) sometimes
won: the interjection was swallowed, the wait's `poll()` never saw it, and the user's "stop, I have a
question" did nothing until the segment ended.

- `src/interrupt.js` — `enterChatWait()` / `chatWaiterCount()`: whoever is blocking on purpose
  **owns** the channel. `raceChat()` (storyboard build, prefetch) registers too.
- `src/watch-loop.js` — `wakeOnChat` is skipped entirely while `chatWaiterCount() > 0`. The wake path
  still works when the model is idle (no waiter), which is its whole purpose.
- `src/watch-run.js` (the `wait: true` loop), `src/watch-modes.js` (`waitUntil` / `waitForRefill` /
  `nextLine`), `src/watch-source.js` (`waitForVideo`) — all register as waiters for the duration of
  their loop.

Tests: `test/lines-timing.test.mjs` (engine busy → next line is not handed out; the overdue one is
dropped), `test/chat.test.mjs` (`skipped` writes nothing, not even the fallback),
`test/interject-anywhere.test.mjs` (the loop must not consume while a waiter is active; counter
cannot go negative).

### Fixed — scripted lines came out like a machine gun, and minutes before the picture

Reported as: "台词出现时间早了很多，而且和机关枪一样突突突一下出来一大堆，时间点都比视频早了".

The line queue is ordered by `at` (the second of the video this line is *for*) and fired by playback
position, so the pacing is only as good as the `at` values. When a line was written **without** `at`
(the model wrote prose only), `pinTimes()` decided when it would be said — and it took *the first N
subtitle sentence starts of the segment*. Sixteen lines written for a 3-minute segment were therefore
all packed into its first 62 seconds (181.6 → 244.2, measured on the live queue), i.e. one every
2–3 seconds: the clock ticks every 2 s and hands out at most one line per tick, which is exactly the
"machine gun". The last 14 of them ran one to two minutes ahead of the picture they describe.

- `src/watch-lines.js` `pinTimes()` — each line now aims at its **even share of the segment**
  (`from + i*size/n`) and snaps to the nearest subtitle start within half a slot, so the queue is
  spread over the whole segment instead of stacked at its head. Falls back to the even share when no
  start is close enough, and **never goes backwards** (the old tail fallback could emit 152.8 → 150).
- `src/watch-lines.js` `dueLine()` — pinning uses **the segment that line belongs to** (`sizeOf`),
  not the segment the user happens to be in. With the 1/2/3/4/5-minute ramp, a 60-second slot pinned
  with a 300-second size put its last lines outside the segment entirely.
- `src/watch-lines.js` `saveLines()` — `at` given as **subtitle text** was resolved only against
  `recallSegments()`, which is a 4-entry in-process cache (empty in a fresh process, and lines are
  usually written in a different turn). A miss silently became "no `at`", i.e. the head of the
  segment — the other half of "the line is way too early". Now it reads the on-disk
  `subs-<key>.json` cache first, then falls back to memory, then to a fuzzy match (≥60 % of the
  characters), and only then warns.
- `src/watch-run.js` — the delivery note pruned "past" lines with `Number(l.at)`, and
  `Number(null) === 0`: **every line without `at` was judged as second 0 and deleted** at delivery.
  The note now previews the same pinning the clock will use, so the reported "earliest …" time is the
  real one, and only lines whose *actual* time has passed are dropped (by text).
- `src/watch-run.js` — the note now lists the landing times it will use (`[lines] 落点：…`) and warns
  when the average gap is under 6 s, instead of leaving the model to guess its own pacing.
- `src/watch-loop.js` — with the extension as the position source, the anchor is now re-read **every
  tick** (a small local JSON, not CDP). Between the 15-second probes the clock extrapolated blindly,
  so after a pause the lines up to 15 s ahead were spoken **early** — extrapolation is bounded for
  lateness but nothing guarded earliness.
- `src/latency.js` `aheadSeconds()` — returns 0 instead of `NaN` when `ms` is missing. `NaN` made
  `pos` `NaN`, every comparison false, and `shouldSpeak()` reported "due" for the first unspoken
  segment at every tick.

Tests: `test/pin-times.test.mjs` (the 16-line packing regression, monotonic fallback, cues bunched at
the head), `test/watch-lines.test.mjs` (per-segment size, `at` from the on-disk subtitle cache),
`test/lines-timing.test.mjs` (a stuck video must not speak the next line early).

### Fixed — the caption appeared before the voice, because it waited on `due` instead of "actually speaking"

`attachSpeechToChat` wrote a line into `chat.jsonl` the moment `due` fired. But `due` only means
"it is time to say this": synthesis still has to happen (edge-tts does a network round trip, then a
fresh `ffplay` process — 0.6–2 s even for a short sentence). The floating window polls that file, so
the text was already on screen a beat before anything was heard.

Delaying the voice instead (`speechLag`) would align the two, but push the voice further from the
picture, which is the one thing this plugin cannot trade away. So the **caption** moves:

- `src/speech-bus.js` — a third state, `spoken`, plus `emitSpoken(event)` for engines to report
  "audio is starting now". The adapter API gains `emitSpoken`.
- `src/chat-store.js` — writes on `spoken` when a `voice: true` subscriber exists; still writes on
  `due` when nobody will speak (the zero-dependency path must not go mute); falls back after
  `fallbackMs` (2.5 s, `DSH_WATCH_CAPTION_FALLBACK_MS`) for adapters that never report.
  Pairing is by `at|text`, not by `seq` — `spoken` is a **new** event, so `emitSpeech` gives it a
  new sequence number.
- `examples/voice-edge-tts` — reports `spoken` right before playback starts (i.e. after synthesis).
- `examples/floating-chat/window.py` — polls every 200 ms instead of 400 ms; the poll interval is
  the residual "text lags the voice" gap.

`test/chat.test.mjs` covers both new paths (waits for `spoken`; falls back when nobody reports, and
does not write twice if `spoken` arrives afterwards).

### Fixed — scripted lines never reached the chat window without a voice engine

`watch-loop.js` consumed the due line inside `if (speechSubscribers() > 0)`. That helper counts only
`voice: true` subscribers (real engines), while `attachSpeechToChat` — the one that writes lines into
`chat.jsonl`, which is exactly what the floating window reads — subscribes with `voice: false`.
So with no voice adapter, or one that failed to load, a scripted line was **never taken from the
queue at all**: not spoken, not displayed, and the queue silently accumulated.

Display and speaking are two separate things. The line is now handed out at its due moment
regardless: `emitSpeech` delivers it to every subscriber, and only a real `voice: true` subscriber
counts as "said" (`if (speechSubscribers() > 0) return;` still stops the wake, so nothing changes
when a voice engine *is* attached).

`test/lines-to-chat.test.mjs` covers both sides. The test was checked against the bug: restoring the
old condition makes the no-voice case fail while the with-voice case still passes.

### Changed — `say` no longer reads as "only to answer an interjection"

It always worked at any moment: it writes the sentence into the shared stream and hands it to
whoever listens for speech, exactly like a scripted line. But the description ended with
"use it to answer an interjection", which reads as "only after the user speaks". A model follows
that literally, so the one path for saying something **unprompted** went unused.

The description now says any time, and says it explicitly: something in the picture strikes you,
the user asks something, a thought lands while waiting for the next batch — plus
"do not wait for the user to speak first". It also states the cost, because that is what makes it
usable mid-wait: no position read, no frame built, no batch advanced, one round trip.

`test/say.test.mjs` pins the wiring — parameter → stream (one `assistant` row with `say: true`) →
speech event with `origin: 'chat'`, no image, no state advanced. The store layer was already covered
by `test/chat.test.mjs`; the uncovered part was the parameter entry itself.

### Added — an end-to-end test for "talk while the frame is building"

The mechanism already existed (`raceChat(buildSegment(...))` in `runWatchPass`), and
`test/interrupt.test.mjs` covered `raceChat` itself — but the `built.kind === 'interrupted'`
branch had **no** coverage. If a refactor ever dropped the wrapper, or `chatWatcherShared()` got
replaced with a fresh watcher per call, every existing test would still pass.

`test/interject-build.test.mjs` builds a segment that takes 1.2 s, writes a user message at 0.2 s,
and asserts all four things at once: the call returns before the build finishes, it carries that
exact message, it carries no image, and the build still completes into the cache afterwards.

### Changed — three implicit couplings now have exactly one source each

A pass over the module boundaries. Same behaviour except the `lead` fix at the end, which was a
real bug: the parameter only worked on one of the three paths that used it.

- **`handler.js` stopped preparing UI.** The floating window, the chat service and the "where do I
  type" note moved to `input-surface.js` (`createInputSurface()`). `handler` is a router again —
  three exits: quick action, one pass, start the loop. The `widgetNote` variable no longer travels
  from the top of the function to the bottom.
- **`watch-run.js` has one return shape.** Eleven exits each used to build their own ten-field
  object; now they all call one `pass()` closure. Adding a field is one edit instead of eleven, and
  a branch can no longer quietly forget one.
- **One segment length.** `watch-state.js` exported `WATCH_SEGMENT = 120` while `batches.js`
  declared `DEFAULT_SEGMENT = 300`; whichever fallback fired first decided how long a segment was.
  `batches.js` is now the only source, and `WATCH_SEGMENT` is gone.
- **One lead.** The delivery lead was hardcoded in three places: `batches.from()` produced
  `sayAt = to - 15`, `watch-loop.js` passed `lead: 15` to `shouldSpeak`, and only `watch-run.js`
  actually read `args.lead`. Segments no longer carry `sayAt`; `shouldSpeak` computes `to - lead`,
  and `startWatchLoop` takes `lead` from the caller. `lead: 60` now really moves the trigger point
  (checked against a 300 s segment: at 241 s, `lead=15` stays quiet, `lead=60` fires).

### Removed — no more auto-launched browsers, no more browser widget

Both were early paths from before the browser extension existed. Neither could produce a position
for the tab the user is actually watching, so both are gone rather than kept as fallbacks.

- **Auto-launching a browser**: `ensureWatchBrowser()` (`launchBrowser` + `waitForPort`), the
  `autoLaunch` flag on `runWatchPass`, the `attachOnly` parameter, and the `launchBrowser: true`
  branch in `~/.dsh/video.json`. The extension already reports `currentTime` every second from the
  page the user is on; opening a second Edge with its own profile never helped that page. When no
  position can be read the tool now asks "how far are you" instead of starting a program.
- **The browser widget page**: `GET /widget`, `WIDGET_PAGE`, `openWidgetInBrowser()`, `widgetUrl()`,
  and the `documentPictureInPicture` button in the chat page. The input box is the native tkinter
  window (`examples/floating-chat/window.py`); the HTML page stays as a read-only fallback at `/`
  (`chatPageUrl()`), and is never opened automatically.
- **Dead parameters**: `wakeOnLinesEmpty` (the handler never passed it, so its 30-line branch in
  `watch-loop.js` could never run), `title` (nothing in `src/` or in storyboard read it), and
  `segmentStart()` (every caller uses `plan.segmentAt()`). Parameter count 36 → 34.

### Fixed — interjections used to get swallowed (four different ways)

The interjection path was the one place where losing user input was silent: nothing crashed, nothing
logged, the words just never arrived. All four ways of losing them are now closed, and each one has
a regression test (`test/cli-interrupt.test.mjs` — the CLI had **no** test coverage before this).

- **Between two `cue` runs.** Every `cue` is a fresh process, and the watcher took "however many
  lines exist right now" as its baseline — so anything the user typed while the model was thinking,
  building a segment or replying was never read by anyone. The read position now lives in
  `<watch>/chat-cursor.json`: a `cue` starts from where the last one stopped, and delivers what it
  finds the moment it enters the wait. Baseline is persisted as soon as it is established, because a
  `cue` that hears nothing (the common case) otherwise leaves no cursor for the next one.
- **Two messages arriving in the same poll.** Both watchers (chat box and host session file) marked
  the whole batch as read and reported only the first, so the second was gone. They now consume up
  to the message they hand over and no further — "reply first, then take the next one".
- **Wrong conversation.** `findActiveSessionFile()` took the most recently modified session jsonl
  across *all* projects, so a chat in another window could interrupt the watch session. It now
  prefers the project matching the current directory and only falls back to global when that one has
  no active session.
- **The host writing old messages late.** WorkBuddy flushes a user's message into the session file
  *after* the reply to it. The watcher saw new bytes and treated them as a fresh interjection —
  interrupting the current turn with the message that started it. Messages whose `timestamp`
  predates the watcher are now ignored.

Also in this path: interjections heard via the host input box are appended to the chat stream too
(they used to appear only in `cue`'s stdout, so the page showed a stream with a hole in it); the
chat page puts the words back in the input box when a send fails instead of losing them; and
`POST /api/say` answers `ok:false` for requests it did not write, which is what makes that recovery
possible.

### Fixed — `cue` and `say`

- `cue` no longer waits forever when the video changes underneath it. It compared against the
  segment delivery point of the *old* video, and if the new one was shorter, `deliverAt` was a
  position that would never be reached. It now detects a changed URL or duration and exits with
  `VIDEO-CHANGED` (pending lines are saved under the old source), and exits with `REWIND` when the
  user drags the progress bar back more than a minute — the model should hear about that instead of
  sitting on lines written for a position the user left.
- Two `cue` processes can no longer run at once: a state file saying `blocking` with a **live** pid
  is refused with `BUSY` (exit 1). A dead pid is taken for what it is — the residue of a killed run —
  and does not block anything. `check` mode is read-only and never takes the lock.
- `check` mode no longer leaves `cue-state.json` at `blocking`, which used to make the next run
  report "last wait was killed externally" for a run that was never waiting.
- `say` called edge-tts once by hand and then again inside `speak()` (twice the synthesis, and the
  manual attempt passed the raw configured voice, so a SAPI-style name like `Huihui` never matched
  and silently fell back). It now calls `speak()` once, which does the mapping and the fallback.
- `voices` was advertised in `help` and crashed with `cmdVoices is not defined` when called. It now
  lists the SAPI voices plus whether edge-tts is present and which voice is configured — the first
  place to look when "why am I still hearing the navigation lady" comes up.

### Added — talk instead of type: a microphone button in the floating window

`examples/floating-chat/mic.py` is a separate process the window starts from its `麦` button. It
listens, cuts what you say into utterances with the Silero VAD already sitting in `models-sherpa/`,
transcribes each one, and writes it into the **same** `chat.jsonl` the typing path uses — so a
running `cue` picks it up through the interjection cursor and the model answers without anyone
typing a character. Measured end to end on this machine (i9-12900HX, int8 paraformer):

- one model instance ≈ **284 MB** working set, loads in ~2 s
- a 3 s utterance transcribes in **0.15 s**; a 45 s one in ~1.2–3.3 s (RTF ≈ 0.05, 20× realtime)
- concurrent transcription barely queues: a 3 s short request takes 0.14 s even while a 45 s
  transcription is running

**It runs its own model by default** (`--engine local`), which is the answer to "can ASR run twice":
yes, and it is cheap. It also means the microphone never waits behind a video transcription. The
existing service cannot offer that yet — see the note below. `--engine http` shares port 8000
instead, saving 284 MB at the cost of queuing behind long audio.

**It refuses to hear itself.** The agent speaks through speakers; the microphone hears it; without a
guard that gets transcribed as if the user had said it, and the model answers its own line forever.
Every utterance is checked against `quiet-until.json` (the same window `say` and `cue` already take
before speaking) and dropped if the agent is talking.

### Added — acoustic echo cancellation, so the microphone hears you and not the computer

`examples/floating-chat/aec.py`: the microphone picks up whatever the speakers are playing, which
means the video's narration gets transcribed as if you had said it. Since neither `speexdsp` nor
`webrtc-audio-processing` builds on this machine (no C compiler, no wheels), this is a frequency-domain
adaptive filter (overlap-save FDAF, power-normalised NLMS) in numpy — one FFT per 32 ms frame.

It captures the **loopback** channel (what the computer is playing, auto-detected as the
speaker/loopback device, never "stereo mix" — that one can contain the microphone too) and subtracts
the estimated echo from the microphone. On top of that, an utterance whose energy drops below
`--echo-gate` (default 30 %) after cancellation is discarded outright: that is the hard guarantee
that pure-echo segments are never transcribed, whatever the filter is doing.

Two things that mattered more than the filter itself:

- **Double-talk detection cannot compare against the echo estimate.** At startup the filter is zero,
  so the estimate is zero, so "mic > 2 × estimate" is always true, so the filter freezes and never
  converges (first version: 498 frames frozen, 0 dB). It now compares against the **reference**
  signal (Geigel-style), which does not depend on the filter's state.
- **Measured on a synthetic but honest mixture** (real speech as the video, a different real speech
  segment as you, through a 150 ms-delayed reverberant echo path):
  ERLE **13.6 dB** during echo-only passage; the video's words in the transcript went from **25 % →
  0 %**, and an 8 s passage with nothing but video audio produced **no transcription at all**.

Tunables: `--dt-ratio` (1.4 — mic peak vs reference peak before the filter freezes), `--taps`
(8192 ≈ 512 ms of reverb tail), `--echo-gate`, `--no-aec`, `--loopback`.

Honest limits: it is a software AEC, not magic. The first second or two of your speech, right as the
filter re-converges after you start talking, is where the damage shows (a few characters in the test
above). Speaker loudness and room reverb both make it harder. **Headphones remove the problem
entirely** — with headphones there is no echo to cancel, and everything above is unnecessary.

### Added — a browser extension, so you never open a special window again

Position used to require a browser started with `--remote-debugging-port`, and Chromium 136+ refuses
that flag on the default profile — so users had to keep a second, separate browser window open just
for watching. That was the whole reason this package felt like it needed a "special browser".

`extension/` is an MV3 extension that reads `<video>.currentTime` from the page you are actually
watching and POSTs it to the plugin's own localhost server (`127.0.0.1:9377/api/position`). After a
one-time install it works in **your normal browser**, with your bookmarks and your logins.

- `src/position-bridge.js` — the receiving end: writes each report to
  `<cache>/position.json` (temp file + atomic rename) and treats anything older than 5 s as absent.
  It goes through a file rather than memory because the CLI is a **different process** and has to
  be able to read it too.
- `POST /api/position` and `GET /api/position` on the existing chat server, with CORS and a
  Private-Network-Access opt-in (a page on https://bilibili.com talking to 127.0.0.1 needs both).
- `readPositionOrNull()` now tries the extension report when CDP is not configured or returns
  nothing, so every existing call site gets the new channel for free.
- `doctor` grew an `extension` row and now treats "either channel works" as ready instead of
  insisting on the debug port.
- `docs/BRIDGE.zh.md` — step-by-step install guide written for someone who has never heard of a
  manifest file, including the eight failure modes people actually hit.
- `node watch.mjs install-extension` (and `scripts/install-extension.cmd`) does everything that
  *can* be automated: copies the extension to `%LOCALAPPDATA%\\dsh-watch-together\\extension` so it
  survives moving the repo, puts that path on the clipboard, and opens `edge://extensions`.
  The last three clicks cannot be automated — Chrome 137 removed `--load-extension` from branded
  builds and extension installs are HMAC-protected, deliberately, because silent install is the
  malware channel. The guide says so plainly instead of pretending otherwise.
- **The extension now says hello on load** (`POST /api/hello`, persisted as `extension.json`).
  Without it, "extension not installed" and "installed but no video playing" look identical from the
  outside — both are silence. `doctor` and `bridge` can now tell them apart.
- `extension/welcome.html` opens on install/update: the three verification steps, plus what each
  popup state means. Install is the one moment the user has no idea what to expect.
- `install-extension` no longer just prints and quits: it keeps the window open and **watches until
  the extension proves it is loaded** (`✓ 扩展装上了`), then until a real position arrives
  (`✅ 全部完成`). One double-click now covers install *and* verification, and the window cannot
  vanish mid-instruction because it is still polling.
- `node watch.mjs install-extension --steps` re-prints just the three clicks without touching any
  file — for when the window scrolled past or was closed.
- `install-extension` now waits for Enter when it has a TTY, so the instructions cannot vanish
  before being read (running it from an IDE "Run" button has no TTY, which is the common way this
  happened).
- `ensureWatchBrowser(port, url)` now passes the film through: with `launchBrowser: true`, saying
  "陪我看这个 <link>" opens the dedicated window **at that link** instead of the Bilibili homepage.
  That is the zero-install path — no extension, no port config, at the cost of watching in that
  window. Both paths coexist; neither requires the other.
- `node watch.mjs bridge` (and `scripts/bridge.cmd`) starts just the position receiver and says
  "✓ 收到上报" on the first report. Without it, a user who installs the extension and immediately
  looks at the popup sees "not connected" — because the server only runs during `watch_together`
  or `watch.mjs chat`, and concludes the install failed.

### Added — closing the remaining "no one is listening" dead ends

- **Idle stop now wakes the model too.** Video-ended and video-changed already did; idle ("no movement
  for two segments") did not — and since the loop is stopped, nothing polls the chat box afterwards,
  so anything the user said next went nowhere. Now it wakes and says where it stopped.
- **Waiting is polled, not slept through.** The 500 ms tick in the blocking wait now uses
  `sleepWithChat`, so a message is noticed within ~150 ms instead of up to 500 ms later.
- **The tool description now tells the model what an interruption is:** a result carrying `chat` means
  "answer them first, then call again with the same arguments — the wait resumes, nothing is lost, and
  the image is already in the cache". Without this the model had no way to know.
- **`doctor` distinguishes "nobody is receiving" from "extension not connected".** Both look like
  silence, and the old wording told the user to reinstall the extension — but if no server is running
  on 9377 the extension cannot report at all, and reinstalling would have changed nothing.
- Stale SMTC-era wording removed from the strings the *model* reads (`input`/`cursor`/`title`
  descriptions, and the `browser:` line), which still talked about the OS media session.

### Added — you can interrupt almost any wait, and it picks up where it left off

Every blocking wait in `watch_together` can now be interrupted by a message in the chat box, and in
all cases the answer is "reply to them, then call again with the same arguments" — the tool resumes:

- **Building a segment** (8–10 s, longer with ASR) and **filling the lookahead buffer** (up to 4
  segments serially, 30 s+) — the most pointless kind of waiting, now interruptible.
- **Waiting for the video to appear** (`waitForVideo`, up to 2 min).
- **Waiting for a condition** (`waitUntil`) and **waiting for the next line** (`nextLine`).
- Waiting to the delivery point and `cue` already listened; they now share one watcher (below).

The interrupted work is **not cancelled**: the storyboard keeps building in the background and lands
in the cache, so the follow-up call returns it immediately instead of rebuilding it.

New `src/interrupt.js`:
- `raceChat(promise)` — polls the chat while a slow promise runs; returns `interrupted` with the
  message, or `done`. Wakes on whichever happens first (the promise settling, or the next poll tick).
  The first version slept a fixed 500 ms per tick, which added half a second to *every* build —
  enough that playback passed the delivery point and the blocking wait returned instantly.
- `sleepWithChat(ms)` — sleep that can be cut short by a message.
- `chatWatcherShared()` — **one watcher for the whole process.** `makeChatWatcher()` baselines at
  creation time, so a fresh one per wait silently dropped anything the user said while the model was
  thinking, in the gap between two waits.

### Added — it now reacts to what you do mid-video

Auditing the whole flow against the user's checklist surfaced three gaps where the plugin behaved
correctly but **never told the model**, leaving it silent until the user poked it:

- **Video ended / video changed now wake the model once.** Previously they only stopped the loop, so
  the model sat blocked on the previous segment with no idea the film was over or had been replaced.
- **Large seeks (>60 s, forward or backward) wake the model once** with where the user jumped to and
  from, with a 3-minute cooldown. Position tracking was already correct — it was the model that had
  no idea. Rewatching does not re-speak already-spoken segments (no immediate-repeat chatter).
- **Only the visible tab reports** (`document.visibilityState`), plus a report on `visibilitychange`.
  Every tab with a `<video>` reports once per second; with two such tabs open the server received
  alternating positions and the plugin interpreted it as the user scrubbing wildly.
- The simulator can now jump the playhead (`seeks: [{at, to}]`), and there are four new scenario
  tests covering: video changed wakes once, video ended wakes once, seek forward wakes once, rewatch
  wakes once and does not re-speak.

Note the jump check must run **before** the anchor is refreshed — comparing the new reading against
the already-updated anchor measures zero. That was the first (failed) version.

### Fixed

- **`bin/watch.mjs chat` ran its own copy of the chat server** — an inline `http.createServer` plus
  duplicated copies of both HTML templates (92 lines). The copies had drifted: it served `/`,
  `/widget`, `/api/messages`, `/api/say` but **not `/api/position` or `/api/hello`**. So running
  only `watch.mjs chat` (instead of `bridge`) meant extension reports hit 404 and the CLI path could
  never read a position. It also never called `attachSpeechToChat()`, so that chat box showed user
  messages but no script lines. It now uses `startChatServer()` + `attachSpeechToChat()` like the
  plugin and `bridge` do, and the duplicated templates are deleted.
- **`watch.mjs reply` wrote straight to the stream** with `appendChat('assistant', …)`, so the text
  appeared in the chat box but was never handed to speech subscribers — a TTS adapter stayed silent
  while the page showed the words. It now uses `appendAssistantSay()`, which writes the stream *and*
  emits the speech event, matching what `watch_together({say})` does.

### Fixed

- **The plugin passed the browser's debug port to `ensureChatSession()`**, so the chat server tried
  to bind 9333 — the port the browser is already using. The bind failed, the error was swallowed,
  and the chat box silently never came up in DSH. It now uses the chat port (9377) as intended.
  This also mattered for the extension: that server is where reports land.

### Removed — the OS media session (SMTC) backend is gone

Position used to have two sources: the browser's DevTools port, and Windows' system media controls
(read by a bundled `watch_smtc.py`). **SMTC is deleted**, along with everything that only existed
because of it:

- `src/watch-probe.js` (121 lines) and `src/watch_smtc.py` (62 lines)
- `src/resolve-playing.js` (153 lines) — it reversed a *title* into a source by searching filenames
  and then Bilibili. With CDP the page URL is the source, so this whole "guess the film" path is
  gone (it was also the thing most likely to pick the wrong video)
- the `winrt` Python dependency (three packages) and the interpreter search
- most of the extrapolation policy in `position.js`: the cap drops 180 s → 60 s, `FRESH_MS`
  becomes 5 s, and the safety margin now only applies after a *missed* read
- `pickSession` / `probePlayback` / `describeStatus` and the `probe` injection point

Rationale: SMTC's `Position` only refreshes on player events (measured gaps of 143 s and 216 s), so
treating it as a live position required extrapolating, and extrapolating over a wrong pause means
every later segment is built on a wrong cursor. The benefit — "watch in whatever player you like" —
did not survive contact with how it actually behaved.

What you give up: you now watch inside the dedicated browser window
(`scripts/start-edge-debug.cmd`). Chromium 136+ refuses to open a DevTools port on the default
profile, so that window necessarily has its own profile and needs a one-time login.

### Fixed

- **`loop.built` / `loop.dur` / `loop.sourceUrl` leaked across films.** Starting a second watch
  session reused the previous film's duration, so the first read of the new film looked like a
  "video changed" event and stopped the loop immediately; `built` made prefetch skip segments it had
  built for the old film. Both are now reset when the source changes.
- **`startWatchLoop` used `Date.now()` for the anchor while pricing time off its injected clock**,
  which made every simulated read look minutes old. It now uses the injected clock.
- **The CLI's `pos()` never read SMTC at all**, so the CLI was browser-only even while the plugin
  had a fallback. Moot now that SMTC is gone, but it is why the tool seemed to demand a special
  browser.

### Removed — dead code trimmed so there is one decision path

Two functions that duplicated live logic and were never called in production are gone:

- `dueDecision` (in `src/timer.js`) — a pure "should I speak now" decision that shadowed
  `position.shouldSpeak`. Nothing in the loop ever called it; only a test exercised the abandoned
  design. The "pause too long → stop" intent it carried is now not implemented (see note below).
- `depthForBuffer` (in `src/batches.js`) — a count-based lookahead that duplicated `windowFor`,
  which the loop actually uses (position-based, so the invariant holds at every position, not just
  at segment starts). Its tests were redundant guards of that same invariant.

Net: 13 tests removed (8 for `dueDecision`, 5 for `depthForBuffer`); `windowFor`'s existing tests
already cover "lookahead ≥ N seconds at every position", so no coverage was lost.

### Changed — idle auto-stop now also covers a paused-and-abandoned video

The loop used to only stop itself on "no movement" when the last reading was a *playing* sample
(`why === 'recent-refresh'`). A paused video reports a frozen position forever — `estimate` returns
`why: 'paused'`, never stale — so pausing and walking away left the loop polling indefinitely. The
idle check now also fires on a frozen *paused* position, after the same `2 × segment` grace period,
and wakes you with "停了一会儿" so you can resume by calling `watch_together` again.

### Fixed — voice adapter no longer hard-codes a voice

`examples/voice-edge-tts/index.mjs` used to fall back to `zh-CN-XiaoxuanNeural` when
`~/.dsh/tts.json` had no `voice`. That baked one person's voice into the example, so shipping it
would have dragged that choice into everyone's install. It now falls back to the neutral
`zh-CN-YunxiNeural` and prints a one-line hint telling you to set `voice` in `~/.dsh/tts.json`
(e.g. `"voice": "zh-CN-XiaoxuanNeural"`). Nothing about the voice ships in the package — you mount
the adapter via `~/.dsh/voice.json` (or `DSH_VOICE_ADAPTER`) and pick the voice yourself.

## Earlier — 0.1.0 draft, never published (2026-10-30)

The first cut as a standalone plugin. It was not published under this number; the version line now
starts at 0.0.7, so this section is kept purely as a record of how the feature set got here. The feature existed inside `dsh-video-storyboard` 0.4.x as
`src/watch/`; it is now its own package with its own entry point, its own version, and a one-way
dependency on `dsh-video-storyboard`.

### Added

- **`watch_together`** — watch a video together with a text-only agent. Instead of one whole-film
  storyboard, it follows the user's **real playback position** and hands over one segment at a time,
  `lead` seconds before the segment ends. The next segment is built while the user is still watching
  the current one, so delivery is perceived as instant (4/4 measured deliveries at 0.0 s).
- **Ramp-up start.** Segment lengths grow `[60, 120, 180, 240]` → `segment`, so the first line lands
  around 45 s instead of after a full 5-minute batch. `ramp: []` disables the ladder.
- **Double buffering.** `depth: 2` keeps the current batch plus the next one built, and starts the
  one after that while the user watches.
- **Playback position straight from the page.** It reads `<video>.currentTime` over the DevTools
  protocol, so the value is exact, and the page URL becomes the source (`file:///D:/x.mp4` → local
  path) — no searching, no downloading, no asking. Never released with the OS media session (SMTC)
  backend documented below: SMTC's `Position` only refreshes on events, so using it as a live
  position meant extrapolating, and a wrong position poisons every later segment.
- **Honest confidence levels.** The plugin reads every 15 s and extrapolates in between, which is
  normal and self-correcting. What it refuses to do is keep extrapolating after it has *missed* a
  read: past 20 s it demands an extra 5 s of margin before speaking, and past 60 s it stops
  guessing and asks for `cursor` instead.
- **The speech seam, with no engine.** `src/speech-bus.js` exposes `onSpeech(handler, { voice })`,
  `emitSpeech()`, `speechEvents()` and `lastSpeech()`. The plugin ships no engine, no default
  adapter and no voice parameters; `watch_together` results carry `speech: [{ at, text, state }]`
  and the loop emits `state: 'due'` when a line is actually due.
- **Adapters loaded by path.** `~/.dsh/voice.json` `{ "adapter": "<path or module>" }` (or
  `DSH_VOICE_ADAPTER`) is `import()`ed once at startup; the module exports `attach(api)` and returns
  a detach. Nothing is bundled, and a failure only logs a warning.
- **`examples/voice-edge-tts/`** — a working adapter (edge-tts → `ffplay` → system-voice fallback).
  It prints `[voice 03:11.4] <line>` to stderr for every line that comes due; that log, not the
  audio, is what you want when checking *when* text fires.
- **One text stream for the chat box.** `chat.jsonl` carries `line` (scripted), `assistant`
  (interjection) and `user`, with `say: true` marking the speakable ones.
  `watch_together({ say: "…" })` is how the model gets its interjection in — the plugin cannot read a
  normal reply. `attachSpeechToChat()` subscribes with `voice: false`, so a display-only consumer can
  never silence the loop.
- **A localhost chat page** (`/` full view, `/widget` capsule) with an `/api/messages` long-poll and
  an `/api/say` callback. This is the only channel that actually reaches a blocked `watch_together`
  call — messages typed into the host's own input box are appended to the session log *after* the
  blocking call returns (measured: 42 s of polling, 0 bytes written).
- **`examples/floating-chat/window.py`** — a real floating window without a browser: frameless,
  always-on-top, translucent, stdlib tkinter only. Reads the same `chat.jsonl`.
- **`bin/watch.mjs`** — a CLI shell for sessions that have no `watch_together` tool. It imports the
  same `src/`, so behaviour cannot drift from the plugin.

### Fixed

- **The CLI imported pre-refactor paths** (`src/browser-time.js`, `src/pipeline.js`, …) that no
  longer exist, so `bin/watch.mjs` could not even start. All imports now resolve through the
  `dsh-video-storyboard` package name.

### Changed

- `detachAdapters()` no longer reaches into the bus's private subscriber map; it calls
  `__resetSpeech()` from `speech-bus.js`.
- `watch-run.js` imported `./watch.js` twice; merged into one import.

### Known limits

- **Speaker separation is not attempted.** Measured on the reference machine: per-sentence cam++
  embeddings split single-speaker material into 6 speakers; demucs pre-separation made no difference
  (median similarity 0.62 → 0.61); FunASR's `ClusterBackend` returns "one speaker" outright below 20
  speech segments — short clips are outside its operating range by design.
- **Interjection audio can collide with a line already being spoken.** Windows mixes both SAPI
  instances, so `say` occupies `quiet-until.json` before speaking and `cue` skips lines inside that
  window (it skips rather than defers — deferring desynchronises from the picture). The remaining
  gap is the 3–8 s while a line is mid-speech, which cannot be cut short.
- **CRLF-less assumption.** The chat page replaces `__PORT__` in the templates per start; changing
  the port while a browser tab is already open requires a reload.
