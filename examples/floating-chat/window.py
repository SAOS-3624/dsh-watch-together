#!/usr/bin/env python3
"""floating-chat — 一个**独立悬浮**的陪看聊天窗，不需要浏览器。

为什么不用浏览器：浏览器那条路（`documentPictureInPicture`）能置顶，但要先开一个标签页；
而且它只是"把标签页搬进小窗"，关掉标签页就没了。这里是真·独立进程的原生窗口。

读的是同一份 `chat.jsonl`（插件写的统一文本流：剧本台词 / 插话 / 你自己的话），
写回去的也是同一份 —— 所以浏览器那个框开着也不会冲突，两个前端看的是同一条时间线。

用法（**必须用带 tkinter 的 Python**，Windows 商店版自带）：

    pythonw examples/floating-chat/window.py        # 无控制台
    python  examples/floating-chat/window.py        # 有控制台，方便看报错

窗口：无边框圆角、置顶、按住顶部拖动、右下角可拉伸；回车发送；Esc 关闭。
「麦」按钮：开实时语音输入（说的每句话自动转成文字，写进同一条流）。

依赖：标准库 tkinter（不装任何第三方包）。
      「麦」会另起 `mic.py` 进程，那条路需要 sounddevice+numpy+sherpa-onnx，
      所以用 **ASR 的 venv**（可用 `DSH_ASR_PYTHON` 指定）来跑，跟本窗口的解释器无关。

## 2026-10-31 重做

用户的原话是"这个悬浮窗太丑了"。四件事一起改：

1. **DPI 感知**：不声明 DPI 的 Tk 窗口在高分屏上被系统整块拉伸（125%/150%），
   字和线条全是虚的 —— 这是"丑"最大的一个来源。现在先 `SetProcessDpiAwareness(2)`
   再建窗口，尺寸/字号按真实 DPI 缩放。
2. **真·气泡**：以前是往一个 Text 里塞带背景色的行，整段满宽、右对齐时像一条色带。
   现在每条消息是一块**圆角气泡**（Canvas 画底 + Label 排版），宽度贴着内容：
   我说话靠右、台词带一条竖线、系统提示是一行灰字。
3. **不再整份重读**：以前每 200ms 把 chat.jsonl 全解析一遍，两小时一场几千条会越来越慢。
   现在只读上次之后新追加的字节（和 `src/chat-store.js` 的 watcher 同一套思路），
   开场只回放最后 60 条。
4. **不抢焦点、不抢滚动**：以前窗口一开就把系统焦点从浏览器抢走（敲空格想暂停，
   结果打进了聊天框）；现在只在窗口内部指定焦点。往上翻历史时，新台词也不把你拽回底部。
"""

import json
import math
import queue
import os
import subprocess
import sys
import threading
import time

try:
    import tkinter as tk
except Exception as exc:  # pragma: no cover - 环境问题，直接说清楚
    sys.stderr.write(
        "这个 Python 没有 tkinter，换一个。\n"
        "  Windows 商店版 Python 自带；也可以用 python.org 的官方安装包（勾选 tcl/tk）。\n"
        f"  当前解释器：{sys.executable}\n  错误：{exc}\n"
    )
    raise SystemExit(2)

# ---------------------------------------------------------------- 真模糊（可选依赖）
#
# ## 为什么需要 Pillow
#
# tkinter 的控件**必须填不透明底色**，所以窗口级模糊（Win11 亚克力 / Mica /
# CSS backdrop-filter）都会被控件整块挡住 —— 换语言也一样，问题在渲染层不在语言。
#
# 唯一能在 tkinter 上做出**真毛玻璃**的办法：把窗口背后的桌面截下来、高斯模糊、
# 当成底板贴进窗口。背后内容真的被糊掉了，不是模拟。
#
# 实测成本（本机 2560×1600 / 150% 缩放）：区域截屏 44ms + 裁剪缩放模糊放大 8ms。
# 所以只在**开窗**和**移动/缩放结束时**各截一次，平时零开销 —— 底板糊成色块以后，
# 背后视频怎么变都看不出来，没必要持续刷新。
#
# Pillow 没装就自动回退到原来的纯色玻璃（`HAVE_PIL = False`），绝不因此起不来。
try:
    from PIL import Image, ImageChops, ImageDraw, ImageEnhance, ImageFilter, ImageGrab, ImageStat
    try:
        from PIL import ImageTk
        HAVE_PIL = True
    except Exception:      # 没有 tkinter 支持的 Pillow（少见）
        HAVE_PIL = False
except Exception:          # 压根没装 Pillow
    HAVE_PIL = False

# **mss 是可选的**：同样整屏抓取，它 38ms、ImageGrab 71ms（本机 2560×1600 / 150% 缩放实测），
# 装了就自动用；没装就退回 ImageGrab，行为不变。它给的是**物理分辨率**，
# 而 `_grab_backdrop` 用 `small.size / (sw, sh)` 算比例，DPI 缩放会自动被吸收。
try:
    import mss as _mss
    HAVE_MSS = True
except Exception:
    _mss = None
    HAVE_MSS = False

# ---------------------------------------------------------------- 配色
#
# ## 2026-11-01 二版：真正的液态玻璃（Apple Liquid Glass）
#
# 一版被用户判为"太丑了"。复盘下来不是圆角不够大，是四件事同时错了：
#
#   ① **整体发蓝**。一版的玻璃底色是 `#171a21`（蓝灰）。玻璃的颜色应该**全部来自背后
#      的画面**，一旦自己带色相，背后再怎么鲜艳都要先跟这层蓝打架 —— 出来就是"脏"。
#      二版底色改成中性黑 (10,11,13)，只做明度，不碰色相。
#   ② **斜纹**。一版的高光是用 `create_line` 一条条斜线堆出来的，步进 3px、线宽 3px，
#      在暗底上直接长出一片"麻布纹"，是截图里最刺眼的瑕疵。二版所有渐变都在 16×16 上
#      算完再双三次放大，天然平滑。
#   ③ **气泡是实心色块**。一版气泡填死色 `#3a4459`，等于在玻璃上贴了张不透明卡纸，
#      背后画面一到气泡就断。二版气泡是**从同一张底板裁出来的真玻璃**（见 `plate()`），
#      只是额外加一层白/蓝 wash —— 它透出来的就是身后的画面，只是更亮一点。
#   ④ **标题栏和输入栏是不透明条**。一版靠 `tk.Frame` 摆控件，而 Tk 的 Frame 必须填
#      不透明白底，直接把玻璃盖成一块死黑。二版把标题栏和输入栏**全部画在 Canvas 上**，
#      只留 `Entry` 一个真控件（它必须实心，正好塞进"内凹槽"里）。
#
# 三条硬指标（照着 HIG 做的，不是凭感觉调色）：
#   • **自适应压暗**：先量这块底板的平均亮度 L，再反解"要压到 L'≤84 需要多少不透明度"
#     —— `a = (L-84)/(L-12)`，夹在 0.34~0.74。背后是白网页时自动加深、是暗场景时保持
#     通透。这是白字在任何画面上都读得清的前提，也是 HIG 说的 adaptive self-tinting。
#   • **一条真的边**：1px 超椭圆环，亮度从左上 92% 衰减到右下 14%，再叠一道内侧底部
#     暗线。苹果的玻璃"有厚度"全靠这两条；四条直 chord 画不出圆角，一眼假。
#   • **镜片感**：底板先放大再按边缘权重盖回去（`refract`），边缘会被"掰"进去一点，
#     加上通道错位（`chromatic`），才有了隔着一层玻璃看东西的物理线索。

BG = GLASS_FILL = "#0b0c0e"
BORDER = "#22252b"
TEXT = "#f2f3f5"
MUTED = "#9aa2af"
TIME_FG = "#8c94a1"       # 时间戳：比正文暗、但要在模糊背景上读得出来
DIM = "#6e7683"
ACCENT = "#0a84ff"        # iOS 深色模式系统蓝
ACCENT_HI = "#4ca6ff"
DANGER = "#ff453a"
KEY = "#010203"           # 圆角抠图用的透明键色（只给根窗口和画布用）

INK = (10, 11, 13)        # 玻璃本体（中性；色相交给背后的画面）
WHITE = (255, 255, 255)
ACCENT_RGB = (10, 132, 255)

HEAD_BG = "#0b0c0e"       # 兜底色（拿不到截图、走纯色回退时用）
FIELD_BG = "#15171c"      # 输入槽：Entry 只能是不透明平色，这里做成"内凹"的深一档

# 圆角：苹果的同心半径 —— 外面 26、悬浮条 20、气泡 16（都小于 1/2 高，不进胶囊区）
PANEL_R = 26
SLAB_R = 20
BUBBLE_R = 16
# 窗口最小宽度（逻辑像素，未乘 DPI）。**不能比这个再窄**：中文正文一行
# 只放得下 9 个字，一段 100 字的台词会撑成 15 行、比视口还高，排版直接崩。
MIN_W = 460

# 角色 → (玻璃类型, 文字色, 竖线色 或 None, 抬头)
#
# **`line` 和 `assistant` 必须完全相同**（2026-11-01 用户要求）：以前台词是暖黄、陪看是冷灰，
# 一条流里两种配色，读起来像两个人在说话。现在只有"它说的"和"我说的"两种。
ROLE = {
    "line": ("bubble", TEXT, None, ""),
    "assistant": ("bubble", TEXT, None, ""),
    "user": ("me", "#eaf2ff", None, ""),
}

SS = 96.0                 # 基准 dpi


# ---------------------------------------------------------------- 数据

def cache_dir():
    d = os.environ.get("DSH_VIDEO_CACHE_DIR")
    if d:
        return d
    local = os.environ.get("LOCALAPPDATA")
    if os.name == "nt" and local:
        return os.path.join(local, "dsh-video-storyboard", "cache")
    return os.path.join(os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache"),
                        "dsh-video-storyboard")


CHAT_FILE = os.path.join(cache_dir(), "chat.jsonl")

HERE = os.path.dirname(os.path.abspath(__file__))
MIC_SCRIPT = os.path.join(HERE, "mic.py")
CONFIG = os.path.join(os.environ.get("DSH_HOME") or os.path.expanduser("~/.dsh"),
                      "watch-window.json")


def read_config():
    try:
        with open(CONFIG, "r", encoding="utf-8") as f:
            return json.load(f) or {}
    except Exception:
        return {}


def write_config(patch):
    """合进 ~/.dsh/watch-window.json（插件那边也读它，所以只加键、不覆盖）"""
    cfg = read_config()
    cfg.update(patch or {})
    try:
        os.makedirs(os.path.dirname(CONFIG), exist_ok=True)
        tmp = CONFIG + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
        os.replace(tmp, CONFIG)
    except Exception:
        pass


def asr_python():
    """跑 mic.py 的解释器：要有 numpy/sounddevice/sherpa-onnx，本机就是 ASR 的 venv。

    为什么不能直接用本窗口这个解释器：悬浮窗必须用**带 tkinter** 的那个
    （商店版 Python），而它多半没有 numpy —— 两边不是同一个 Python。
    """
    for cand in (os.environ.get("DSH_ASR_PYTHON"),
                 r"D:/asr-local/.venv/Scripts/python.exe",
                 os.path.join(HERE, "..", "..", "..", "asr-local", ".venv", "Scripts", "python.exe")):
        if cand and os.path.exists(cand):
            return os.path.abspath(cand)
    return sys.executable          # 兜底：缺依赖时 mic.py 自己会打印清楚缺什么


def append_user(text):
    os.makedirs(os.path.dirname(CHAT_FILE), exist_ok=True)
    with open(CHAT_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps({"role": "user", "text": text, "at": int(time.time() * 1000)},
                           ensure_ascii=False) + "\n")


def mmss(t):
    """播放秒 → mm:ss.d（按**视频位置**显示台词时间）。

    **当前没有调用方**：时间戳已统一成墙钟（见 `_render`）。留着是因为
    "按播放位置显示"是一个随时可能被要回去的选项，删了还得再写一遍。
    """
    try:
        s = max(0.0, float(t))
    except (TypeError, ValueError):
        return ""
    return f"{int(s // 60):02d}:{s % 60:04.1f}"


def clock(ms):
    """墙钟毫秒 → HH:MM:SS（这句话是什么时候说出来的）。

    **带秒**：陪看里一段是 2–5 分钟，同一段里可能连着好几条，只到分钟的话
    一屏全是同一个 `03:36`，时间戳就失去区分作用了。
    """
    try:
        return time.strftime("%H:%M:%S", time.localtime(float(ms) / 1000.0))
    except (TypeError, ValueError, OSError):
        return ""


# ---------------------------------------------------------------- 绘制

def dpi_aware():
    """先声明 DPI 感知，再建任何窗口。不声明的话 Windows 会把整窗当 96dpi 位图拉伸。"""
    if os.name != "nt":
        return
    try:
        import ctypes
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(2)      # per-monitor v2
        except Exception:
            ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass


def round_rect(cv, x1, y1, x2, y2, r, n=2.2, **kw):
    """Canvas 画圆角矩形。

    **不用 `smooth=True` 的多边形**：smooth 是把折线的角"抹圆"，实际半径明显小于设定值
    （要 22 出来只有 14），做液态玻璃时圆角是主角，量不准就全歪。这里直接按四个角
    采样圆弧（每角 12 段），`smooth=False` 拼接 —— 半径是多少就是多少。

    `n` 走和 `squircle_mask` 同一个超椭圆（2.2 = 比正圆饱满一点点）。**一版这里是 5**，
    指数 2/n=0.4 会把角"撑"到矩形的对角线上，画出来的胶囊两端几乎是方的 ——
    输入框看着"没有圆角"就是这个原因。
    """
    r = max(0, min(r, (x2 - x1) / 2, (y2 - y1) / 2))
    if r <= 0.5:
        return cv.create_rectangle(x1, y1, x2, y2, **kw)
    pts = []
    for cx, cy, a0 in ((x2 - r, y1 + r, -90), (x2 - r, y2 - r, 0),
                       (x1 + r, y2 - r, 90), (x1 + r, y1 + r, 180)):
        for i in range(13):
            a = math.radians(a0 + i * (90.0 / 12))
            ca, sa = math.cos(a), math.sin(a)
            dx = r * (abs(ca) ** (2.0 / n)) * (1 if ca >= 0 else -1)
            dy = r * (abs(sa) ** (2.0 / n)) * (1 if sa >= 0 else -1)
            pts.extend([cx + dx, cy + dy])
    return cv.create_polygon(pts, smooth=False, **kw)


def text_on_glass(cv, x, y, text, *, font, fill, tags, anchor="nw",
                  width=None, offset=1, shadow="#05070a", **kw):
    """**带影子的文字**：先画一个右下偏移的深色副本，再画正文。

    为什么要影子：玻璃变清晰以后，背后的字会透上来和正文打架（1/8 底板那会儿糊成
    一片反而干净）。真玻璃上的字都有这层 —— 它不挑背景明暗，白字压在亮处也立得住。
    取自 PR #15 的 `_add_text_shadows()`，但那边是**逐字**建 item（每个字一个 canvas
    对象），我们这里整段一个影子：item 数不翻倍，滚动列表时才不会卡。
    """
    if shadow:
        cv.create_text(x + offset, y + offset, text=text, font=font,
                       fill=shadow, anchor=anchor, width=width, tags=tags, **kw)
    return cv.create_text(x, y, text=text, font=font, fill=fill,
                          anchor=anchor, width=width, tags=tags, **kw)


def _mix(c1, c2, t):
    """两个 #rrggbb 之间取 t（0→c1，1→c2）。用来做渐变和高光。"""
    t = 0.0 if t < 0 else (1.0 if t > 1 else t)
    a = [int(c1[i:i + 2], 16) for i in (1, 3, 5)]
    b = [int(c2[i:i + 2], 16) for i in (1, 3, 5)]
    return "#%02x%02x%02x" % tuple(int(round(a[k] + (b[k] - a[k]) * t)) for k in range(3))


def squircle_mask(size, radius, n=2.2, ss=2):
    """生成**超椭圆圆角**遮罩（苹果的连续曲率圆角）。

    ## 为什么不是 `rounded_rectangle`
    普通圆角矩形是"直边 + 四分之一圆"。直线曲率 0、圆弧曲率 1/r，两者接缝处
    曲率**突然跳变**（G1 断点）—— 眼睛能看出那道"棱"。超椭圆把曲率从直边的 0
    连续长到角上的峰值（G2），过渡是"化"开的。

    ## n 的取值
    `|x/r|^n + |y/r|^n = 1`。n=2 是正圆（= CSS 的 border-radius），n 越大角越"方"。
    **一版取了 5，结果四个角几乎就是直角**（n=5 时 y 到半径一半，向内只收 0.6%），
    远处看就是一块板子 —— 这是"太丑"里最隐蔽的一条。2.2 比正圆饱满一点点。

    ## 为什么按行扫、为什么用 BOX 缩小
    逐像素判内外是 O(w·h) 次幂运算；超椭圆可以解出每行的左右边界，一行一条横线，
    复杂度 O(h)。2 倍超采样之后按 2×2 取平均（`Image.BOX`）—— 和 LANCZOS 在"整数倍
    缩小"上结果几乎一致，但快 4 倍（面板遮罩 15ms → 4ms）。
    """
    w, h = max(1, int(size[0])), max(1, int(size[1]))
    if w < 3 or h < 3:
        return Image.new("L", (w, h), 255)
    ss = max(1, int(ss))
    W, H = w * ss, h * ss
    r = max(0.5, min(float(radius) * ss, W / 2.0, H / 2.0))
    m = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(m)
    for y in range(H):
        dy = min(y, H - 1 - y)
        if dy >= r:
            x = 0.0
        else:
            t = 1.0 - dy / r
            x = r * (1.0 - (1.0 - t ** n) ** (1.0 / n))
        d.line([(x, y), (W - 1 - x, y)], fill=255)
    if ss > 1:
        m = m.resize((w, h), Image.BOX)
    return m


def _row_edge(y, o, H, R, n=2.2):
    """超椭圆在**第 y 行**、整体内缩 `o` 之后的左边界（右边界对称）。

    内缩后的形状是"同样的超椭圆缩小 o、角半径也小 o"，它在 y 方向只覆盖
    `[o, H-o)`；这一行落在外面时返回 None（那说明整行都在环里）。
    """
    yy = y - o
    span = H - 2 * o
    if span <= 0 or yy < 0 or yy > span - 1:
        return None
    rr = R - o
    if rr <= 0.5:
        return o
    dd = min(yy, span - 1 - yy)
    if dd >= rr:
        return o
    t = 1.0 - dd / rr
    return o + rr * (1.0 - (1.0 - t ** n) ** (1.0 / n))


def _ring(w, h, radius, inset=0.0, width=1.4, ss=2):
    """贴轮廓的等宽环：距外沿 `inset` 起、宽 `width`，一遍扫完，不建中间图。

    ⚠️ 这里踩过一个很隐蔽的坑：第一版只解了"外沿"和"内沿（内缩 inset）"两条边界，
    **`width` 根本没参与计算** —— 结果画出来的是"从边上到 inset 的一条带"，`inset=0`
    时宽度为零（白边整条消失），`inset=2` 时变成外侧 2px 的带（内侧暗线跑到边上去，
    把白边压暗）。表现就是"玻璃没边、看着发灰"。现在按 inset 和 inset+width 两条
    真边界算，中间那段才是环。

    以前（0.1.0）是"两个填充遮罩相减"：每块玻璃 5~6 个环，每个环建两张 w×h 的 L 图
    再相减，665×594 的面板单这一项 ~100ms。现在每行两根短线，O(h)，快 25 倍。
    """
    w, h = max(4, int(w)), max(4, int(h))
    ss = max(1, int(ss))
    W, H = w * ss, h * ss
    R = max(0.5, min(float(radius) * ss, W / 2.0, H / 2.0))
    o1 = max(0.0, float(inset) * ss)
    o2 = o1 + max(0.6, float(width) * ss)
    m = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(m)
    for y in range(H):
        xa = _row_edge(y, o1, H, R)
        if xa is None:
            continue                      # 整行在环的垂直范围之外（不会发生，兜底）
        lo_l, lo_r = xa, W - 1 - xa
        xb = _row_edge(y, o2, H, R)
        if xb is None:                    # 内沿还没开始 → 这一行整段都是环（顶/底带）
            d.line([(lo_l, y), (lo_r, y)], fill=255)
            continue
        hi_l, hi_r = xb, W - 1 - xb
        if hi_l > lo_l:
            d.line([(lo_l, y), (hi_l, y)], fill=255)
        if lo_r > hi_r:
            d.line([(hi_r, y), (lo_r, y)], fill=255)
    if ss > 1:
        m = m.resize((w, h), Image.BOX)
    return m


def _ramp(size, wx=0.42, wy=0.90, lo=0.0, hi=1.0, gamma=1.0):
    """线性渐变（L 图）：`(wx, wy)` 是"最亮的方向"，默认左上最亮。

    **在 16×16 上算再双三次放大**。直接按像素画渐变的边（就是把线一条条叠起来）
    会在暗底上留下规则的斜纹 —— 一版那片"麻布"就是这么来的。
    """
    w, h = max(1, int(size[0])), max(1, int(size[1]))
    n = 16
    raw = [[0.0] * n for _ in range(n)]
    lo_v = hi_v = None
    for j in range(n):
        for i in range(n):
            u = (i + 0.5) / n * 2.0 - 1.0
            v = (j + 0.5) / n * 2.0 - 1.0
            t = -(wx * u + wy * v)          # 左上最大
            raw[j][i] = t
            lo_v = t if lo_v is None else min(lo_v, t)
            hi_v = t if hi_v is None else max(hi_v, t)
    small = Image.new("L", (n, n), 0)
    px = small.load()
    span = max(1e-6, hi_v - lo_v)
    for j in range(n):
        for i in range(n):
            t = (raw[j][i] - lo_v) / span
            t = lo + (hi - lo) * (t ** gamma)
            px[i, j] = int(round(255 * _clamp(t, 0.0, 1.0)))
    return small.resize((w, h), Image.BICUBIC)


def _clamp(v, lo, hi):
    return lo if v < lo else (hi if v > hi else v)


def _scale_channel(ch, k, size):
    """把单个通道按比例 k 缩放后居中裁回原尺寸（k>1 放大、k<1 缩小）"""
    w, h = size
    nw, nh = max(1, int(round(w * k))), max(1, int(round(h * k)))
    z = ch.resize((nw, nh), Image.BICUBIC)
    left, top = (nw - w) // 2, (nh - h) // 2
    return z.crop((left, top, left + w, top + h))


def chromatic(img, strength):
    """**色散（chromatic aberration）**：三个颜色通道各自缩放一点点。

    真实玻璃对不同波长折射率不同（红光 n=1.5143 / 蓝光 1.5224，差 1%），
    越靠边偏移越大，于是高对比边缘会渗出红蓝彩边 —— 这是"隔着玻璃看"
    最难伪造、也最容易被眼睛认出来的线索。

    物理上 1% 在 UI 尺度根本看不见，所以要放大约 8 倍（`strength` 就是那个倍数）。
    只做整体缩放、不做逐像素位移：在模糊图上够了，且 CPU 成本可以忽略。
    """
    if strength <= 0:
        return img
    try:
        w, h = img.size
        r, g, b, a = img.split()
        d = strength * 0.004                      # 1% 的物理差异 × 放大倍数
        r = _scale_channel(r, 1.0 - d, (w, h))    # 红：略放大（往里收）
        b = _scale_channel(b, 1.0 + d, (w, h))    # 蓝：略缩小（往外散）
        return Image.merge("RGBA", (r, g, b, a))
    except Exception:
        return img


def refract(img, bevel_px, amount=0.76):
    """**边缘折射**：沿圆角矩形的 SDF 法线**向外采样**，把框外的画面折进边缘一带。

    这是从 PR #15 换掉原来那套的结果。原来那套是"整图放大一点、再按边缘权重把放大版
    盖回原图" —— 边缘显示的是**自己靠中心的内容被放大**，像贴了层凸透镜贴纸；真玻璃
    不是这样：边上那一窄条里塞的是**框外**的场景，被压扁了折进来。

    做法（和 #15 同源，参数按我们的 1/8 底板换算）：
      · 圆角矩形的 signed distance field（SDF），梯度就是指向外的法线；
      · `t = clamp(1 - d/band)`，`mag = amp * t²` —— 贴边位移最大，往内二阶衰减到 0；
      · 采样坐标沿法线**向外**偏 `mag`，于是边缘取到的是框外的像素。

    没有 numpy 就退回原来那套（`_refract_legacy`）：numpy 只是让这件事便宜，
    不该为了一个视觉效果把整个窗口变成装不上 numpy 就跑不起来。
    """
    if bevel_px < 2:
        return img
    try:
        import numpy as np
    except Exception:
        return _refract_legacy(img, bevel_px, amount)
    try:
        w, h = img.size
        band = max(2.0, float(bevel_px) * 1.6)     # 折射带宽度
        amp = max(1.0, float(bevel_px) * 0.8 * amount)   # 贴边处的最大位移
        # 小图上再缩就没内容可取了，所以 1/8 底板直接原尺寸算
        f = 1 if min(w, h) < 160 else 2
        hw, hh = max(4, w // f), max(4, h // f)
        yy, xx = np.mgrid[0:hh, 0:hw].astype(np.float32)
        r = max(1.0, min(hw, hh) * 0.14)           # 圆角半径按尺寸估（底板不带半径）
        cx, cy = hw / 2.0, hh / 2.0
        qx = np.abs(xx - cx) - (cx - r)
        qy = np.abs(yy - cy) - (cy - r)
        sdf = (np.hypot(np.maximum(qx, 0.0), np.maximum(qy, 0.0))
               + np.minimum(np.maximum(qx, qy), 0.0) - r)
        gy, gx = np.gradient(sdf)
        nrm = np.maximum(np.hypot(gx, gy), 1e-6)
        d = -sdf                                   # 到边的距离（内部为正）
        t = np.clip(1.0 - d / (band / f), 0.0, 1.0)
        mag = (amp / f) * t * t
        sx = np.rint(xx + gx / nrm * mag).astype(np.int32)
        sy = np.rint(yy + gy / nrm * mag).astype(np.int32)
        np.clip(sx, 0, hw - 1, out=sx)
        np.clip(sy, 0, hh - 1, out=sy)
        small = img if f == 1 else img.resize((hw, hh), Image.BILINEAR)
        arr = np.asarray(small.convert("RGB"))
        out = Image.fromarray(arr[sy, sx])
        if f != 1:
            out = out.resize((w, h), Image.BILINEAR)
        return out.convert(img.mode)
    except Exception:
        return _refract_legacy(img, bevel_px, amount)


def _refract_legacy(img, bevel_px, amount=0.76):
    """老的"整体放大再按边缘权重盖回"。没有 numpy 时的兜底。"""
    try:
        w, h = img.size
        k = 1.0 + (amount * bevel_px / max(w, h)) * 2.0
        big = img.resize((max(1, int(w * k)), max(1, int(h * k))), Image.BICUBIC)
        bw, bh = big.size
        big = big.crop(((bw - w) // 2, (bh - h) // 2,
                        (bw - w) // 2 + w, (bh - h) // 2 + h))
        f = 4 if min(w, h) >= 160 else 2
        ew, eh = max(8, w // f), max(8, h // f)
        edge = Image.new("L", (ew, eh), 0)
        ed = ImageDraw.Draw(edge)
        steps = max(2, int(bevel_px / f))
        for i in range(steps):
            v = int(255 * (1.0 - i / float(steps)) ** 1.6)
            ed.rectangle([i, i, ew - 1 - i, eh - 1 - i], outline=v, width=1)
        edge = edge.resize((w, h), Image.BILINEAR)
        return Image.composite(big, img, edge)
    except Exception:
        return img


def _edge_weight(w, h, radius, band):
    """贴边一圈的权重（L 图）：边上 255、往里 band 像素衰减到 0。

    **在 1/4 尺寸上算再放大**：这是个光滑的软边，缩上去看不出差别，但高斯模糊的成本
    直接降到 1/16（面板那一块从 40ms 掉到 3ms）。
    """
    f = 4 if min(w, h) >= 160 else (2 if min(w, h) >= 80 else 1)
    sw, sh = max(8, w // f), max(8, h // f)
    m = _ring(sw, sh, max(1.0, radius / f), 0, max(1.0, band / f), ss=1)
    m = m.filter(ImageFilter.GaussianBlur(max(0.8, band / f * 0.45)))
    return m.resize((w, h), Image.BILINEAR) if f > 1 else m


def _corner_weight(w, h, radius, spread=1.4, base=0.82):
    """色散的强度权重：**整圈倒角都有，四个角再强一档**。

    物理依据：这块板的边缘不是刀口，是一条**圆倒角（fillet）**——从正面看是"四条直边
    加四个圆角"，但从侧面看，整圈都是同一个半径的圆弧。光从那圈弧上出去时每一处都会
    偏折、都会分光，所以彩边应该是**绕一圈**的；四个角是"两个方向同时在弯"（复合曲率），
    偏折更狠，彩边也就更明显。

    所以这里不是"只给角"，而是：底座 0.82 铺满（靠 `_ring` 自己限制在边上），
    角上四个团叠到 1.0。一版我按"只有角才有曲率"写成角独占，那是把倒角当成刀口了。
    """
    # 同样是"光滑的团"，在 1/4 尺寸上算再放大（成本 1/16）
    f = 4 if min(w, h) >= 160 else (2 if min(w, h) >= 80 else 1)
    sw, sh = max(8, w // f), max(8, h // f)
    m = Image.new("L", (sw, sh), int(255 * base))
    d = ImageDraw.Draw(m)
    r = max(1.5, float(radius) / f)
    rad = r * spread
    for cx, cy in ((r, r), (sw - r, r), (r, sh - r), (sw - r, sh - r)):
        d.ellipse([cx - rad, cy - rad, cx + rad, cy + rad], fill=255)
    m = m.filter(ImageFilter.GaussianBlur(max(0.8, r * 0.55)))
    return m.resize((w, h), Image.BILINEAR) if f > 1 else m


def chroma_edge(img, radius, amount, bend=None):
    """**边缘色散**：只在玻璃的边上把红/蓝通道各缩放一点点。

    真实玻璃对不同波长折射率不同（n_红 1.5143 / n_蓝 1.5224），隔着它看东西，越靠边
    色差越大，于是高对比的边界会渗出橙/青彩边 —— 这是"隔着玻璃"最难伪造、也最容易
    被眼睛认出来的线索。整图做没意义（中间位移为 0 才符合物理），所以用**同心缩放**
    当位移：红通道放大、蓝通道缩小，中心不动、越靠边偏得越多，再按 `_edge_weight`
    只保留边框那一圈。成本是 2 次通道 resize，比逐像素位移便宜一个量级。
    """
    if amount <= 0.05:
        return img
    try:
        w, h = img.size
        r, g, b, a = img.split()
        k = amount / float(max(w, h))
        r2 = _scale_channel(r, 1.0 + k, (w, h))
        b2 = _scale_channel(b, 1.0 - k, (w, h))
        edge = _edge_weight(w, h, radius, max(6.0, amount * 6.0))
        if bend is not None:
            edge = ImageChops.multiply(edge, bend)
        r = Image.composite(r2, r, edge)
        b = Image.composite(b2, b, edge)
        return Image.merge("RGBA", (r, g, b, a))
    except Exception:
        return img


_MASKS = {}


def _cached_mask(w, h, radius):
    """超椭圆遮罩（按尺寸缓存）。同一尺寸在整窗重绘里会被反复用到，算一次就够。"""
    key = (int(w), int(h), int(round(radius * 8)))
    hit = _MASKS.get(key)
    if hit is not None:
        return hit
    m = squircle_mask((w, h), radius)
    if len(_MASKS) > 12:
        _MASKS.clear()
    _MASKS[key] = m
    return m


_OVERLAYS = {}


def _light_overlay(sw, sh, radius, sk):
    """玻璃"光"的那一层：斜向光泽 + 边光 + 内侧暗线 + 暖冷彩边，**与底板无关**。

    按 (尺寸, 圆角, 线宽) 缓存。合成顺序必须和以前逐层叠加时一模一样：
    光泽 → 边光（rim ∪ soft）→ 底部暗线 → 冷边 → 暖边（暖最后，压在最外圈）。
    """
    key = (int(sw), int(sh), int(radius * 8), int(sk * 50))
    hit = _OVERLAYS.get(key)
    if hit is not None:
        return hit
    ov = Image.new("RGBA", (sw, sh), (0, 0, 0, 0))
    try:
        # ③ 表面光泽：135° 斜向白光，左上最亮往右下散掉
        sheen = _ramp((sw, sh), 0.46, 0.92, 0.0, 1.0,
                      gamma=2.3).point(lambda v: int(v * 0.11))
        glow = Image.new("RGBA", (sw, sh), WHITE + (0,))
        glow.putalpha(sheen)
        ov = Image.alpha_composite(ov, glow)

        # ④ 边：上左亮 → 下右暗的一条等宽带 + 内侧自然衰减 + 底部暗线
        w1 = max(1.2, 1.5 * sk)
        rim = ImageChops.multiply(_ring(sw, sh, radius, 0, w1),
                                  _ramp((sw, sh), 0.26, 1.0, 0.18, 1.0, gamma=0.75))
        soft = ImageChops.multiply(_ring(sw, sh, radius, w1, max(1.6, 2.6 * sk)),
                                   _ramp((sw, sh), 0.26, 1.0, 0.0, 0.24))
        glow = Image.new("RGBA", (sw, sh), WHITE + (0,))
        glow.putalpha(ImageChops.lighter(rim, soft))
        ov = Image.alpha_composite(ov, glow)

        shade = ImageChops.multiply(_ring(sw, sh, radius, w1, max(1.6, 2.0 * sk)),
                                    _ramp((sw, sh), -0.25, -1.0, 0.0, 0.5))
        dark = Image.new("RGBA", (sw, sh), (0, 0, 0, 0))
        dark.putalpha(shade)
        ov = Image.alpha_composite(ov, dark)

        # ⑤ 色散：整圈倒角都分光，四角复合曲率更强；**暖外冷内**（红偏折少）
        bend = _corner_weight(sw, sh, radius, 1.4)
        d1 = max(1.0, 1.2 * sk)
        sharp = ImageFilter.GaussianBlur(0.9)   # 硬环会看成"描边"，糊半像素才像光
        cool_m = ImageChops.multiply(_ring(sw, sh, radius, d1 * 1.1, d1 * 1.6).filter(sharp),
                                     _ramp((sw, sh), 0.26, 1.0, 0.0, 0.45))
        cool = Image.new("RGBA", (sw, sh), (150, 196, 255, 0))
        cool.putalpha(ImageChops.multiply(cool_m, bend))
        ov = Image.alpha_composite(ov, cool)

        warm_m = ImageChops.multiply(_ring(sw, sh, radius, 0, d1).filter(sharp),
                                     _ramp((sw, sh), 0.26, 1.0, 0.0, 0.85))
        warm = Image.new("RGBA", (sw, sh), (255, 178, 100, 0))
        warm.putalpha(ImageChops.multiply(warm_m, bend))
        ov = Image.alpha_composite(ov, warm)
    except Exception:
        return None
    if len(_OVERLAYS) > 12:          # 尺寸变来变去时别把内存吃干
        _OVERLAYS.clear()
    _OVERLAYS[key] = ov
    return ov


def build_stage(shot, sw, sh, s_scale=1.0):
    """把截屏结果做成底板。**降采样倍率跟着模糊半径走**。

    - `DSH_WATCH_GLASS_BLUR > 0`（默认 13）：走 1/8 降采样再糊，就是原来那套液态玻璃。
    - `DSH_WATCH_GLASS_BLUR = 0`：**"只要一层不透明度、不要糊"**。这时 1/8 会把背景
      放大成 8 倍的色块 —— 那是马赛克，不是玻璃。所以改成 1:1 逐像素采样，
      同时把色散 / 边缘折射 / 提饱和全部关掉（清晰图上做这些一眼就假）。

    两处 `_stage` 各自抄过一遍这段，改动容易只改一边；统一到这里。
    """
    try:
        blur_r = max(0.0, float(os.environ.get("DSH_WATCH_GLASS_BLUR") or 13))
    except Exception:
        blur_r = 13.0
    crisp = blur_r <= 0.5
    # **1/4，不是 1/8**（取自 PR #15）：1/8 那层放大 8 倍，边缘折射和背景细节都发虚；
    # 1/4 面积是 4 倍但换来的清晰度是肉眼可见的。成本靠"静态跳帧"抵掉 ——
    # 背景不动时这里根本不会被调用。
    ds = 1 if crisp else 4
    small = shot.resize((max(4, sw // ds), max(4, sh // ds)), Image.BILINEAR)
    if not crisp:
        small = small.filter(ImageFilter.GaussianBlur(blur_r))
    try:
        chroma = float(os.environ.get("DSH_WATCH_GLASS_CHROMA") or 8.0)
    except Exception:
        chroma = 8.0
    if chroma > 0.01 and not crisp:
        # 强度要按降采样比例换算，否则换倍率时色散量会变
        small = chromatic(small.convert("RGBA"), chroma * 16.0 / ds)
    try:
        sat = float(os.environ.get("DSH_WATCH_GLASS_SAT") or (1.0 if crisp else 1.75))
        small = ImageEnhance.Color(small).enhance(max(0.0, sat))
        small = ImageEnhance.Brightness(small).enhance(1.0 if crisp else 1.06)
    except Exception:
        pass
    if not crisp:
        try:
            small = refract(small, max(2.0, 14 * s_scale / 4.0))
        except Exception:
            pass
    return small


def plate(src, rect, radius, mode="panel", s=1.0):
    """从模糊底板**裁一块**下来，做成一片真玻璃。返回 (RGBA 图, (x, y))。

    ## 为什么每块玻璃都从底板裁
    tkinter 没有"半透明填充"这种东西：Canvas 的填充色必须是不透明色。所以想做出
    "气泡透出背后的画面"，唯一的办法就是**把背后的那张（已经糊过的）图裁下来**，
    再往上叠薄薄一层白/蓝 —— 它透出来的确实是身后的画面，不是模拟。

    于是三样东西共用同一套合成：主体 / 悬浮条 / 气泡。区别只在四个参数：

    | mode     | 压暗 a        | wash            | 说明                       |
    |----------|---------------|-----------------|----------------------------|
    | `panel`  | 0.34 – 0.74   | 无              | 主体，最通透（要看画面）   |
    | `slab`   | 0.40 – 0.78   | 白 6%           | 标题 / 输入条，要读字      |
    | `bubble` | 0.30 – 0.62   | 白 7%           | 陪看 / 台词                |
    | `me`     | 0.28 – 0.58   | 系统蓝 26%      | 我说的                     |

    压暗量按**这块自己的平均亮度**反解（不是整窗一个值）：标题栏可能压着白网页、
    主体压着暗场景，各调各的才对。
    """
    x1, y1, x2, y2 = (int(round(v)) for v in rect)
    x1, y1 = max(0, x1), max(0, y1)
    x2 = min(src.size[0], max(x1 + 2, x2))
    y2 = min(src.size[1], max(y1 + 2, y2))
    w, h = max(2, x2 - x1), max(2, y2 - y1)
    img = src.crop((x1, y1, x1 + w, y1 + h)).convert("RGBA")

    # **不再降采样烘焙**。试过按 0.52 倍算完再放大（成本 1/4），但 1px 的边光被放大成
    # 2px 半强度的软带，玻璃立刻"没边了"。既然叠加层（边光/光泽/彩边）和遮罩现在都
    # 按尺寸缓存，全分辨率下每次重烘只需要一次合成，反而又快又锐。
    sw, sh = w, h
    sk = s
    radius = max(1.5, float(radius))

    # ---- ① 自适应压暗：把这块的平均亮度压到 84 以下，白字才立得住 ----
    try:
        # 平均亮度在 48×48 上算就够（均值对分辨率不敏感），省掉一次全尺寸转灰 + 全像素遍历
        lum = ImageStat.Stat(img.resize((48, 48), Image.BILINEAR).convert("L")).mean[0]
    except Exception:
        lum = 128.0
    lo_a, hi_a = {"panel": (0.30, 0.70), "slab": (0.38, 0.76),
                  "bubble": (0.22, 0.50), "me": (0.20, 0.46)}.get(mode, (0.30, 0.70))
    a = _clamp((lum - 84.0) / max(1.0, lum - float(INK[0])), lo_a, hi_a)

    # ---- ② wash：把"浮在上面"这件事说出来（纯压暗会显得脏、塌） ----
    # **压暗和 wash 都是纯色叠纯色，先算成一个色再一次贴上**：两次全尺寸
    # alpha_composite 合成一次，面板上省 4ms。
    wash = {"panel": (WHITE, 6), "slab": (WHITE, 16), "bubble": (WHITE, 34),
            "me": (ACCENT_RGB, 104)}.get(mode, (WHITE, 0))
    ta = int(255 * a)
    if wash[1] > 0:
        wb = wash[1] / 255.0
        mix = tuple(int(round(INK[i] * (1 - wb) + wash[0][i] * wb)) for i in range(3))
        eff = ta + wash[1] * (1 - ta / 255.0)
        img = Image.alpha_composite(img, Image.new("RGBA", img.size, mix + (int(round(eff)),)))
    else:
        img = Image.alpha_composite(img, Image.new("RGBA", img.size, INK + (ta,)))

    # ---- ②' 曲率权重（色散强度） + 可选的通道位移 ----
    try:
        bend = _corner_weight(sw, sh, radius, 1.4)
    except Exception:
        bend = None
    # 通道位移（红/蓝各自缩放）默认**不开**：底板已经糊过又压过暗，边上几乎没有对比，
    # 位移出来的彩边肉眼看不见，却要付 2 次全尺寸 resize —— 面板上实测 +18ms/块。
    # 真正看得见的是下面 ⑤ 那两条"暖外冷内"的边，那才是这套玻璃的色散来源。
    if os.environ.get("DSH_WATCH_CHROMA_EDGE") == "1":
        img = chroma_edge(img, radius, max(1.2, 2.2 * sk), bend)

    # ---- ③④⑤ 光的部分：与背后的画面无关，整张叠加层按尺寸缓存 ----
    # 光泽 / 边光 / 内侧暗线 / 暖冷彩边 **全都是纯几何**，同一尺寸下永远一样。
    # 以前每烘一次都在这张 w×h 的图上做 6 次 alpha_composite（面板上 ~24ms），
    # 而真正随底板变的只有下面的压暗。现在合成一张叠加层缓存起来，重烘时只付 1 次。
    try:
        ov = _light_overlay(sw, sh, radius, sk)
        if ov is not None:
            img = Image.alpha_composite(img, ov)
    except Exception:
        pass

    # ---- ⑥ 超椭圆遮罩（角上抗锯齿） ----
    img.putalpha(_cached_mask(sw, sh, radius))
    return img, (x1, y1)


class Opt:
    """一组排版参数（已按 DPI 缩放），气泡和窗口共用"""

    def __init__(self, s, avail, family):
        self.s = s
        self.avail = avail
        self.radius = int(BUBBLE_R * s)
        self.padx = int(14 * s)
        self.pady = int(10 * s)
        self.gap = int(14 * s)
        self.font = (family, max(8, int(11 * s)))
        self.font_small = (family, max(7, int(8.5 * s)))
        # 时间戳专用：**不加粗**。一版是 9pt bold，压在模糊背景上比正文还抢眼，
        # 一排粗体数字看着像仪表盘。苹果的 caption 是细体 + 低对比，现在照这个来。
        self.font_time = (family, max(7, int(8.5 * s)))


class Bubble:
    """一条消息 = 一行时间 + 一块玻璃片，**直接画在父 Canvas 上**。

    ## 为什么不用 Frame + Label（2026-11-01 改版）
    tkinter 的窗口部件（Frame / Label / Canvas）**必须填一个不透明底色**，所以只要
    消息还挂在部件上，毛玻璃底板就永远被整块盖住 —— 这是"真模糊"做不出来的真正原因，
    跟用哪个库、哪种语言都无关。只有 Canvas 的**原生元素**（create_text / create_image）
    能浮在图片之上，所以这里全部自绘。

    ## 气泡本身也是玻璃（2026-11-01 二版）
    一版给气泡填了个死色 `#3a4459`，等于在玻璃上贴卡纸 —— 背后画面一到气泡就断，
    整窗那点通透全废了。二版从底板裁一块下来（`plate()`），只加一层白/蓝 wash：
    气泡里透出来的就是它身后的画面，只是更亮更实一点。缓存按尺寸 + 底板版本走，
    同一块气泡不会每帧重烘。

    `measure()` 只算尺寸不画（排版要先知道总高），`paint()` 才真正落到画布上。
    文字高度用 `create_text` + `bbox` 实测 —— 中英文混排的折行交给 Tk 自己算，
    不自己实现换行算法（那才是 bug 温床）。
    """

    def __init__(self, role, text, stamp, opt, host=None):
        self.role = role
        self.opt = opt
        self.host = host
        kind, fg, bar, who = ROLE.get(role, ROLE["assistant"])
        self.kind, self.fg, self.bar = kind, fg, bar
        self.text = text
        # 实际画出来的那段（可能被 max_h 截断成 "开头…"）；`text` 永远是原文
        self.shown = text
        self._mkey = None
        self.right = role == "user"
        self.head = " ".join(x for x in (who, stamp) if x)
        self.tag = f"msg{next(_COUNTER)}"
        # 尺寸（measure 之后有值）
        self.bw = self.bh = self.h = 0
        self._limit = 0
        self._img = None
        self._img_key = None
        self._head_h = 0
        # 入场进度：1.0 = 已在位（历史回放直接是 1，只有新来的才走动画）
        self._anim = 1.0
        self._fade = 1.0
        self._gx = None

    def measure(self, cv, avail, max_h=0):
        """算出这块占多高、气泡多宽（不落任何 item）。

        `max_h` 给了就把正文截到塞得进这个高度的长度（末尾补省略号）。
        **画布裁不了文字**：比视口还高的一条如果整段画出来，它就得从视口顶上起画，
        后面几条同理 —— 结果全叠在同一个 y 上，用户看到的是"字压字、还顶到
        输入栏外面"。截断之后它的 h 永远不超过视口，`_reflow` 那条超高分支只当兜底。
        """
        opt = self.opt
        limit = max(int(120 * opt.s), int(avail * 0.84) - 2 * opt.padx)
        self._limit = limit
        # **时间戳占多高要实测，不能拿字号顶**：`font_time[1]` 是磅值，中文 9pt 的
        # 实际行高是它的 1.4 倍左右 —— 按磅值留位置，多出来的那半行正好落在气泡底下，
        # 字被气泡啃掉一截（用户看到的就是"字太靠下、被气泡挡住了"）。
        if self.head:
            probe = cv.create_text(-4000, -4000, text=self.head, font=opt.font_time,
                                   anchor="nw")
            hb = cv.bbox(probe)
            cv.delete(probe)
            head_h = ((hb[3] - hb[1]) if hb else opt.font_time[1]) + int(6 * opt.s)
        else:
            head_h = 0
        self._head_h = int(head_h)
        text = self.text
        self.shown = text
        tw, th = self._probe(cv, text, limit)
        if max_h:
            room = max_h - self._head_h - 2 * opt.pady - opt.gap
            if th > room:
                text = self._fit(cv, text, limit, room) if room > 0 else "…"
                self.shown = text
                tw, th = self._probe(cv, text, limit)
        self.bw = int(min(limit, max(1, tw)) + 2 * opt.padx)
        self.bh = int(max(1, th) + 2 * opt.pady)
        self.h = head_h + self.bh + opt.gap
        return self.h

    def _probe(self, cv, text, limit):
        """量一段文字的像素尺寸（create → bbox → delete，一次一个 item）"""
        probe = cv.create_text(-4000, -4000, text=text, width=limit,
                               font=self.opt.font, anchor="nw")
        box = cv.bbox(probe) or (0, 0, 1, 1)
        cv.delete(probe)
        return box[2] - box[0], box[3] - box[1]

    def _fit(self, cv, text, limit, room):
        """二分出"塞进 room 像素的最长前缀"，末尾补省略号。

        折行照样交给 Tk（每次都用同一套字体真量一遍），这里只决定"切到第几个字"。
        太短就退化成 "…"，至少不会把一个字挤成两行。
        """
        lo, hi, best = 0, len(text), -1
        while lo <= hi:
            mid = (lo + hi) // 2
            if self._probe(cv, text[:mid].rstrip() + "…", limit)[1] <= room:
                best, lo = mid, mid + 1
            else:
                hi = mid - 1
        if best < 0:
            return "…"
        return text[:best].rstrip() + "…"

    def _photo(self, bx, yy, r):
        """裁一块玻璃（按尺寸 + 底板版本 + 入场进度缓存：滚动时不重烘）"""
        host = self.host
        if host is None or not getattr(host, "glass_ready", lambda: False)():
            return None
        blur = getattr(host, "_blurred", None)
        if blur is None:
            return None
        try:
            wh = (host.canvas.winfo_width(), host.canvas.winfo_height())
        except Exception:
            wh = blur.size
        if blur.size != wh:
            # 底板还是上一档尺寸（折叠/展开/缩放的过渡帧）：这时候裁出来的片是错的，
            # 宁可这一帧不画玻璃，下一帧再补。
            return None
        # 入场进度量化成 12 档：0 = 全透明（不画图），12 = 实体
        step = max(1, min(12, int(round(self._opacity() * 12))))
        key = (self.kind, self.bw, self.bh, r, host.chat_glass_ver(), step)
        if self._img_key == key and self._img is not None:
            return self._img
        try:
            img = host.plate_image(self.kind, (bx, yy, bx + self.bw, yy + self.bh), r)
            if img is None:
                return None
            if step < 12:
                # Tk 的 image item 没有透明度可调，只能**重新合成一张淡一点的图** ——
                # 每档一次 `putalpha`，一张气泡 ~4ms，8 帧摊在 200ms 里够用。
                img = img.copy()
                img.putalpha(img.getchannel("A").point(lambda v: int(v * step / 12.0)))
            photo = ImageTk.PhotoImage(img)
        except Exception:
            return None
        self._img, self._img_key = photo, key
        return photo

    def _opacity(self):
        """当前该有多实：入场进度 × 滚动边缘的淡出系数"""
        return max(0.0, min(1.0, self._anim * self._fade))

    def repaint(self, cv):
        """按上次的位置重画（入场动画每帧走这里，不重排整个列表）"""
        if not self._gx:
            return
        x0, y, w, fade = self._gx
        self.paint(cv, x0, y, w, fade)

    def paint(self, cv, x0, y, width, fade=1.0):
        """在画布上从 (x0, y) 开始画（y 是这一条的顶端，fade 是滚动边缘的淡出）"""
        opt = self.opt
        self._fade = fade
        self._gx = (x0, y, width, fade)
        cv.delete(self.tag)
        # 入场：从下方 10px、三成透明度"浮"到位。**不能只做 alpha 不做位移** ——
        # 纯淡入在暗背景上几乎看不出来，位移才让人看见"来了"。
        a = self._opacity()
        yy = y + (0 if self._anim >= 0.999 else int(round((1.0 - self._anim) * 10 * opt.s)))
        fg = self.fg if a >= 0.999 else _mix(BG, self.fg, max(0.15, a))
        time_fg = TIME_FG if a >= 0.999 else _mix(BG, TIME_FG, max(0.15, a))
        # **时间戳贴着气泡自己的边缘**，不能用画布宽度：气泡左边缘在 `x0`
        # （= 窗口内缩 + 8px），而画布原点是 0，两者差 30 多像素 ——
        # 之前时间戳永远是"浮在气泡左边外面"，看着就是错位。
        bx = (x0 + width - self.bw) if self.right else x0
        if self.head:
            hx = (bx + self.bw) if self.right else bx
            cv.create_text(hx, yy, text=self.head, font=opt.font_time, fill=time_fg,
                           anchor="ne" if self.right else "nw", tags=self.tag)
            yy += self._head_h
        r = max(6, int(min(opt.radius, self.bh / 2)))
        photo = self._photo(bx, yy, r)
        if photo is not None:
            cv.create_image(bx, yy, image=photo, anchor="nw", tags=self.tag)
        else:
            # 兜底：没有 Pillow / 拿不到底板时退回纯色片，至少不塌
            round_rect(cv, bx, yy, bx + self.bw, yy + self.bh, r,
                       fill=_mix(GLASS_FILL, "#1b1e24", a), outline="", tags=self.tag)
        if self.bar:
            x = bx + max(2, opt.padx // 3)
            round_rect(cv, x, yy + opt.pady, x + max(2, int(3 * opt.s)),
                       yy + self.bh - opt.pady, 2, fill=self.bar, outline="", tags=self.tag)
        text_on_glass(cv, bx + opt.padx, yy + opt.pady, self.shown,
                      width=self._limit, font=opt.font, fill=fg,
                      anchor="nw", tags=self.tag,
                      offset=max(1, int(opt.s)))


_COUNTER = iter(range(1, 10 ** 9))


class Meta:
    """系统行（麦克风状态、报错）：一行灰字，不做气泡。同样是**画在 Canvas 上**，
    理由和 Bubble 一样（窗口部件会挡住毛玻璃）。"""

    def __init__(self, text, opt, center=False):
        self.opt = opt
        self.text = text
        self.center = center
        self.tag = f"meta{next(_COUNTER)}"
        self.h = 0
        self._limit = 0

    def measure(self, cv, avail, max_h=0):
        opt = self.opt
        if self.center:
            self._limit = avail
            self.h = int(72 * opt.s) * 2 + opt.font_small[1] * 3
            if max_h:
                self.h = min(self.h, max_h)
            return self.h
        self._limit = max(80, int(avail))
        probe = cv.create_text(-4000, -4000, text=self.text, width=self._limit,
                               font=opt.font_small, anchor="nw")
        box = cv.bbox(probe) or (0, 0, 1, 1)
        cv.delete(probe)
        self.h = (box[3] - box[1]) + opt.gap
        if max_h:
            self.h = min(self.h, max_h)
        return self.h

    def paint(self, cv, x0, y, width, fade=1.0):
        opt = self.opt
        cv.delete(self.tag)
        # Canvas 的文字没有 alpha，只能把颜色往底板上插值 —— 视觉上等价于淡出
        fg = DIM if fade >= 0.999 else _mix(GLASS_FILL, DIM, max(0.05, fade))
        # 系统行也是压在玻璃上的灰字，同样要影子（"叫醒失败"这类行最容易被背景吃掉）。
        # **这里不按背景翻色**：`Meta` 拿不到 host，而且它本来就是低对比的灰字，
        # 翻成深色反而更糊 —— 只加影子。
        if self.center:
            text_on_glass(cv, x0 + width / 2, y + int(72 * opt.s), self.text,
                          font=opt.font_small, fill=fg, anchor="n",
                          justify="center", width=width, tags=self.tag,
                          offset=max(1, int(opt.s)))
        else:
            text_on_glass(cv, x0 + 3 * opt.s, y, self.text, font=opt.font_small,
                          fill=fg, anchor="nw", width=self._limit, tags=self.tag,
                          offset=max(1, int(opt.s)))


class GlassButton:
    """画在宿主 Canvas 上的按钮（胶囊 / 圆盘 / 图标）。

    为什么不用 `tk.Button` / `tk.Label`：它们只有直角 + 不透明底色，贴在玻璃上就是
    一块死色块（"麦"和"发送"周围那圈黑边就是这么来的）。tkinter 又给不了半透明填充，
    所以玻璃底是**从底板裁下来的**（`plate()`），悬停时换成同一块裁片的白一档版本
    —— 提亮是真提亮，不是换一个近似色蒙事。

    三种 kind：
      `ghost`  玻璃胶囊（麦 / 发送的底）
      `accent` 实心强调胶囊（主操作；苹果的 tinted glass 就是这个意思）
      `icon`   只有字/符号，悬停浮出一个圆形井（✕ / ▾）
    """

    def __init__(self, host, key, text="", kind="ghost", fg=None, fill=None,
                 command=None, size=9.5, group=None):
        self.host = host
        self.tag = key
        self.text = text
        self.kind = kind
        self.fg = fg or TEXT
        self.fill = fill
        self.command = command
        self.size = size
        self.group = group
        self.rect = None
        self.radius = 0.0
        self.hover = False
        self._photo = None
        self._label = None
        self._bound = False

    # ---- 状态 ----
    def set(self, text=None, bg=None, fg=None):
        if text is not None:
            self.text = text
        if fg is not None:
            self.fg = fg
        if bg is not None:
            self.fill = bg
        self._paint()

    def set_bg(self, bg):
        self.fill = bg
        self._paint()

    def hide(self):
        self.host.canvas.itemconfigure(self.tag, state="hidden")

    def show(self):
        self.host.canvas.itemconfigure(self.tag, state="normal")

    # ---- 几何 ----
    def layout(self, rect, radius=None):
        self.rect = tuple(int(round(v)) for v in rect)
        x1, y1, x2, y2 = self.rect
        self.radius = float(radius if radius is not None
                            else min(x2 - x1, y2 - y1) / 2.0)
        if not self._bound:
            self._bind()
            self._bound = True
        self._paint()

    def _bind(self):
        cv = self.host.canvas
        cv.tag_bind(self.tag, "<Enter>", lambda _e: self._set_hover(True))
        cv.tag_bind(self.tag, "<Leave>", lambda _e: self._set_hover(False))
        cv.tag_bind(self.tag, "<Button-1>", self._click)

    def _click(self, _e=None):
        if self.command:
            try:
                self.command()
            except Exception:
                pass
        return "break"          # 别让画布把这次点击当成"拖窗"

    def _set_hover(self, on):
        if self.hover == on:
            return
        self.hover = on
        try:
            self.host.canvas.configure(cursor="hand2" if on else "")
        except Exception:
            pass
        self._paint()

    # ---- 绘制 ----
    def _paint(self):
        if not self.rect:
            return
        cv = self.host.canvas
        cv.delete(self.tag)
        tags = (self.tag,) + ((self.group,) if self.group else ())
        x1, y1, x2, y2 = self.rect
        h = max(2, y2 - y1)
        r = max(2.0, min(self.radius, h / 2.0))

        if self.kind == "accent":
            base = self.fill or ACCENT
            round_rect(cv, x1, y1, x2, y2, r, fill=base, outline="", tags=tags)
            # 顶部一道亮边：实心胶囊也要有"受光面"，否则像贴纸
            cv.create_line(x1 + r * 0.9, y1 + 0.7, x2 - r * 0.9, y1 + 0.7,
                           fill=_mix(base, "#ffffff", 0.42 if not self.hover else 0.62),
                           width=1, tags=tags)
        elif self.kind == "icon":
            if self.hover and self.host.glass_ready():
                photo = self.host.plate_photo("hover", self.rect, r)
                if photo is not None:
                    self._photo = photo
                    cv.create_image(x1, y1, image=photo, anchor="nw", tags=tags)
        else:
            photo = None
            if self.fill is None and self.host.glass_ready() and not getattr(self.host, "acrylic", False):
                photo = self.host.plate_photo("hover" if self.hover else "slab",
                                              self.rect, r)
            if photo is not None:
                self._photo = photo
                cv.create_image(x1, y1, image=photo, anchor="nw", tags=tags)
            else:
                round_rect(cv, x1, y1, x2, y2, r,
                           fill=self.fill or ("#262a31" if self.hover else "#1b1e24"),
                           outline="", tags=tags)

        self._label = cv.create_text((x1 + x2) / 2.0, (y1 + y2) / 2.0, text=self.text,
                                     font=self.host._f(self.size), fill=self.fg,
                                     anchor="center", tags=tags)


# ---------------------------------------------------------------- 窗口

class FloatChat:
    def __init__(self):
        dpi_aware()
        cfg = read_config()
        geo = cfg.get("geometry") if isinstance(cfg.get("geometry"), str) else ""
        # 插件开窗前会把 `hidden` 清成 false，所以新进程总是从"看得见"开始；
        # 这里只跟文件变化（`_sync_visible`），不猜"第一次"
        self.hidden = False
        # 窗口的名字：用户可改，存 `~/.dsh/watch-window.json` 的 `name`（默认"陪看"）
        raw_name = cfg.get("name")
        self.name = (raw_name.strip()[:24] if isinstance(raw_name, str) and raw_name.strip()
                     else "陪看")

        self.root = tk.Tk()
        self.root.title(self.name)
        self.root.overrideredirect(True)                 # 无边框
        self.root.attributes("-topmost", True)           # 置顶
        self.root.configure(bg=KEY)

        try:
            self.s = max(1.0, min(2.2, float(self.root.winfo_fpixels("1i")) / SS))
        except Exception:
            self.s = 1.0
        S = self.s

        # 液态玻璃的几何：窗口边 → 玻璃 12px（玻璃是"浮"在桌面上的，不是贴着窗口边），
        # 玻璃之间 10px 的缝透出真实桌面 —— iOS 26 那种"几块悬浮玻璃"的分层感就是这么来的。
        self.radius = int(PANEL_R * S)
        self.out = int(12 * S)          # 窗口边 → 玻璃
        self.pad = self.out + int(14 * S)   # 窗口边 → 文字（玻璃内边距）

        self.w, self.h = int(468 * S), int(540 * S)
        self._parse_geometry(geo)

        # 圆角：Windows 才有 -transparentcolor；拿不到就直角，不报错
        self.rounded = True
        try:
            self.root.attributes("-transparentcolor", KEY)
            # **不要和 -alpha 一起用**：抠色 + 整窗 alpha 会让抠掉的地方变成半透明黑（脏边）
        except Exception:
            self.rounded = False
            self.root.configure(bg=BG)
            try:
                self.root.attributes("-alpha", 0.97)
            except Exception:
                pass

        # 玻璃的"通透"：整窗轻微透明，透出背后一点点桌面。
        # 0.96 是试出来的上限 —— 再低字就开始发灰、背后内容会抢注意力。
        # 拿不到（平台不支持 / 和抠色冲突）就安静地跳过，绝不因为一个视觉效果起不来。
        # `DSH_WATCH_GLASS_ALPHA` 可调，设 1 完全关掉。
        if self.rounded:
            try:
                a = float(os.environ.get("DSH_WATCH_GLASS_ALPHA") or 0.975)
                if 0.5 <= a < 1.0:
                    self.root.attributes("-alpha", a)
            except Exception:
                pass

        # **磨砂（GPU）模式**：让 DWM 自己做背景模糊，我们一次屏都不截。
        # 代价是 canvas 上不能有半透明叠加（Tk 不支持），所以气泡/悬浮条退化成
        # 实心卡片 —— 但那本来就是"磨砂玻璃上的卡片"该有的样子。
        # 收益：背景由 GPU 逐帧糊，60fps，CPU 占用接近 0。
        self.acrylic = False
        if os.environ.get("DSH_GLASS_ACRYLIC") == "1":
            self.acrylic = self._apply_acrylic()

        self.family = self._pick_font()
        self.opt = Opt(S, max(160, self.w - 2 * self.pad - int(16 * S)), self.family)

        self.mic_proc = None
        self._drag = None
        self._resize = None
        self.rows = []
        self.empty = None
        # 真毛玻璃底板（PIL.Image）与它的 Tk 句柄。
        # **PhotoImage 必须留引用**：只 create_image 不持有的话，下一帧就被 GC，
        # 画布上立刻变成空白 —— 这是 Tk 里贴图最常见的坑。
        self.backdrop = None            # 已经压暗 + 带圆角 alpha 的整窗玻璃图
        self._blurred = None            # 只糊不压暗的原图：每块玻璃自己裁它再调亮度
        self._backdrop_photo = None
        self._bot_slab_h = 0        # 输入栏玻璃片的高度（量到之后回填）
        self._backdrop_job = None
        # 裁片缓存：(mode, w, h, r, 版本) → PhotoImage。
        # 滚动/重排时不重烘 —— 一张气泡玻璃 ~10ms，一屏七八条就是一次明显的卡顿。
        self._resizing = False
        self._resize_job = None
        self._last_panel = None    # 上一张整窗玻璃（缩放时临时顶上）
        self._plates = {}          # (mode,w,h,r,版本) → PhotoImage
        self._plate_imgs = {}      # 同上，但存 PIL 图（入场动画要改 alpha）
        self._last_plate_imgs = {} # 每个 mode 最近一张（缩放时缩放顶上）
        self._glass_v = 0
        self._chat_v = 0
        self._stage_cache = None   # 带留白、已糊好的底板（1/4 分辨率）
        self._painted_size = None  # 上一次整窗重绘用的尺寸（判断 Configure 是不是"纯搬家"）
        self._dpik = None          # DPI 系数（缓存）
        self._last_origin = None   # 上一帧窗口原点（判断挪了多远）

        self._build()

        # 开窗第一次截图：此刻窗口还没显示（下面才 deiconify），所以截到的是干净桌面，
        # **完全不会闪**。之后只在拖动/缩放结束时重截。
        # 磨砂模式跳过：背景交给 DWM，一次屏都不用截（连带省掉那次 withdraw/deiconify）。
        if HAVE_PIL and self.rounded and not self.acrylic:
            self.root.withdraw()
            self.root.update_idletasks()
            self.backdrop = self._grab_backdrop((self.w, self.h))
            self._paint()
        self.root.deiconify()
        # 必须在 map 之后；失败就退回"隐藏窗口再截"的老路（`_refresh_backdrop` 会判断）
        # 抓屏排除（WDA_EXCLUDEFROMCAPTURE）：默认开，抓"自己背后"时不递归、不闪。
        # **但它同时也让窗口从用户的截图/录屏里消失** —— 录演示视频必须能关掉。
        # 三级开关：env `DSH_GLASS_WDA=0` > 配置 `"capturable": true` > 默认排除。
        _cap = read_config().get("capturable") is True
        self._excluded = self._set_exclude(
            not _cap and os.environ.get("DSH_GLASS_WDA") != "0")

        self._offset = 0
        self._carry = ""
        self.seen = 0
        self._reset_cursor()
        self.poll()

        # **磨砂必须在窗口真 show 出来之后再挂**：`SetWindowCompositionAttribute` 在
        # 窗口还没 map 时调用**返回 True 但什么也不做**（实测：map 前挂 → 背景原样穿透，
        # 条纹 std 183.6；map 后挂 → std 1.8，糊成一片）。这和上一个 `SetWindowRgn`
        # 的黑屏是同一个家族的错误：**在 map 之前摸 hwnd / 尺寸**。
        if self.acrylic:
            self.root.after(60, self._acrylic_late)

        self.root.bind("<Escape>", lambda _e: self.close())
        self.root.after(220, self._focus_entry)

    # ---- 基础 ----
    def _pick_font(self):
        try:
            from tkinter import font as tkfont
            families = set(tkfont.families())
        except Exception:
            families = set()
        for name in ("Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC",
                     "Noto Sans CJK SC", "WenQuanYi Micro Hei"):
            if name in families:
                return name
        return "TkDefaultFont"

    def _parse_geometry(self, geo):
        """`468x540+120+80` → 尺寸与位置；坏字符串就用默认值"""
        sw = self.root.winfo_screenwidth()
        sh = self.root.winfo_screenheight()
        try:
            size, rest = geo.split("+", 1)
            w, h = (int(x) for x in size.split("x"))
            x, y = (int(v) for v in rest.split("+")[:2])
            self.w = max(int(MIN_W * self.s), min(sw - 40, w))
            # 高度下限**按三段玻璃算**，不写死 220：写死的那个比固定栏本身还矮，
            # 恢复出来就是把消息区压成一条缝（用户实报"整窗被压扁、字顶出来"）。
            lo = min(self._min_h(), sh - 40)
            self.h = max(lo, min(sh - 40, h))
            # **位置必须按窗口自己的尺寸夹**：以前写的是 `sw - 120`，窗口 700 宽时
            # 允许 x 到 sw-120，右边 580px 直接跑到屏幕外（用户看到的是"半截窗"）。
            self.x = max(0, min(sw - self.w - int(8 * self.s), x))
            self.y = max(0, min(sh - self.h - int(48 * self.s), y))
        except Exception:
            self.x = max(0, sw - self.w - int(36 * self.s))
            self.y = max(0, sh - self.h - int(96 * self.s))
        self.root.geometry(f"{self.w}x{self.h}+{self.x}+{self.y}")

    def _f(self, size, weight="normal"):
        return (self.family, max(7, int(size * self.s)), weight)

    # ---- 组装 ----
    def _build(self):
        bg = KEY if self.rounded else BG
        self.canvas = tk.Canvas(self.root, bg=bg, highlightthickness=0, bd=0)
        self.canvas.pack(fill="both", expand=True)
        self.canvas.bind("<Configure>", self._paint)

        # **没有 shell 了**：整窗只有 header 和 composer 两块不透明窗口部件，
        # 中间的消息区直接画在 canvas 上 —— 这样毛玻璃底板才能透出来。
        self._items = []          # Bubble / Meta，按时间顺序
        self._scroll = 0          # 消息区滚动偏移（px，0 = 贴底）
        self._total_h = 0
        self._view_h = 1
        self._grip_item = None

        self._build_header()
        self._build_composer()

        self.canvas.bind("<Button-1>", self._drag_start)
        self.canvas.bind("<B1-Motion>", self._drag_move)
        # **必须有 Release**：`_paint` 里"正在拖动就不重绘"那个早退靠 `self._drag` 判断，
        # 而它以前只在按下时被赋值、**没有任何地方清零** —— 于是点过窗口一次之后，
        # 所有"尺寸没变"的重绘全部被静默跳过（用户看到的就是折叠再展开后
        # 标题栏和输入栏一片空白，连 ✕ 都没了）。
        self.canvas.bind("<ButtonRelease-1>", self._drag_end)
        # 滚轮绑在整个窗口上：真机上鼠标多半停在气泡上，只绑画布就滚不动
        self.root.bind_all("<MouseWheel>", self._on_wheel)

    def _min_h(self):
        """窗口能被压到多矮 —— **由三块玻璃自己算出来，不拍脑袋写一个数**。

        以前这里写死 `220 * s`（150% 缩放下 = 330）。但三段固定高度加起来就是
        `out*2 + 46s（标题）+ 58s（输入栏）+ 缝 2×10s` ≈ **222**，
        剩下 108px 给消息区 —— 一条气泡都放不下，于是文字顶上输入栏、整窗看着"被压扁"。
        用户窗口存下来的正好是 700×329，刚好被那个下限放过去了。

        主体给 `300s`（约两条气泡）。**190s 是不够的**：气泡行高同样是 `*s` 的，
        190 逻辑在 150% 下只有 285 物理像素 = 一条 100 字台词的 1.1 倍，滚动时
        完整可见才画的那条规则会让整个主体空成一片。
        """
        s = self.s
        mid = int(10 * s)
        top_h = int(46 * s)
        bot_h = getattr(self, "_bot_slab_h", 0) or int(58 * s)
        body_min = int(300 * s)
        return self.out * 2 + top_h + bot_h + mid * 2 + body_min

    def _layout(self, w, h):
        """算出三块玻璃的位置：**标题栏 / 主体 / 输入栏，各自独立、中间留缝**。

        iOS 26 那种分层就是这么来的 —— 不是"一块大玻璃里套两条"，而是三块分开的
        玻璃，缝隙里能看见背后的桌面（窗口的抠色区域是透明的）。
        返回 (顶条, 主体, 底条)，每个都是 (x1, y1, x2, y2)。
        """
        s = self.s
        out = self.out
        mid = int(10 * s)        # 玻璃之间的缝（小了会粘成一坨，看不出"分开"）
        top_h = int(46 * s)
        bot_h = self._bot_slab_h or int(58 * s)
        x1, x2 = out, w - out
        top = (x1, out, x2, out + top_h)
        bot = (x1, h - out - bot_h, x2, h - out)
        body = (x1, top[3] + mid, x2, bot[1] - mid)
        return top, body, bot

    # ---- 玻璃 ----
    def glass_ready(self):
        return bool(HAVE_PIL and self.rounded and self._blurred is not None)

    def glass_ver(self):
        return self._glass_v

    def chat_glass_ver(self):
        """气泡用的版本号：**小幅拖动不失效**。

        主体玻璃（面板/条）必须跟着新底板重烘；气泡只是几十像素的裁片，挪个一两百像素
        以后它背后还是一片糊过的色块，重烘 6 块 × 4ms 完全白花 —— 拖窗那一下的卡顿
        有一半在这儿。所以只有"缩放"或"挪得很远"才让气泡重烘。
        """
        return self._chat_v

    def plate_image(self, mode, rect, radius):
        """按矩形裁一块玻璃（PIL 图，带缓存），rect 用画布坐标。

        **缓存键里只有尺寸、没有位置**：底板被糊成低频色块以后，同一块气泡在窗口里
        上下挪 40px，裁出来的图和原来几乎一样 —— 但每滚一格就重烘七八张 10ms 的图，
        手感会明显发涩。所以位置不进键，滚动时直接复用。

        返回 PIL 图而不是 PhotoImage：入场动画要按进度改 alpha，拿原图才好逐步合成
        （`ImageTk.PhotoImage` 是一次性快照，改不了）。
        """
        if not self.glass_ready():
            return None
        x1, y1, x2, y2 = (int(round(v)) for v in rect)
        w, h = max(4, x2 - x1), max(4, y2 - y1)
        key = (mode, w, h, int(round(radius)), self._glass_v)
        hit = self._plate_imgs.get(key)
        if hit is not None:
            return hit
        # 拖右下角缩放时，宽度每帧都在变 → 每帧都全量重烘。这里拿同 mode 的上一张
        # 直接缩放到新尺寸顶着（玻璃是低频色块，缩放看不出），松手后再烘准的。
        if getattr(self, "_resizing", False):
            last = self._last_plate_imgs.get(mode)
            if last is not None:
                try:
                    img = last.resize((w, h), Image.BILINEAR)
                    self._plate_imgs[key] = img
                    return img
                except Exception:
                    pass
        try:
            img, _pos = plate(self._blurred, (x1, y1, x1 + w, y1 + h),
                              radius, mode, self.s)
        except Exception:
            return None
        if len(self._plate_imgs) > 300:      # 尺寸变了会攒出一堆旧键，别让它长
            self._plate_imgs.clear()
        self._plate_imgs[key] = img
        self._last_plate_imgs[mode] = img
        return img

    def plate_photo(self, mode, rect, radius):
        """`plate_image` 的 Tk 句柄版（缓存 PhotoImage）"""
        img = self.plate_image(mode, rect, radius)
        if img is None:
            return None
        key = (mode, int(round(rect[2] - rect[0])), int(round(rect[3] - rect[1])),
               int(round(radius)), self._glass_v)
        hit = self._plates.get(key)
        if hit is not None:
            return hit
        try:
            photo = ImageTk.PhotoImage(img)
        except Exception:
            return None
        if len(self._plates) > 300:
            self._plates.clear()
        self._plates[key] = photo
        return photo

    def _panel_photo(self, w, h, body):
        """整块主体玻璃（含圆角透明）—— 只有它铺满窗口，其余都是"浮在上面的片"。

        **缩放过程中不重烘**：一次烘焙 50ms，拖右下角时每个 Configure 都烘一次就是
        肉眼可见的卡顿。这里拿上一张按新尺寸缩放顶上（玻璃本来就是一片低频色块，
        缩放看不出差别），松手 300ms 后再由 `_refresh_backdrop` 重烘一张准的。
        """
        key = ("__panel__", w, h, self._glass_v)
        hit = self._plates.get(key)
        if hit is not None:
            return hit
        if not self.glass_ready():
            return None
        if getattr(self, "_resizing", False) and self._last_panel is not None:
            try:
                img = self._last_panel.resize((w, h), Image.BILINEAR)
                photo = ImageTk.PhotoImage(img)
                self._plates[key] = photo
                return photo
            except Exception:
                pass
        try:
            img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
            piece, pos = plate(self._blurred, body, self.radius, "panel", self.s)
            img.paste(piece, pos)
            self._last_panel = img
            photo = ImageTk.PhotoImage(img)
        except Exception:
            return None
        self._plates[key] = photo
        return photo

    def _ensure_blurred(self, w, h):
        """窗口尺寸和底板对不上时先拉伸对齐 —— 拖动/缩放后的那 400ms 里不至于空一块"""
        if self._blurred is None or self._blurred.size == (w, h):
            return
        try:
            self._blurred = self._blurred.resize((w, h), Image.BILINEAR)
            self._glass_v += 1
            self._plates.clear()
        except Exception:
            pass

    def _repaint_glass(self):
        """**只换玻璃、不动内容。**

        背景在变（对面在播视频）时每 1~2 秒来一发。`_paint()` 末尾会 `_reflow()`
        重排所有气泡（几十毫秒），为了换一层底色付这个代价不值得 —— 这里只
        `delete("panel")` 再贴一张，气泡一个都不碰。
        """
        if self.acrylic or getattr(self, "_collapsed", False) or not self.glass_ready():
            return
        w, h = getattr(self, "_painted_size", None) or (self.canvas.winfo_width(),
                                                        self.canvas.winfo_height())
        if w < 4 or h < 4:
            return
        top, body, bot = self._layout(w, h)
        photo = self._panel_photo(w, h, body)
        if photo is not None:
            self._backdrop_photo = photo
            # **复用同一个 canvas item，不要 delete + create**：
            # 那样中间有一帧没有底板，7Hz 刷新时肉眼看到的就是"一下一下地闪"。
            # `itemconfigure` 换图是原子的，不闪，成本也一样（实测 5.7ms）。
            item = getattr(self, "_panel_item", None)
            alive = item is not None and self.canvas.type(item) == "image"
            if alive:
                self.canvas.itemconfigure(item, image=photo)
            else:
                self._panel_item = self.canvas.create_image(
                    0, 0, image=photo, anchor="nw", tags=("panel", "backdrop"))
                self.canvas.tag_lower("panel")
            self._slab_paint(top, bot)
        else:
            round_rect(self.canvas, body[0], body[1], body[2], body[3], self.radius,
                       fill=BG, outline="", tags=("panel", "backdrop"))

    def _slab_paint(self, top, bot):
        """两块**悬浮**玻璃（标题栏 / 输入栏）。

        它们不是主体的一部分：中间留着缝，缝里透出的是真桌面；而且它们要盖在消息
        上面 —— 消息是"滑到片底下"，不是"从片里穿出来"。
        """
        cv = self.canvas
        self._slab_photos = []
        r = max(8, int(SLAB_R * self.s))
        # **复用 item**：每帧 delete + create 中间有一帧没有玻璃，7Hz 下就是闪。
        # 只有数量变了（折叠 / 展开）才重建。
        items = getattr(self, "_slab_items", None)
        if items is None or len(items) != 2:
            cv.delete("slab")
            items = [None, None]
        for i, rect in enumerate((top, bot)):
            photo = None if getattr(self, "acrylic", False) else self.plate_photo("slab", rect, r)
            if photo is None:
                items[i] = None
                continue
            self._slab_photos.append(photo)      # 必须留引用，否则被 GC 变空白
            item = items[i]
            if item is not None and cv.type(item) == "image":
                cv.itemconfigure(item, image=photo)
            else:
                items[i] = cv.create_image(int(rect[0]), int(rect[1]), image=photo,
                                           anchor="nw", tags=("panel", "slab"))
        self._slab_items = items

    def _paint_collapsed(self, w, h):
        """折叠状态：**只剩标题栏那一块玻璃**，主体和输入栏一概不画。

        以前折叠只是把内容"藏起来"，但 `_layout` 仍然按窗口高度算出主体和底条两个矩形
        （高度变成负数/互相穿过），玻璃照裁不误 —— 结果窗口底下多出一条横线，输入槽
        还被摆回标题栏上压着字。折叠就该是"换一种画法"，不是"画完再藏"。
        """
        cv = self.canvas
        self._painted_size = (w, h)
        cv.delete("panel")
        # 底板必须按**折叠后的窗口尺寸**重新裁一刀：`_blurred` 还是展开时那张
        # （809 高），直接拿去裁会把整屏压进 105px 里 —— 标题栏那片玻璃会变成
        # 一条把整个桌面压扁的怪东西。
        try:
            self._grab_backdrop((w, h))
        except Exception:
            pass
        top = self._layout(w, h)[0]
        photo = self.plate_photo("slab", top, max(8, int(SLAB_R * self.s)))
        if photo is not None:
            cv.create_image(int(top[0]), int(top[1]), image=photo,
                            anchor="nw", tags=("panel", "slab"))
        else:
            round_rect(cv, top[0], top[1], top[2], top[3],
                       max(8, int(SLAB_R * self.s)), fill=BG, outline="",
                       tags=("panel", "slab"))
        cv.tag_lower("panel")
        self._header_paint(top)
        self._apply_collapsed()

    def _paint(self, event=None):
        # **没 event 时以画布尺寸为准**：`root.winfo_height()` 在 `geometry()` 刚设完、
        # 事件还没处理的那一帧返回的还是旧值 —— 拿它去重烘玻璃，裁出来就是一片 2px。
        w = event.width if event else self.canvas.winfo_width()
        h = event.height if event else self.canvas.winfo_height()
        if w < 4 or h < 4:
            return
        if getattr(self, "_collapsed", False):
            self._paint_collapsed(w, h)
            return
        # 拖动时窗口位置每变一次都会来一发 Configure，但尺寸没变 —— 这种纯粹"搬家"的
        # 重绘没意义（内容一个像素都没动），玻璃交给 `_live_backdrop` 逐帧换。
        if (getattr(self, "_drag", None) and self._painted_size == (w, h)
                and not getattr(self, "_resizing", False)):
            return
        self._painted_size = (w, h)
        self._apply_region()
        self.canvas.delete("panel")
        self._panel_item = None          # 上面的 create_image 已经没了，下次重建
        self._slab_items = None
        self._ensure_blurred(w, h)
        top, body, bot = self._layout(w, h)
        if self.acrylic:
            # 磨砂模式：**什么都不画**。canvas 的抠色被透明掉，露出 DWM 的 GPU 模糊层。
            self._slab_paint(top, bot)
            self._place_furniture(w, h)
            self._reflow()
            return
        photo = self._panel_photo(w, h, body)
        if photo is not None:
            self._backdrop_photo = photo
            self.canvas.create_image(0, 0, image=photo, anchor="nw",
                                     tags=("panel", "backdrop"))
            self._slab_paint(top, bot)
            # **底板必须压在最下层**：它是一张整窗大小的图，晚一步创建就会盖住所有
            # 已经画好的气泡（"重排后只剩最新一条"这个 bug 就是这么来的）。
            self.canvas.tag_lower("panel")
        else:
            # 兜底：没有 Pillow / 截不到屏时至少是一块圆角面板，不能整窗透明
            round_rect(self.canvas, body[0], body[1], body[2], body[3], self.radius,
                       fill=BG, outline="", tags=("panel", "backdrop"))
        self._place_furniture(w, h)
        self._reflow()
        # 折叠状态下重画出来的元素默认是 normal，得再藏一次
        if getattr(self, "_collapsed", False):
            self._apply_collapsed()

    def _place_furniture(self, w, h):
        """摆标题栏和输入栏。**它们全部是画布上的元素**，没有一个 Frame/Label。

        一版用 `tk.Frame` 装标题和按钮，而 Tk 的 Frame 必须填不透明底色 —— 于是
        三块玻璃里最上面那块永远是死黑，玻璃感从第一眼就塌了。现在文字、按钮、
        状态点全是 `create_text` / 画片，只有 `Entry` 留成真控件（它只能实心，
        正好塞进"内凹槽"里，看起来就是设计的一部分）。
        """
        s = self.s
        cv = self.canvas
        top, body, bot = self._layout(w, h)

        # ---- 标题栏 ----
        self._header_paint(top)
        # ---- 输入栏 ----
        self._composer_paint(bot)

        self._view_top = body[1] + int(8 * s)
        self._view_bot = body[3] - int(8 * s)
        self._view_h = max(1, self._view_bot - self._view_top)

    def on_glass_fill(self, x, y, light=TEXT, dark="#0b0e13", thresh=148):
        """**字压在这块玻璃上该用什么颜色**：取那个点的背景亮度，亮就翻成深色字。

        取自 PR #15 的"逐字适配背后明暗"，但**按整段取一次样**（#15 是每个字一个
        canvas item，滚动长列表时 item 数翻倍）。玻璃上文字的明暗在几十像素内几乎
        不变，一个取样点就够 —— 成本 1 次 getpixel。

        为什么要它：我们的 `plate()` 会把底板压暗（平均亮度压到 84 以下），所以白字
        大多数时候都读得清；**但标题条/输入条压在亮网页上时那片玻璃会被洗白**，
        白字就糊了。这一步只在这种时候把字翻成深色。
        """
        try:
            blur = getattr(self, "_blurred", None)
            if blur is None:
                return light
            w, h = blur.size
            px = blur.getpixel((max(0, min(w - 1, int(x))), max(0, min(h - 1, int(y)))))
            lum = 0.299 * px[0] + 0.587 * px[1] + 0.114 * px[2]
            return dark if lum > thresh else light
        except Exception:
            return light

    # ---- 抓屏排除 ----
    def _set_exclude(self, on):
        """让本窗口**从屏幕捕获里消失**（`WDA_EXCLUDEFROMCAPTURE`）。

        这样抓"自己背后"的时候不用把窗口 `-alpha` 设 0 再恢复 —— 那个来回会逼
        DWM 把整个桌面重排两次，视频在播时最贵，肉眼就是"松手闪一下"。
        抓到的直接就是背后的桌面，不递归、不闪。

        代价：**用户的截屏/录屏里看不到这个窗口**（录演示视频要关掉）。
        `DSH_GLASS_WDA=0` 可关。取自 PR #15 的做法。
        """
        try:
            import ctypes
            import ctypes.wintypes as wt
            fn = ctypes.windll.user32.SetWindowDisplayAffinity
            fn.argtypes = [wt.HWND, wt.DWORD]
            fn.restype = wt.BOOL
            return bool(fn(self._hwnd(), 0x11 if on else 0))
        except Exception:
            return False

    # ---- 真毛玻璃底板 ----
    def _hwnd(self):
        """窗口句柄。**只能在窗口 map 之后拿** —— map 之前 `wm_frame()` 拿到的不是
        合成器正在用的那个窗口，挂上去的效果静默丢失（返回 True 但没反应）。"""
        import ctypes.wintypes as wt
        return wt.HWND(int(self.root.wm_frame(), 16))

    def _acrylic_late(self):
        """窗口显示之后：挂磨砂 + 上圆角区域。两件事都必须在 map 之后做。"""
        try:
            self.root.update_idletasks()
        except Exception:
            pass
        ok = self._apply_acrylic()
        if os.environ.get("DSH_GLASS_DEBUG") == "1":
            try:
                print(f"[acrylic] frame={self.root.wm_frame()} ok={ok} "
                      f"mapped={self.root.winfo_ismapped()} "
                      f"size={self.root.winfo_width()}x{self.root.winfo_height()}",
                      file=sys.stderr, flush=True)
            except Exception:
                pass
        if not ok:
            self.acrylic = False        # 挂不上就干净地退回抓屏模式，别留个半成品
            return
        self._apply_region()
        # 磨砂层是矩形，canvas 的抠色抠不动它 → 圆角只能靠窗口区域
        self._paint()

    def _apply_region(self):
        """把窗口裁成**三块分离的圆角玻璃片**：顶栏 / 主体 / 输入栏。

        这是整套实时透明的关键。`SetWindowRgn` 接受**不相连的多段区域**：
        只保留三块圆角矩形，它们之间的缝不在窗口区域内 → 窗口在那里"不存在"
        → 缝里透出的是**未经任何处理的桌面**，而三块里是染过色的透明层。

        几何直接取 `_layout(w, h)` —— 就是抓屏玻璃版一直在用的那三个矩形，
        所以"布局"和原来一模一样，只是透明层换成了 DWM 实时合成。

        ⚠️ 三个必须遵守的点（都踩过）：
        1. **只能在窗口 map 之后调**（`__init__` 里 `winfo_width()` 返回 1 → 裁成 2×2 黑块）。
        2. **必须先把所有段合成完，最后只调一次 `SetWindowRgn`**：成功后句柄归系统所有，
           再拿它做 `CombineRgn` 会静默失败（表现就是"设了多段，出来还是一整块"）。
        3. GDI 句柄是 64 位，`CreateRoundRectRgn` 的 `restype` 不声明成 `c_void_p`
           会被截断成 32 位 —— 同样返回 True、同样没效果。
        """
        if not self.acrylic:
            return
        try:
            import ctypes
            w = self.canvas.winfo_width()
            h = self.canvas.winfo_height()
            if w < 8 or h < 8:
                return
            collapsed = bool(getattr(self, "_collapsed", False))
            top, body, bot = self._layout(w, h)
            segs = [top] if collapsed else [top, body, bot]
            key = (w, h, collapsed, tuple(int(v) for v in bot))
            if getattr(self, "_region_size", None) == key:
                return
            self._region_size = key

            gdi, user = ctypes.windll.gdi32, ctypes.windll.user32
            gdi.CreateRoundRectRgn.restype = ctypes.c_void_p
            gdi.CreateRoundRectRgn.argtypes = [ctypes.c_int] * 6
            gdi.CreateRectRgn.restype = ctypes.c_void_p
            gdi.CreateRectRgn.argtypes = [ctypes.c_int] * 4
            gdi.CombineRgn.argtypes = [ctypes.c_void_p, ctypes.c_void_p,
                                       ctypes.c_void_p, ctypes.c_int]
            gdi.DeleteObject.argtypes = [ctypes.c_void_p]
            user.SetWindowRgn.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_bool]

            panel_r = max(8, 2 * self.radius)        # 主体：外圈同心半径
            slab_r = max(8, 2 * int(SLAB_R * self.s))  # 两条悬浮片小一档
            out = gdi.CreateRectRgn(0, 0, 0, 0)
            for i, (x1, y1, x2, y2) in enumerate(segs):
                # 三条缝本来就是"没东西"，别让区域外扩
                x1, y1 = int(round(x1)), int(round(y1))
                x2, y2 = int(round(x2)), int(round(y2))
                if x2 - x1 < 4 or y2 - y1 < 4:
                    continue
                d = slab_r if i != 1 else panel_r
                part = gdi.CreateRoundRectRgn(x1, y1, x2, y2, d, d)
                gdi.CombineRgn(out, out, part, 2)     # RGN_OR
                gdi.DeleteObject(part)
            user.SetWindowRgn(self._hwnd(), out, True)
        except Exception:
            pass

    def _apply_acrylic(self):
        """给窗口挂上 DWM 的**实时透明层**（`SetWindowCompositionAttribute`）。

        ## 为什么是 state 2，不是 3/4
        | AccentState | 效果 | 能不能透出**清晰**背景 |
        |---|---|---|
        | 1 GRADIENT | 纯色 | ✗（完全实心，std 0.0） |
        | **2 TRANSPARENTGRADIENT** | **只染色、不模糊** | ✓（实测 std 47.5，字边锐利） |
        | 3 BLURBEHIND | 模糊 | ✗（std 1.8，糊成一片） |
        | 4 ACRYLICBLURBEHIND | 磨砂 | ✗（std 1.8） |

        用 2 的意义：背景**由 DWM 每帧合成**，我们一次屏都不截 —— 真正的零延迟半透明；
        而且背景是清晰的，不是糊的。抓屏那套 26.8Hz 的方案就是为了"透出背景"，
        现在这条不要了（`DSH_GLASS_ACRYLIC=0` 仍可退回抓屏）。
        `DSH_GLASS_ACCENT_STATE` 可改档（想磨砂就设 4）。
        """
        try:
            import ctypes
            import ctypes.wintypes as wt

            class ACCENT(ctypes.Structure):
                _fields_ = [("AccentState", ctypes.c_int), ("AccentFlags", ctypes.c_int),
                            ("GradientColor", ctypes.c_uint), ("AnimationId", ctypes.c_int)]

            class WCAD(ctypes.Structure):
                _fields_ = [("Attribute", ctypes.c_int),
                            ("Data", ctypes.POINTER(ACCENT)),
                            ("SizeOfData", ctypes.c_size_t)]

            # ABGR。**alpha 就是"这层颜色盖多厚"**：0xB4(180)=70% 几乎看不见背景，
            # 0x8C(140)=55% 能在染色后仍分辨出背后的画面，同时白字读得清。
            tint = int(os.environ.get("DSH_GLASS_ACRYLIC_TINT") or "0x8C121014", 0)
            try:
                state = int(os.environ.get("DSH_GLASS_ACCENT_STATE") or 2)
            except Exception:
                state = 2
            policy = ACCENT(state, 2, tint & 0xFFFFFFFF, 0)
            data = WCAD(19, ctypes.pointer(policy), ctypes.sizeof(policy))
            hwnd = wt.HWND(int(self.root.wm_frame(), 16))
            ok = bool(ctypes.windll.user32.SetWindowCompositionAttribute(hwnd, ctypes.byref(data)))
            if ok:
                # 这层自带透明，再叠整窗 alpha 会发灰
                try:
                    self.root.attributes("-alpha", 1.0)
                except Exception:
                    pass
                # **圆角和"三块分离"都交给 `_apply_region()`**：这一层是整窗矩形的，
                # canvas 的 `-transparentcolor` 抠不动 DWM 画上去的像素 —— 抠色只对
                # "我们自己画的内容"有效。但**绝不能在 `__init__` 里设区域**
                # （那次把窗口裁成 2×2 黑块、鼠标都点不进去）。
            return ok
        except Exception:
            return False

    def _dpi_k(self):
        """DPI 系数（首算后缓存）：拖动的每一帧都要用，别每次去问 Windows"""
        k = getattr(self, "_dpik", None)
        if k is None:
            k = self._dpi_scale()
            self._dpik = k
        return k

    def _dpi_scale(self):
        """Tk 坐标 → 物理像素的倍数（`ImageGrab` 要的单位）。

        **运行期实测，不写死也不猜**：本机实测 `winfo_width()` = 701 = `GetWindowRect`
        宽度 = 701、`GetDpiForWindow` = 144，三者一致 —— 说明 Tk 在这个 DPI-aware 进程里
        报的**就是物理像素**，再乘 1.5 会把截图区域送到窗口外去（表现为"模糊图跟窗口对不上"，
        但因为糊过又压暗过，肉眼很难发现，只会觉得"背景怪怪的"）。
        不感知 DPI 的环境里 Tk 报逻辑像素，这时才需要乘 —— 比一次宽度就知道是哪种。
        """
        try:
            import ctypes
            import ctypes.wintypes as wt
            hwnd = int(self.root.wm_frame(), 16)
            rect = wt.RECT()
            ctypes.windll.user32.GetWindowRect(hwnd, ctypes.byref(rect))
            win_w = rect.right - rect.left
            tk_w = self.root.winfo_width()
            if win_w > 4 and tk_w > 4:
                return max(0.5, min(4.0, win_w / float(tk_w)))
        except Exception:
            pass
        return 1.0

    def _window_rect(self, size=None):
        """窗口在屏幕上的矩形（`ImageGrab` 的单位）。

        `size` 显式传入时用它，**不读 `winfo_width()`** —— 窗口处于 `withdraw`
        状态时 `winfo_*` 全是 1，开窗第一次截图会截出一张 1×1 的图（缩放到全屏
        以后是一块纯色，看起来就像"毛玻璃没生效"）。
        """
        try:
            self.root.update_idletasks()
            if size:
                w, h = int(size[0]), int(size[1])
                x, y = int(self.x), int(self.y)
            else:
                x, y = self.root.winfo_rootx(), self.root.winfo_rooty()
                w, h = self.root.winfo_width(), self.root.winfo_height()
            if w < 4 or h < 4:
                return None
            k = self._dpi_scale()
            return int(x * k), int(y * k), int(w * k), int(h * k)
        except Exception:
            return None

    def _phys_screen(self):
        """屏幕的**物理**像素尺寸。mss 给物理（2560×1600），ImageGrab 在 DPI-unaware
        进程里给逻辑（1707×1067）—— 两者不能混用，否则玻璃取的位置会整体偏掉。"""
        cached = getattr(self, "_phys_screen_cache", None)
        if cached is not None:
            return cached
        size = None
        if HAVE_MSS:
            try:
                factory = getattr(_mss, "MSS", None) or getattr(_mss, "mss")
                with factory() as g:
                    m = g.monitors[1]
                    size = (m["width"], m["height"])
            except Exception:
                size = None
        if size is None:
            size = (self.root.winfo_screenwidth(), self.root.winfo_screenheight())
        self._phys_screen_cache = size
        return size

    def _win_phys(self, pad=0):
        """窗口在屏幕上的**物理**矩形，可选外扩 `pad`（夹在屏幕内）。"""
        k = self._dpi_k()
        sw, sh = self._phys_screen()
        x, y = int(self.x * k), int(self.y * k)
        w, h = int(self.w * k), int(self.h * k)
        left = max(0, x - pad)
        top = max(0, y - pad)
        right = min(sw, x + w + pad)
        bottom = min(sh, y + h + pad)
        return left, top, max(1, right - left), max(1, bottom - top)

    def _stage(self, force=False):
        """整块"已经糊好"的底板，**带留白**，1/4 分辨率。返回 (small, (sx,sy,sw,sh), at)。

        为什么带留白：拖窗/缩放后每停一次手都要重算一次底板，而截屏 + 糊一次是
        70~90ms（还要先把窗口 `-alpha` 拉到 0 让 DWM 重排）。这里一次把"窗口 + 四周
        340px"一起处理掉，之后只要窗口还在这个范围里，取底板就是**裁一刀**（1~2ms）。
        留白 1.5 秒内有效 —— 背后可能是正在播放的视频，太久就真的不一样了。

        为什么在 1/4 上把 blur/saturate/refract 全做完：这些都是低频处理，缩着做
        和放大做看不出差别，但成本差 16 倍；最后只把**窗口那一块**放大回去。
        """
        now = time.time()
        cur = getattr(self, "_stage_cache", None)
        if cur is not None and not force:
            return cur
        # **整屏一张**（不是"窗口 + 留白"）：留白再大也有拖出去的时候，一出界就要
        # 重新截屏 → 那一下就是"松手卡一下、闪一下"。整屏 1/4 分辨率只有 640×400，
        # 一次截屏 + 缩 + 糊不到 200ms，而且**只在开窗时发生一次**（那时窗口是
        # withdraw 的，看不见）—— 之后无论拖到哪儿都是裁一刀。
        # **只抓"窗口 + 200px 留白"**，不抓整屏：本机实测整屏 41.6ms、
        # 这块区域 11.8ms（2560×1600 屏幕 / 700×808 窗口），快 3.5 倍。
        # 留白够遮住松手前的几像素漂移，真拖出去了 `_grab_backdrop` 会把缺的补黑。
        PAD = 200
        sx, sy, sw, sh = self._win_phys(PAD)
        shot = None
        if HAVE_MSS:
            try:
                factory = getattr(_mss, "MSS", None) or getattr(_mss, "mss")
                with factory() as grabber:
                    raw = grabber.grab({"left": sx, "top": sy, "width": sw, "height": sh})
                shot = Image.frombytes("RGB", raw.size, raw.bgra, "raw", "BGRX")
            except Exception:
                shot = None
        if shot is None:
            # 没有 mss：ImageGrab 在这个 DPI-unaware 进程里要**逻辑坐标**
            k = self._dpi_k()
            shot = ImageGrab.grab(bbox=(sx / k, sy / k, (sx + sw) / k, (sy + sh) / k),
                                  all_screens=True)
        small = build_stage(shot, sw, sh, self.s)
        self._stage_cache = (small, (sx, sy, sw, sh), now)
        return self._stage_cache

    def _grab_backdrop(self, size=None, force_stage=False):
        """取窗口那一块底板：**从带留白的 stage 里裁 + 放大**，不做截屏本身。

        **调用前窗口必须不可见**（首次开窗是 withdraw，之后靠 `-alpha 0`），否则会把
        自己截进去。缓存命中时调用方根本不需要隐藏窗口（见 `_refresh_backdrop`）。

        **这里只负责"糊"，不负责"压暗"**：压暗交给每块玻璃自己算（`plate()`），
        因为它要按**自己那块**的平均亮度来定 —— 标题栏可能压在白网页上、主体压在
        暗场景上，一个全窗统一的不透明度必然有一头是错的。
        """
        if not HAVE_PIL or not self.rounded:
            return None
        rect = self._window_rect(size)
        if rect is None:
            return None
        x, y, w, h = rect
        try:
            if size:
                lw, lh = int(size[0]), int(size[1])
            else:
                try:
                    lw, lh = self.root.winfo_width(), self.root.winfo_height()
                except Exception:
                    lw, lh = w, h
            lw, lh = max(4, int(lw)), max(4, int(lh))
            staged = self._stage(force=force_stage)
            if staged is None:
                return None
            small, (sx, sy, sw, sh), _at = staged
            kx = small.size[0] / float(max(1, sw))
            ky = small.size[1] / float(max(1, sh))
            # 窗口可能有一截在屏幕外（贴边/半出界）：stage 里没有那块画面，裁完贴回一张
            # 同尺寸的图里，缺的部分留黑 —— 那截本来就不在屏幕上，用户看不见。
            cx0 = int(round((x - sx) * kx))
            cy0 = int(round((y - sy) * ky))
            cx1 = cx0 + max(1, int(round(w * kx)))
            cy1 = cy0 + max(1, int(round(h * ky)))
            sw0, sh0 = small.size
            box = (max(0, min(cx0, sw0 - 1)), max(0, min(cy0, sh0 - 1)),
                   max(1, min(cx1, sw0)), max(1, min(cy1, sh0)))
            piece = small.crop(box)
            full = Image.new("RGBA", (max(1, cx1 - cx0), max(1, cy1 - cy0)), (0, 0, 0, 255))
            full.paste(piece, (box[0] - cx0, box[1] - cy0))
            # 拖动时用 NEAREST：底板已经是 1/8 模糊图，最近邻放大和双线性肉眼分不出，
            # 但 700×808 的缩放从 5.7ms 降到 1.9ms（拖动是 60Hz，这一项就是 34% 占用）。
            interp = Image.NEAREST if getattr(self, "_drag", None) else Image.BILINEAR
            img = full.resize((lw, lh), interp)
            self._blurred = img.convert("RGBA")
            self._glass_v += 1
            # 只作废"吃底板"的那几片（面板/悬浮条）：气泡的缓存键里带的是 `_chat_v`，
            # 这里要是整张清掉，拖动时每帧都要把 6 条气泡重烘一遍（约 6ms/帧）。
            for cache in (self._plates, self._plate_imgs):
                for k in [k for k in cache if k[0] in ("panel", "slab", "__panel__")]:
                    cache.pop(k, None)
            # 气泡玻璃只在"挪得很远"时才作废（见 `chat_glass_ver`）
            ox, oy = getattr(self, "_last_origin", (None, None)) or (None, None)
            if ox is None or abs(x - ox) + abs(y - oy) > 260:
                self._chat_v += 1
            self._last_origin = (x, y)
            return self._blurred
        except Exception:
            return None

    def _shot_usable(self, x, y, w, h):
        """缓存的 stage 还能不能盖住这个窗口矩形（1.5 秒内有效）"""
        cur = getattr(self, "_stage_cache", None)
        if cur is None:
            return False
        _img, (sx, sy, sw, sh), _at = cur
        # **只要求"有重叠"**，不要求完全包含：窗口贴屏幕边时总有一截在外面，
        # 以前这里判"必须整块在 stage 里"，于是每次贴边松手都回退去重新截屏 —— 一闪。
        return x + w > sx and y + h > sy and x < sx + sw and y < sy + sh

    def _refresh_backdrop(self, hide_first=False, force_stage=False):
        """重截底板并重绘。`hide_first=True` 时先把自己透明掉（窗口已在显示状态）。"""
        if not HAVE_PIL or not self.rounded:
            return
        prev_alpha = None
        try:
            # **能复用带留白的缓存截图时就不隐藏窗口**：`-alpha` 来回切会逼 DWM 把整个
            # 桌面重排两次（视频在播时尤其贵），而缓存命中时根本不需要截自己。
            rect = self._window_rect((self.w, self.h))
            # `self._excluded`（WDA 生效）时**永远不用隐藏**：窗口本来就不在捕获结果里
            if (hide_first and not getattr(self, "_excluded", False)
                    and (force_stage or not (rect and self._shot_usable(*rect)))):
                prev_alpha = self.root.attributes("-alpha")
                self.root.attributes("-alpha", 0.0)
                self.root.update_idletasks()
                self.root.update()
            self.backdrop = self._grab_backdrop((self.w, self.h), force_stage=force_stage)
        finally:
            if prev_alpha is not None:
                try:
                    self.root.attributes("-alpha", prev_alpha)
                except Exception:
                    pass
        self._paint()

    def _request_backdrop(self):
        """拖动/缩放结束后延迟重截 —— 每动一下都截会卡，也没意义"""
        if not HAVE_PIL or not self.rounded:
            return
        try:
            if self._backdrop_job:
                self.root.after_cancel(self._backdrop_job)
        except Exception:
            pass
        self._backdrop_job = self.root.after(420, self._backdrop_settle)

    def _backdrop_settle(self):
        self._backdrop_job = None
        # 先试"不隐身"的写法：stage 还盖得住就只裁一次（几十毫秒内、无闪烁）。
        # 只有真的拖出了留白范围，才值得为它把窗口藏一帧去截屏。
        if self._live_backdrop():
            # 拖动本身永远是即时的；只有"底板已经 8 秒没更新"才值得为它藏一帧重截，
            # 否则一直用这一张。连续拖动时前面几帧都是新的，根本不会触发。
            at = self._stage_cache[2] if self._stage_cache else 0
            if time.time() - at > 8.0:
                self._refresh_backdrop(hide_first=True, force_stage=True)
            return
        self._refresh_backdrop(hide_first=True, force_stage=True)

    def _build_header(self):
        """标题栏：**全部画在画布上**，一个 Frame 都不用。

        一版是 `tk.Frame(bg="#222836")` + 几个 Label。Frame 必须填不透明底色，于是
        最上面那块玻璃永远是一根死黑条 —— 玻璃感从第一眼就塌了。现在状态点、名字、
        条数、两个图标按钮都是画布元素，底下的玻璃该透还是透。

        名字**可以改**（用户要把它改成自己的叫法）：点标题就地变输入框，回车/失焦存进
        `~/.dsh/watch-window.json` 的 `name`。
        """
        self._head_rect = (0, 0, 1, 1)
        self._hint_text = ""
        self._count = 0
        self.dot_fg = ACCENT
        self._title_item = None
        self._editing = False

        # 改名用的 Entry：平时**不挂在画布上**（只在自己触发时 create_window）
        self.title_entry = tk.Entry(self.canvas, bg="#1b1f27", fg=TEXT, relief="flat",
                                    bd=0, insertbackground=TEXT,
                                    font=self._f(10, "bold"), highlightthickness=0,
                                    width=10)
        self.title_entry.bind("<Return>", self._commit_title)
        self.title_entry.bind("<Escape>", lambda _e: self._cancel_title())
        self.title_entry.bind("<FocusOut>", lambda _e: self._commit_title(None))

        self.btn_close = GlassButton(self, "hd-close", "✕", kind="icon", fg=TEXT,
                                     command=self.close, size=9, group="hdr")
        self.btn_collapse = GlassButton(self, "hd-collapse", "▾", kind="icon", fg=TEXT,
                                        command=self.toggle_collapse, size=9, group="hdr")
        self.canvas.tag_bind("hd-title", "<Button-1>", self._edit_title)

    def _header_paint(self, top):
        """重画标题栏（位置随窗口尺寸变，所以每次都整块重画，成本可忽略）"""
        cv = self.canvas
        cv.delete("header-art")
        s = self.s
        x1, y1, x2, y2 = top
        self._head_rect = top
        cy = (y1 + y2) / 2.0
        cyi = int(round(cy))

        # ---- 右侧两个图标井（28×28 的圆，悬停才浮出玻璃）----
        btn = int(28 * s)
        pad = int(10 * s)
        gap = int(4 * s)
        rx2 = x2 - pad
        self.btn_close.layout((rx2 - btn, cy - btn / 2, rx2, cy + btn / 2))
        cx2 = rx2 - btn - gap
        self.btn_collapse.layout((cx2 - btn, cy - btn / 2, cx2, cy + btn / 2))

        # ---- 状态点：一个实心点 + 一圈很淡的光环 ----
        # 纯色圆点在玻璃上像贴纸；带光环才像"亮着的东西"。
        dx = x1 + int(17 * s)
        r = max(2.0, 3.2 * s)
        cv.create_oval(dx - r * 2.1, cy - r * 2.1, dx + r * 2.1, cy + r * 2.1,
                       outline="", fill="", width=1,
                       tags=("hdr", "header-art"))
        cv.create_oval(dx - r * 2.1, cy - r * 2.1, dx + r * 2.1, cy + r * 2.1,
                       outline=_mix(self.dot_fg, HEAD_BG, 0.62), width=max(1, int(s)),
                       tags=("hdr", "header-art"))
        cv.create_oval(dx - r, cy - r, dx + r, cy + r, fill=self.dot_fg, outline="",
                       tags=("hdr", "header-art"))

        # ---- 名字 + 条数 + 状态 ----
        tx = dx + r * 2.4 + int(7 * s)
        t = text_on_glass(cv, tx, cyi, self.name, font=self._f(10, "bold"),
                          fill=self.on_glass_fill(tx, cyi), anchor="w",
                          tags=("hdr", "header-art", "hd-title"),
                          offset=max(1, int(s)))
        box = cv.bbox(t) or (int(tx), cyi, int(tx) + int(40 * s), cyi)
        nx = box[2] + int(7 * s)
        if self._count > 0:
            c = cv.create_text(nx, cyi + max(1, int(s)), text=f"{self._count} 条",
                               font=self._f(8.5), fill=DIM, anchor="w",
                               tags=("hdr", "header-art"))
            box = cv.bbox(c) or box
            nx = box[2] + int(7 * s)
        if self._hint_text:
            cv.create_text(nx, cyi + max(1, int(s)), text=self._hint_text,
                           font=self._f(8.5), fill=DANGER, anchor="w",
                           tags=("hdr", "header-art"))
    # ---- 改名 ----
    def _edit_title(self, _event=None):
        """标题就地变输入框（不弹对话框 —— 那会把置顶窗口挡掉一半）"""
        if getattr(self, "_editing", False):
            return "break"
        self._editing = True
        s = self.s
        top = self._head_rect
        self.title_entry.delete(0, "end")
        self.title_entry.insert(0, self.name)
        if self._title_item is None:
            self._title_item = self.canvas.create_window(
                top[0] + int(26 * s), (top[1] + top[3]) / 2.0,
                window=self.title_entry, anchor="w", width=int(120 * s))
        self.title_entry.focus_set()
        self.title_entry.select_range(0, "end")
        return "break"

    def _commit_title(self, _event=None):
        # **用显式标志，不用 `winfo_ismapped()`**：widget 刚挂上画布那一帧
        # ismapped 还是 False，用户输入快一点回车就被这行吞掉（实测）。
        if not getattr(self, "_editing", False):
            return
        self._editing = False
        text = self.title_entry.get().strip()
        if self._title_item is not None:
            self.canvas.delete(self._title_item)
            self._title_item = None
        if text and text != self.name:
            self.name = text[:24]
            self.root.title(self.name)
            write_config({"name": self.name})
        self._header_paint(self._head_rect)
        return "break"

    def _cancel_title(self):
        self._editing = False
        if self._title_item is not None:
            self.canvas.delete(self._title_item)
            self._title_item = None
        self._header_paint(self._head_rect)
        return "break"

    def _reflow(self):
        """重排所有消息并重画（窗口尺寸变化 / 新消息 / 滚动都走这里）。

        自绘列表的老问题：先要知道每条多高才能算位置，所以分两遍 ——
        `measure()` 只测不画，`paint()` 才落 item。宽度没变就复用上次的测量结果，
        避免每次滚一下都把 60 条消息重新测一遍。
        """
        cv = self.canvas
        w = cv.winfo_width()
        if w < 4:
            return
        if getattr(self, "_collapsed", False) or self._view_h < 8:
            # 折叠时视口高度是 0，以前每条都满足"比视口还高"那个分支 → 全部照画，
            # 而且是拿折叠后那张 102px 高的底板去裁 → 每条气泡烘出一片 2px 的玻璃。
            for it in self._items:
                cv.delete(it.tag)
            self._total_h = 0
            return
        avail = max(120, w - 2 * self.pad)
        top, view_h = self._view_top, self._view_h

        # **每条都不能高过视口**：见 `Bubble.measure` 的 `max_h`。
        # 视口还没量出来（首帧 `_view_h` 是 1）时不限制，否则会把所有气泡截成一行。
        max_h = (view_h - 2) if view_h >= 80 else 0
        total = 0
        for it in self._items:
            key = (avail, max_h)
            if getattr(it, "_mkey", None) != key:
                it.measure(cv, avail, max_h)
                it._mkey = key
            total += it.h
        self._total_h = total

        # 贴底逻辑：内容比视口短就顶对齐；长了就滚到最底（新消息来了要看得到）
        max_scroll = max(0, total - view_h)
        self._scroll = max(0, min(self._scroll, max_scroll))
        y = top - self._scroll

        x0 = self.pad
        # **边框淡出带**：卡在视口边上的消息按"离边多远"给不透明度，滚进来是渐显、
        # 滚出去是渐隐。以前是"完整可见才画、否则直接删"，于是消息一跨过边界就
        # 整块蹦出来/消失（用户说的"闪现"）—— 画布没法裁剪，只能靠透明度接上。
        band = max(12.0, 30.0 * self.s)
        view_h_all = self._view_bot - top
        # **到头的那一侧不要淡出**：滑到最底时最后一条正好贴着下沿，若还按"离边多远"
        # 算，它就永远只剩一成不透明度 —— 最新的一条反而是最看不清的一条（真踩到了）。
        at_top = self._scroll <= 0.5
        at_bottom = self._scroll >= max_scroll - 0.5
        for it in self._items:
            y2 = y + it.h
            if it.h > view_h_all:
                # 比视口还高的一条（超长台词）：不能按"完整可见"判，否则永远不画。
                # **但它也不能从视口外面开始画** —— 玻璃是半透明的，从上面画起就会
                # 盖住标题栏，用户看到的就是"字顶到标题栏里去了"。
                # 画布裁不了，所以至少把起点夹进视口：顶部永远不越过 `top`。
                it.paint(cv, x0, min(y, top), avail, 1.0)
            elif y >= top - 1 and y2 <= self._view_bot + 1:
                f_top = 1.0 if at_top else min(1.0, (y - top) / band)
                f_bot = 1.0 if at_bottom else min(1.0, (self._view_bot - y2) / band)
                it.paint(cv, x0, y, avail, max(0.0, min(f_top, f_bot)))
            else:
                cv.delete(it.tag)
            y = y2
        self._draw_scrollbar()
        # **层级重排**：消息是后画的，会盖住玻璃片和标题栏。这里按"从下往上"的顺序
        # 重新提一遍：片 → 标题栏 → 输入栏 → 滚动条。少提一层就会看到消息从标题栏
        # 里穿出来。
        # 顺序有讲究：填槽（field）必须在"片"之后、"控件"之前 ——
        # 片先提上来会把输入槽整个盖掉（表现就是"输入框没有圆角"，其实连底都没画上）。
        for tag in ("slab", "field", "hdr", "cmp", "sbar"):
            cv.tag_raise(tag)

    def _draw_scrollbar(self):
        """细滚动条：只在真的滚得动时出现（原生 Scrollbar 太丑）"""
        cv = self.canvas
        cv.delete("sbar")
        if self._total_h <= self._view_h:
            return
        s = self.s
        # **放在主体玻璃外面的留白里**（不在消息区里）：一进内容区就会和气泡抢地方，
        # 也会挡住台词最后一个字。和输入栏一样，它是"浮在窗口上的一件东西"，
        # 不属于那块玻璃。
        w = cv.winfo_width()
        bw = max(3, int(3.4 * s))
        x = w - self.out + int(6 * s)
        frac = self._view_h / self._total_h
        thumb_h = max(int(26 * s), self._view_h * frac)
        t = self._scroll / max(1, self._total_h - self._view_h)
        y0 = self._view_top + t * (self._view_h - thumb_h)
        # Canvas 没有 alpha，只能挑一个"压在深色和浅色上都看得见"的中性灰
        round_rect(cv, x, y0, x + bw, y0 + thumb_h, bw / 2.0,
                   fill="#8d95a4", outline="", tags="sbar")

    def _at_bottom(self):
        return self._scroll >= max(0, self._total_h - self._view_h) - 2

    def _to_bottom(self):
        self._scroll = max(0, self._total_h - self._view_h)
        self._reflow()

    def _scroll_to(self, target, steps=5):
        """滚动补间：5 帧 × 16ms 走完。

        **一格格硬跳就是"闪现"的另一半原因**：滚轮一次 60px，消息要么在、要么不在，
        边缘淡出根本没机会表现。补间以后每帧只挪十几像素，淡出带才真的"带"。
        """
        target = max(0, min(max(0, self._total_h - self._view_h), target))
        start = self._scroll
        if abs(target - start) < 1:
            return
        try:
            if getattr(self, "_scroll_job", None):
                self.root.after_cancel(self._scroll_job)
        except Exception:
            pass
        self._scroll_job = None

        def step(i):
            self._scroll_job = None
            t = i / float(steps)
            self._scroll = start + (target - start) * (1.0 - (1.0 - t) ** 2)
            self._reflow()
            if i < steps:
                self._scroll_job = self.root.after(16, lambda: step(i + 1))

        step(1)

    def _on_wheel(self, event):
        if self._total_h <= self._view_h:
            return "break"
        step = int(30 * self.s)
        delta = -1 if event.delta > 0 else 1
        self._scroll_to(self._scroll + delta * step)
        return "break"

    def _clear_empty(self):
        if self.empty is not None:
            try:
                self._items.remove(self.empty)
            except ValueError:
                pass
            self.canvas.delete(self.empty.tag)
            self.empty = None

    def _show_empty(self):
        if self.empty is not None or self._items:
            return
        self.empty = Meta("在这里跟它说话 · 回车发送", self.opt, center=True)
        self._items.append(self.empty)
        self._reflow()

    def _add_bubble(self, role, text, stamp):
        stick = self._at_bottom()
        self._clear_empty()
        bubble = Bubble(role, text, stamp, self.opt, self)
        bubble._anim = 0.0          # 新来的从"没有"开始，历史回放不走这一套
        self._items.append(bubble)
        self._count = getattr(self, "_count", 0) + 1
        if stick:
            self._scroll = 10 ** 9      # 让 _reflow 夹到最底
        self._reflow()
        self._header_paint(self._head_rect)
        self._animate_in(bubble)

    def _animate_in(self, bubble, steps=8, delay=24):
        # 两个旋钮留出来是给"手感"调参用的（和 GLASS_* 一样）；正常不用动
        try:
            steps = max(2, int(os.environ.get("DSH_WATCH_ANIM_STEPS") or steps))
            delay = max(8, int(os.environ.get("DSH_WATCH_ANIM_DELAY") or delay))
        except Exception:
            pass
        """新气泡入场：约 200ms，从"低 10px + 淡"浮到位。

        tkinter 没有补间动画，Canvas 的 item 也没有透明度可调 —— 只能每帧重新合成
        一张淡一点的玻璃图、再挪一下位置。8 帧 × 24ms 的节奏，眼睛能看清"渐变"，
        又不至于让台词比声音晚太多（陪看是实时读的，动画一长就变成不同步）。
        """
        if not self.glass_ready():
            bubble._anim = 1.0
            return
        prev = getattr(self, "_anim_bubble", None)
        if prev is not None and prev is not bubble:
            # 上一条还在飘就直接落地，别两条一起晃
            prev._anim = 1.0
            try:
                prev.repaint(self.canvas)
            except Exception:
                pass
        self._anim_bubble = bubble

        def step(i):
            if bubble not in self._items:
                return
            t = i / float(steps)
            bubble._anim = 1.0 - (1.0 - t) ** 3      # ease-out：起步快、收尾稳
            try:
                bubble.repaint(self.canvas)
            except Exception:
                return
            if i < steps:
                self.root.after(delay, lambda: step(i + 1))

        step(1)

    def _add_meta(self, text):
        stick = self._at_bottom()
        self._clear_empty()
        self._items.append(Meta(text, self.opt))
        if stick:
            self._scroll = 10 ** 9
        self._reflow()

    def _build_composer(self):
        """输入栏：一个**内凹**胶囊 + 麦（玻璃方钮）+ 发送（强调胶囊）。

        一版把三个控件 `pack` 进一个 `bg=SLAB_FILL` 的 Frame —— 那条不透明底色直接
        把底部玻璃盖成一根黑条，是"丑"的第二大来源。现在只有 `Entry` 是真空控件
        （它只能不透明，正好当内凹槽），胶囊底和两个按钮全是画布元素。
        """
        # selectbackground 必须显式设成底色系：Tk 默认是白色，一有选区就在输入框里
        # 显示一块白方块（截图里那个白块就是它）
        # insertbackground 和底色一样：这个 Entry 只有 2×2，任何可见元素都是噪点
        self.entry = tk.Entry(self.canvas, bg=FIELD_BG, fg=TEXT, insertbackground=FIELD_BG,
                              selectbackground="#2b4d73", selectforeground="#ffffff",
                              relief="flat", bd=0, font=self._f(10),
                              highlightthickness=0)
        self.entry.bind("<Return>", self._send)
        self.entry.bind("<FocusIn>", lambda _e: self._on_entry_focus(True))
        self.entry.bind("<FocusOut>", lambda _e: self._on_entry_focus(False))
        # 每次敲键都把画布上的字同步一遍（Entry 自己看不见）
        self.entry.bind("<KeyRelease>", lambda _e: self._sync_field_text(), add="+")
        self._field_text_id = None
        self._field_caret_id = None
        self._caret_on = True
        self._entry_item = self.canvas.create_window(0, 0, window=self.entry,
                                                     anchor="w", tags=("cmp",))

        self.mic_btn = GlassButton(self, "cmp-mic", "麦", kind="ghost", fg=MUTED,
                                   command=self.toggle_mic, size=9.5, group="cmp")
        self.send_btn = GlassButton(self, "cmp-send", "发送", kind="accent", fg="#ffffff",
                                    fill=ACCENT, command=self._send, size=9.5, group="cmp")
        self._field_rect = None
        self._field_geo = None
        self._field_focus = False
        self._field_ids = {}

    def _sync_field_text(self):
        """把 Entry 里的字画到输入槽上（Entry 自己已经移出画布）。

        只做"字 + 光标"，不做背景 —— 背景就是脚下那块玻璃。
        空的时候显示一行灰提示，省得槽里空荡荡的。
        """
        cv = self.canvas
        rect = getattr(self, "_field_rect", None)
        if not rect:
            return
        x1, y1, x2, y2 = rect
        padx = int((y2 - y1) / 2.0 + 3 * self.s)
        try:
            typed = self.entry.get()
        except Exception:
            typed = ""
        show = typed if typed else "和 AI 说点什么…"
        fill = TEXT if typed else "#5a6577"
        cx, cy = x1 + padx, (y1 + y2) / 2.0
        # **聚焦时字由 Entry 自己画**：它此刻贴在槽里，bg 和槽同色，看起来就是
        # "字直接长在玻璃上"；canvas 再画一遍会和它重影（两倍字重）。
        try:
            focused = bool(getattr(self, "_field_focus", False)) or \
                (self.root.focus_get() is self.entry)
        except Exception:
            focused = bool(getattr(self, "_field_focus", False))
        item = getattr(self, "_field_text_id", None)
        try:
            if item is not None and cv.type(item) == "text":
                cv.itemconfigure(item, text=show, fill=fill)
                cv.coords(item, cx, cy)
            else:
                self._field_text_id = text_on_glass(
                    cv, cx, cy, show, anchor="w", fill=fill, font=self._f(10),
                    tags="field", offset=max(1, int(self.s)))
        except Exception:
            self._field_text_id = None
        # 光标：一条竖线，按 500ms 闪。**只在聚焦时画**，否则一直闪很吵。
        caret = getattr(self, "_field_caret_id", None)
        if not focused or not self._caret_on:
            if caret is not None and cv.type(caret) == "line":
                cv.itemconfigure(caret, state="hidden")
            return
        tx = cx
        if typed:
            try:
                from tkinter import font as tkfont
                tx = cx + tkfont.Font(family=self.family,
                                      size=max(7, int(10 * self.s))).measure(typed)
            except Exception:
                tx = cx + len(typed) * 11 * self.s
        hh = (y2 - y1) * 0.30
        if caret is not None and cv.type(caret) == "line":
            cv.coords(caret, tx, cy - hh, tx, cy + hh)
            cv.itemconfigure(caret, state="normal")
        else:
            self._field_caret_id = cv.create_line(tx, cy - hh, tx, cy + hh,
                                                  fill=TEXT, width=max(1, int(self.s)), tags="field")

    def _caret_blink(self):
        self._caret_on = not getattr(self, "_caret_on", True)
        try:
            self._sync_field_text()
            self._caret_job = self.root.after(520, self._caret_blink)
        except Exception:
            self._caret_job = None

    def _text_w(self, text, size):
        """量一段文字的像素宽（用来定按钮宽度 —— 估系数会把"发送"挤成 0 宽）"""
        try:
            from tkinter import font as tkfont
            return tkfont.Font(family=self.family,
                               size=max(7, int(size * self.s))).measure(text)
        except Exception:
            return int(len(text) * 11 * self.s)

    def _composer_paint(self, bot):
        """摆输入栏的三样东西，并把片的高度回填给 `_layout`。"""
        cv = self.canvas
        cv.delete("composer-art")
        s = self.s
        x1, y1, x2, y2 = bot
        inset = int(11 * s)
        h = int(36 * s)
        self._bot_slab_h = h + 2 * inset
        yc = (y1 + y2) / 2.0
        ty = yc - h / 2.0

        # 麦：圆角方钮（半径 11 —— 苹果那种"圆角方"比正圆更轻）
        mx1 = x1 + inset
        self.mic_btn.layout((mx1, ty, mx1 + h, ty + h), radius=min(int(11 * s), h / 2))

        # 发送：强调胶囊，宽度按文字实测
        sw = self._text_w("发送", 9.5) + int(26 * s)
        sx2 = x2 - inset
        self.send_btn.layout((sx2 - sw, ty, sx2, ty + h), radius=h / 2.0)

        # 输入槽
        fx1 = mx1 + h + int(8 * s)
        fx2 = sx2 - sw - int(8 * s)
        if fx2 - fx1 < int(60 * s):
            fx2 = fx1 + int(60 * s)
        rect = (fx1, ty, fx2, ty + h)
        if rect != self._field_rect:
            self._field_rect = rect
            self._field_geo = None
        self._paint_field()

        cv.tag_raise("cmp")
        cv.tag_raise("sbar")

    def _paint_field(self, event=None, accent=None):
        """输入槽：**内凹**。上沿暗、下沿亮 —— 光从上面来，凹进去的东西上沿是背光的
        那道；反过来（上亮下暗）看着就变"凸起的按钮"。聚焦时整个槽换强调色描边。
        """
        cv = self.canvas
        rect = getattr(self, "_field_rect", None)
        if not rect:
            return
        if accent is not None:
            self._field_focus = bool(accent)
        if self._field_geo != rect or not self._field_ids:
            cv.delete("field")
            self._field_ids = {}
            x1, y1, x2, y2 = rect
            rr = (y2 - y1) / 2.0
            w1 = max(1, int(self.s))
            self._field_ids["body"] = round_rect(
                cv, x1, y1, x2, y2, rr, fill=FIELD_BG, outline="", tags="field")
            self._field_ids["rim"] = round_rect(
                cv, x1 + 0.5, y1 + 0.5, x2 - 0.5, y2 - 0.5, rr,
                fill="", outline="#232830", width=w1, tags="field")
            self._field_ids["hi"] = cv.create_line(
                x1 + rr * 0.8, y2 - 0.8, x2 - rr * 0.8, y2 - 0.8,
                fill="#262b33", width=w1, tags="field")
            self._field_geo = rect
            cv.tag_raise("field")
            cv.tag_raise("cmp")
            cv.tag_raise("sbar")
        rim = self._field_ids.get("rim")
        if rim is not None:
            cv.itemconfigure(rim, outline=ACCENT if self._field_focus else "#232830")
        # Entry 贴在槽里。
        # **宽度必须用画布窗口项的像素宽**（`itemconfigure(width=)`），不能靠
        # `Entry.configure(width=字符数)` 反推：字宽是估的，中文一多就撑出去，
        # 输入框会直接把胶囊和右边的"发送"一起盖掉（用户说的"输入框太长、捅破了"
        # 就是这个 —— 那个 Entry 当时有 629px 宽，比槽宽了 160px）。
        x1, y1, x2, y2 = rect
        # 内缩量必须**大于胶囊的圆角半径**（= 高度一半）：Entry 是方的，压进圆弧区
        # 就会有一块直角露在胶囊外面，看着就是"输入框没有圆角"。
        padx = int((y2 - y1) / 2.0 + 3 * self.s)
        # **Entry 移到画布外**：它只负责收键盘和 IME，画面上一个字都不该由它显示。
        # 原生 Entry 必须不透明，塞进玻璃里就是一块死黑方块（用户原话：
        # "把输入框这个黑色矩形直接删掉，让字直接出现在液态玻璃上"）。
        # **Entry 平时在画布外，聚焦时才贴进槽里**。
        # 以前它永远在 -4000,-4000：`offset` 在画布外的 canvas window 不会被 map，
        # 而未 map 的控件**拿不到键盘焦点** —— `focus_set()` 直接空转，
        # 于是"点输入框 → 聚焦 → 打字"这条链在第一步就断了（用户实报"点了都没反应"）。
        # 贴进来时它的 bg 和槽同色（FIELD_BG）、内缩量大于圆角半径，所以看不出是个原生控件。
        self._place_entry(bool(getattr(self, "_field_focus", False)))
        self._sync_field_text()

    def _place_entry(self, visible):
        """把 `Entry` 放进输入槽里（或挪回画布外）。

        **必须是"贴进去再聚焦"的顺序**：没 map 的窗口控件不接受焦点。
        """
        cv = self.canvas
        rect = getattr(self, "_field_rect", None)
        if not rect:
            return
        x1, y1, x2, y2 = rect
        padx = int((y2 - y1) / 2.0 + 3 * self.s)
        try:
            if visible:
                # **缩成 2×2 贴在槽里**：`Entry` 是原生控件，做不出圆角
                # （放大就是一个更宽的直角矩形，用户实报"蹦出一个直角矩形，太丑"）。
                # 但画布外的 `Entry` 不会被 map，未 map 就**拿不到键盘焦点** ——
                # 所以它必须"在可视区域内极小且同色"：只收键盘和 IME，
                # 字和光标全部由画布画。
                cv.coords(self._entry_item, x1 + padx, int((y1 + y2) / 2))
                cv.itemconfigure(self._entry_item, width=2, height=2)
                cv.tag_raise(self._entry_item)
            else:
                cv.coords(self._entry_item, -4000, -4000)
                cv.itemconfigure(self._entry_item, width=2, height=2)
        except Exception:
            pass

    def _on_entry_focus(self, on):
        """焦点进出：贴进/移出槽，并让 canvas 决定字由谁画。"""
        self._field_focus = bool(on)
        if not on:
            self._place_entry(False)
        self._paint_field(accent=on)
        self._sync_field_text()

    def _focus_entry(self):
        """把焦点交给输入框，但**不抢系统焦点**。

        以前用 `focus_force()`：窗口一开就把焦点从浏览器抢走 —— 用户正看着片，
        敲空格想暂停，结果字打进了聊天框。`focus_set()` 只在本窗口内部指定焦点：
        点一下窗口就能直接打字，不点就完全不影响他在浏览器里的操作。
        """
        # **这里绝不能 focus_force**：开窗就把焦点从浏览器抢走，用户正看片、
        # 敲空格想暂停，结果字打进了聊天框（踩过）。真正的聚焦发生在用户点窗口时
        # （`_drag_start`），那时才 place + force。
        try:
            self.entry.focus_set()
        except Exception:
            pass

    # ---- 语音输入 ----
    def toggle_mic(self):
        if self.mic_proc and self.mic_proc.poll() is None:
            self._stop_mic()
            return
        if not os.path.exists(MIC_SCRIPT):
            self._add_meta(f"找不到 {MIC_SCRIPT}")
            return
        py = asr_python()
        try:
            self.mic_proc = subprocess.Popen(
                [py, MIC_SCRIPT, "--engine", "local"],
                stdout=subprocess.DEVNULL,          # 识别结果走聊天流，这里不重复显示
                stderr=subprocess.PIPE,             # 状态/报错显示在窗口里
                text=True, encoding="utf-8", errors="replace",
                creationflags=0x08000000 if os.name == "nt" else 0,   # 别弹控制台
            )
        except Exception as exc:
            self._add_meta(f"起不来麦克风进程：{exc}")
            return
        self.mic_btn.set(text="●", bg="#7a2b2b", fg="#ffd9d9")
        self.dot_fg = DANGER
        self._hint_text = "录音中"
        self._header_paint(self._head_rect)
        threading.Thread(target=self._mic_log, args=(self.mic_proc,), daemon=True).start()

    def _stop_mic(self):
        p = self.mic_proc
        self.mic_proc = None
        if p and p.poll() is None:
            try:
                p.terminate()
            except Exception:
                pass
        self.mic_btn.set(text="麦", bg=None, fg=MUTED)
        self.dot_fg = ACCENT
        self._update_hint()

    def _mic_log(self, proc):
        """把 mic.py 的状态/报错搬进窗口；它一退出就把按钮复位"""
        try:
            for line in proc.stderr:
                line = (line or "").rstrip()
                if line:
                    self.root.after(0, lambda l=line: self._add_meta(l))
        except Exception:
            pass
        proc.wait()
        self.root.after(0, self._mic_exited)

    def _mic_exited(self):
        # 自己挂了（依赖缺失/设备被占）也要把按钮复位，别停在"录音中"
        if self.mic_proc is not None:
            self._stop_mic()

    # ---- 拖动 / 拉伸 ----
    def _force_foreground(self):
        """把窗口拉到前台。

        **override-redirect 窗口点一下不一定自己激活**（实测：点完
        `GetForegroundWindow` 还是 Chrome），于是 `focus_set()` 空转、字打不进去。

        这里**只用 `SetForegroundWindow`**，不碰 `AttachThreadInput`：
        后者要跨线程附加，参数类型一旦不对就是静默崩进程（实测过一次，日志里什么都没有）。
        调用发生在"用户点击"这一帧，属于用户输入触发，Windows 的前台锁一般会放行。
        """
        try:
            import ctypes
            u = ctypes.windll.user32
            u.SetForegroundWindow.argtypes = [ctypes.c_void_p]
            u.SetForegroundWindow.restype = ctypes.c_int
            u.SetFocus.argtypes = [ctypes.c_void_p]
            hwnd = ctypes.c_void_p(int(self._hwnd()))
            if u.GetForegroundWindow() != hwnd.value:
                u.SetForegroundWindow(hwnd)
            u.SetFocus(hwnd)
        except Exception:
            pass

    def _drag_start(self, event):
        # **点一下窗口就要能打字**。`Entry` 被挪到画布外（-4000,-4000）只收键盘和
        # IME，画面上根本点不到它 —— 所以焦点必须在这里交过去。以前只在开窗 220ms
        # 时 `focus_set()` 一次，之后焦点一旦被浏览器/别的窗口抢走，再点输入框就
        # 只是"拖窗"，一个字都打不进去（用户实报"点了都没反应"）。
        # 用 `focus_force`：用户主动点窗口，本来就该是"激活它"的语义。
        try:
            # **顺序不能反**：先把窗口拉到前台、再把 Entry 贴进槽（没 map 的控件
            # 不接受焦点），最后才 focus
            self._force_foreground()
            self._place_entry(True)
            self.root.focus_force()
            self.entry.focus_set()
            self._field_focus = True
            self._sync_field_text()
        except Exception:
            pass
        # 点在输入槽里就**只聚焦、不拖窗**：否则"想打字"和"想拖窗"抢同一个手势，
        # 手一抖窗口就跟着跑。
        fr = getattr(self, "_field_rect", None)
        if fr and fr[0] <= event.x <= fr[2] and fr[1] <= event.y <= fr[3]:
            self._drag = None
            return
        self._drag = (event.x_root - self.root.winfo_x(), event.y_root - self.root.winfo_y())

    def _drag_end(self, _event=None):
        """松手：结束拖动状态，并把"搬家后的收尾重绘"补上。"""
        if self._drag is None:
            return
        self._drag = None
        try:
            self._request_backdrop()
        except Exception:
            pass

    def _drag_move(self, event):
        if not self._drag:
            return
        dx, dy = self._drag
        self.x, self.y = event.x_root - dx, event.y_root - dy
        self.root.geometry(f"+{self.x}+{self.y}")
        # **拖动中就要刷新**：以前是"挪完停手 420ms 才重截"，所以拖动全程背后是冻结的，
        # 一松手还要卡一下、闪一下。现在只要窗口还在 stage（带留白的已糊底板）里，
        # 就当场裁一张新的贴上去 —— 不截屏、不隐藏窗口，约 15ms 一帧。
        # 事件比帧还密（鼠标 120Hz），按 30ms 节流，掉的那几帧由下一次 move 补上。
        now = time.time()
        if now - getattr(self, "_live_at", 0.0) >= 0.03 and self._live_backdrop():
            self._live_at = now
        else:
            self._request_backdrop()

    def _paint_glass_only(self):
        """**只换玻璃**：拖动时每帧走这里 —— 标题、气泡、输入栏原地不动。

        整窗 `_paint` 会重画所有元素（标题文字、按钮、每条气泡），那些东西相对窗口
        根本没动，在拖动时重画纯属浪费（一帧多 20ms）。这里只换底板图和两块悬浮片。
        """
        cv = self.canvas
        w, h = self.root.winfo_width(), self.root.winfo_height()
        if w < 4 or h < 4:
            return
        if self.acrylic:
            return                      # 磨砂模式不需要重画玻璃
        self._ensure_blurred(w, h)
        top, body, bot = self._layout(w, h)
        photo = self._panel_photo(w, h, body)
        if photo is None:
            return
        self._backdrop_photo = photo
        # **复用同一个 item**：`delete("panel")` + `create_image` 每帧中间有一帧没底板，
        # 拖动时 60Hz 就是"一路闪"。`itemconfigure(image=)` 是原子的，成本一样。
        item = getattr(self, "_panel_item", None)
        if item is not None and cv.type(item) == "image":
            cv.itemconfigure(item, image=photo)
        else:
            self._panel_item = cv.create_image(0, 0, image=photo, anchor="nw",
                                               tags=("panel", "backdrop"))
            cv.tag_lower("panel")
        # **拖动过程中不动两块悬浮片**：它们只占角落，位置每帧只挪几像素，肉眼看不出来，
        # 但重烘两块 slab 要 6ms/帧 —— 60Hz 下就是 36% 的占用。
        if not getattr(self, "_drag", None):
            self._slab_paint(top, bot)
            for tag in ("slab", "field", "hdr", "cmp", "sbar"):
                cv.tag_raise(tag)

    def _live_backdrop(self):
        """拖动/缩放过程中的"够快"刷新：stage 命中就不截屏、不隐身、不闪。"""
        if not HAVE_PIL or not self.rounded:
            return False
        # **不能用 `_window_rect()`**：它内部 `update_idletasks()` 会顺手把一次
        # Configure 处理掉，于是每帧在"换玻璃"之外又白跑一遍整窗重绘（实测 +17ms）。
        k = self._dpi_k()
        rect = (int(self.x * k), int(self.y * k), int(self.w * k), int(self.h * k))
        if not self._shot_usable(*rect):
            return False
        try:
            self._grab_backdrop()      # 只是从 stage 里裁一块 + 放大
            self._paint_glass_only()
        except Exception:
            return False
        return True

    def _resize_start(self, event):
        self._resize = (event.x_root, event.y_root, self.w, self.h)

    def _resize_move(self, event):
        if not self._resize:
            return
        x0, y0, w0, h0 = self._resize
        self.w = max(int(MIN_W * self.s), w0 + (event.x_root - x0))
        # 拖拽也守同一个下限：以前允许拖到 220*s，比三块固定栏加起来还矮
        self.h = max(self._min_h(), h0 + (event.y_root - y0))
        self.root.geometry(f"{self.w}x{self.h}+{self.x}+{self.y}")
        self._resizing = True        # 期间走"缩放旧玻璃"的快路，不重烘
        try:
            if getattr(self, "_resize_job", None):
                self.root.after_cancel(self._resize_job)
        except Exception:
            pass
        self._resize_job = self.root.after(300, self._resize_done)
        self._request_backdrop()

    def _resize_done(self):
        self._resize_job = None
        self._resizing = False
        self._chat_v += 1          # 尺寸变了，气泡玻璃必须重烘
        self._request_backdrop()

    # ---- 交互 ----
    def toggle_collapse(self):
        """折叠：只留标题栏那一条。消息和输入栏用 `itemconfigure(state)` 藏起来 ——
        它们现在是 canvas 上的 item / window，不能再用 pack_forget。"""
        self._drag = None        # 手势可能还没松手就换尺寸，别让早退条件卡住重绘
        self._collapsed = not getattr(self, "_collapsed", False)
        if self._collapsed:
            self._saved_h = self.h
            self.h = 2 * self.out + int(46 * self.s)     # 正好只剩标题栏那片玻璃
        else:
            self.h = getattr(self, "_saved_h", None) or int(540 * self.s)
        self.root.geometry(f"{self.w}x{self.h}+{self.x}+{self.y}")
        self._apply_collapsed()
        # 折叠/展开是"整窗换尺寸"，任何一档缓存的尺寸都对不上 —— 全部作废重来，
        # 否则会留下一张按旧高度裁出来的片（2px 高的气泡、消失的标题栏）。
        self._blurred = None
        self._plates.clear()
        self._plate_imgs.clear()
        self._last_plate_imgs.clear()
        self._last_panel = None
        self._chat_v += 1
        try:
            # 等窗口真的换成新尺寸（configure 一到就重画），再补一发保险
            self.root.after(16, self._paint)
            self.root.after(40, self._refresh_backdrop)
        except Exception:
            pass

    def _apply_collapsed(self):
        """折叠 = 只留标题栏。消息和输入栏整组藏起来（它们都是画布元素，按 tag 藏）"""
        state = "hidden" if getattr(self, "_collapsed", False) else "normal"
        for tag in ("cmp", "field", "sbar"):
            try:
                self.canvas.itemconfigure(tag, state=state)
            except Exception:
                pass
        for it in self._items:
            try:
                self.canvas.itemconfigure(it.tag, state=state)
            except Exception:
                pass

    def body_visible(self):
        return not getattr(self, "_collapsed", False)

    def close(self):
        self._glass_stop = True
        try:
            if getattr(self, "_glass_job", None):
                self.root.after_cancel(self._glass_job)
                self._glass_job = None
        except Exception:
            pass
        self._stop_mic()      # 窗口关了就别留个录音进程在后台
        write_config({"geometry": f"{self.w}x{self.h}+{self.x}+{self.y}"})
        self.root.destroy()

    def _send(self, _event=None):
        text = self.entry.get().strip()
        if not text:
            return "break"
        self.entry.delete(0, "end")
        self._sync_field_text()
        try:
            append_user(text)
        except Exception as exc:
            self._add_meta(f"写不进去：{exc}")
            return "break"
        self.poll()      # 立刻回显，不等下一拍
        # 发完继续打字：点"发送"按钮进来的时候焦点不在 Entry 上
        try:
            self.entry.focus_set()
        except Exception:
            pass
        return "break"

    def _render(self, entry):
        """一条 jsonl → 一个玻璃片。**新消息和历史回放走同一条路**，样式才不会两套。

        `t`（播放位置）和 `at`（墙钟）都可能缺，缺了就留空 —— 不猜、不补 0
        （`Number(null) === 0` 这个坑在 JS 那边踩过两次）。
        """
        role = entry.get("role")
        text = str(entry.get("text") or "")
        # **系统行（`meta`）走灰字，不做气泡**：它们是"叫醒失败""麦克风已开"这类诊断，
        # 以前没分派，落到下面的 fallback 变成一块和正文一样大的气泡 —— 一屏全是
        # `[一起看] 叫醒失败` 的方框，抢的就是台词的视线。
        if role == "meta":
            self._add_meta(text)
            return
        if role not in ROLE:
            role = "assistant"
        # **统一显示本机时间**（2026-11-01 用户要求）：以前台词显示的是播放位置
        # （`01:26.0`），别的显示墙钟，一条流里两种时间轴，读起来要先换算一次。
        # 现在一律用 `at`（消息写进流的时刻）；没有 `at` 就留空，不拿 `t` 顶替 ——
        # 那会把"视频第几秒"冒充成"几点几分"，比空着更误导。
        stamp = clock(entry.get("at")) if entry.get("at") is not None else ""
        self._add_bubble(role, text, stamp)

    # ---- 读盘（增量）----
    def _reset_cursor(self):
        """开场：回放最后 60 条（有上下文，又不会被几千条历史淹掉）"""
        try:
            size = os.path.getsize(CHAT_FILE)
        except OSError:
            size = 0
        self._offset = size
        self._carry = ""
        self.seen = 0
        if size == 0:
            self._show_empty()
            return
        try:
            with open(CHAT_FILE, "rb") as f:
                f.seek(max(0, size - 96 * 1024))
                chunk = f.read()
        except OSError:
            self._show_empty()
            return
        lines = [l for l in chunk.decode("utf-8", "replace").split("\n") if l.strip()]
        if size > 96 * 1024 and lines:
            lines = lines[1:]          # 从文件中间开始读，第一行可能是半行
        for line in lines[-60:]:
            try:
                self._render(json.loads(line))
            except Exception:
                continue
            self.seen += 1
        if self.seen == 0:
            self._show_empty()

    def _drain(self):
        """只读上次之后新追加的字节 —— 和 src/chat-store.js 的 watcher 同一套思路"""
        try:
            size = os.path.getsize(CHAT_FILE)
        except OSError:
            return []
        if size < self._offset:            # 文件被清空/重建
            for row in self.rows:
                try:
                    row.row.destroy()
                except Exception:
                    pass
            self.rows.clear()
            self.empty = None
            self._offset, self._carry, self.seen = 0, "", 0
            self._show_empty()
        if size == self._offset:
            return []
        try:
            with open(CHAT_FILE, "rb") as f:
                f.seek(self._offset)
                chunk = f.read(size - self._offset)
        except OSError:
            return []
        self._offset = size
        text = self._carry + chunk.decode("utf-8", "replace")
        parts = text.split("\n")
        self._carry = parts.pop()          # 末尾可能是半行，留到下一拍
        out = []
        for line in parts:
            if not line.strip():
                continue
            try:
                out.append(json.loads(line))
            except Exception:
                continue
        return out

    def _update_hint(self):
        """标题栏那点小字只留"录音中" —— 条数已经单独显示在名字右边了，
        以前一条是"5 条"、另一条是"已连上"，两个位置各说一半，读起来像仪表盘。"""
        hint = "录音中" if (self.mic_proc and self.mic_proc.poll() is None) else ""
        if hint == getattr(self, "_hint_text", None):
            return
        self._hint_text = hint
        try:
            self._header_paint(self._head_rect)
        except Exception:
            pass

    def _sync_visible(self):
        """跟随配置里的 `hidden`：插件写 true 就藏起来（进程还活着，照样收话、照样念），写 false 就回来。

        为什么要"藏"而不是"关"：关窗在陪看里等于"不看了"（会停表、落挂断记录）。
        用户想的是**这一次别挡着画面**，陪看继续 —— 那是两件事。
        用 withdraw 而不是 iconify：图标化的窗口还会占任务栏/出现在 Alt+Tab 里，
        而这是置顶悬浮窗，藏起来就该完全看不见。
        """
        want = bool(read_config().get("hidden"))
        if want == self.hidden:
            return
        self.hidden = want
        try:
            if want:
                # **藏起来的时候顺手重截底板**：此刻窗口本来就不可见，重截零成本，
                # 等用户再放出来时玻璃就是新的。这样常驻时不闪也能保持新鲜。
                try:
                    self.root.withdraw()
                    self.root.update_idletasks()
                    self._stage_cache = None
                    self._grab_backdrop((self.w, self.h), force_stage=True)
                    self._paint()
                except Exception:
                    pass
                self.root.withdraw()
            else:
                self.root.deiconify()
                self.root.attributes("-topmost", True)
        except Exception:
            self.hidden = not want       # 没成功就别记成已切换，下一拍再试

    def poll(self):
        try:
            self._sync_visible()
            for e in self._drain():
                self._render(e)
                self.seen += 1
            self._update_hint()
        except Exception:
            pass
        # 200ms 而不是 400ms：台词是在**声音真的出来那一刻**才写盘的（见 src/chat-store.js），
        # 轮询间隔就是"字比声音晚多少"的直接来源 —— 50~400ms 的滞后会被听成"不同步"。
        self.root.after(200, self.poll)
        # **只启一次**：`poll()` 每 200ms 自己再排一次，放在这里却不加锁的话，
        # 每拍都会重启一条定时链 —— 实测 3.2 秒触发 16 次、截屏频率飙到 9Hz。
        if not getattr(self, "_glass_started", False):
            self._glass_started = True
            self._glass_ttl_start()
        if not getattr(self, "_caret_started", False):
            self._caret_started = True
            self.root.after(520, self._caret_blink)

    # ---- 玻璃底色跟着背景走 ----
    #
    # 以前整屏截图**只在开窗时发生一次**（`_stage` 的注释还写着"之后无论拖到哪儿都是裁一刀"），
    # 于是对面视频换了场景、桌面换了壁纸，这块玻璃还是开窗那一刻的颜色 ——
    # 用户原话："背景换了，液态玻璃还没动，还没变颜色"。拖动结束后那 8 秒的判定也救不了静止的窗口。
    #
    # 现在按 TTL 定时重截：**截屏在子线程**（ImageGrab + 缩放 + 模糊，约 150~200ms），
    # 主线程只做裁片 + 贴图（1~2ms）。Tk 的对象一个都不许在子线程碰 —— 屏幕尺寸、缩放系数
    # 都在主线程读好再传进去。

    def _glass_ttl(self):
        try:
            return int(float(os.environ.get("DSH_WATCH_GLASS_TTL") or 60))
        except Exception:
            return 60

    def _glass_ttl_start(self):
        self._glass_job = None
        self._glass_busy = False
        self._glass_q = queue.Queue(maxsize=1)
        self._glass_stop = False
        self._glass_rect = self._win_phys(200)
        if self.acrylic:
            return                      # 磨砂模式：完全交给 GPU，一次屏都不截
        if self._glass_ttl() <= 0:
            return                      # 0 = 关掉，回到"开窗截一次"的旧行为
        try:
            threading.Thread(target=self._glass_worker, daemon=True).start()
        except Exception:
            pass
        try:
            self._glass_job = self.root.after(self._glass_ttl(), self._glass_tick)
        except Exception:
            self._glass_job = None

    def _glass_tick(self):
        """**主线程**：每 4ms 取一次最新帧。仿 PR #15 的架构 —— 后台不停地产，
        这里只负责"有就上"，而不是"等够了 60ms 才去要一张"。

        原来那套是定时器驱动的：`after(TTL)` → 起线程 → 回来 → 再排下一拍。
        一轮 32ms、TTL 60ms，等于每 92ms 才换一张脸（约 11Hz），而且有一半时间在空等。
        现在后台按目标帧率连续产出，主线程一有队列内容就贴，帧率由"一轮多久"决定。
        """
        self._glass_job = None
        if self._glass_ttl() <= 0:
            return
        try:
            self._glass_job = self.root.after(4, self._glass_tick)
        except Exception:
            self._glass_job = None
        # 窗口可能刚被拖过：矩形在这里（主线程）刷新，子线程只读
        try:
            self._glass_rect = self._win_phys(200)
        except Exception:
            pass
        q = getattr(self, "_glass_q", None)
        if q is None:
            return
        staged = None
        try:
            staged = q.get_nowait()
        except queue.Empty:
            return
        if staged is not None:
            self._glass_apply(staged)

    def _glass_worker(self):
        """**常驻子线程**：按目标帧率连续抓 + 算，结果丢进只有 1 个位置的队列。

        队列 maxsize=1：算得比主线程贴得快时，**旧的直接扔掉**（观众只关心最新的一帧）。
        """
        target_fps = max(10, min(60, int(1000 / max(8, self._glass_ttl()) * 4)))
        try:
            target_fps = int(os.environ.get("DSH_WATCH_GLASS_FPS") or 30)
        except Exception:
            target_fps = 30
        while not getattr(self, "_glass_stop", False):
            t0 = time.time()
            if getattr(self, "hidden", False) or getattr(self, "_collapsed", False):
                time.sleep(0.1)          # 看不见就别耗 CPU
                continue
            try:
                rect = self._glass_rect        # 主线程每拍更新
                sx, sy, sw, sh = rect
                staged = self._glass_capture(sx, sy, sw, sh, self.s)
            except Exception:
                staged = None
            if staged is not None:
                q = self._glass_q
                try:
                    q.get_nowait()       # 丢掉没被取走的旧帧
                except queue.Empty:
                    pass
                try:
                    q.put_nowait(staged)
                except Exception:
                    pass
            dt = time.time() - t0
            time.sleep(max(0.0, 1.0 / target_fps - dt))

    def _glass_capture(self, sx, sy, sw, sh, s_scale):
        """**子线程**：只做 PIL（截屏 → 1/8 → 模糊 → 色散 → 提饱和），**不碰 Tk**。"""
        staged = None
        try:
            # **优先 mss**：同样是整屏，它 38ms、ImageGrab 71ms（本机实测），
            # 而且它给的是物理分辨率（2560×1600），`_grab_backdrop` 用
            # `small.size / (sw, sh)` 算比例，1.5 倍的 DPI 自动被吸收。
            shot = None
            if HAVE_MSS:
                try:
                    # mss 10 起把 `mss.mss` 标成 deprecated，改叫 `MSS`；两个都认
                    factory = getattr(_mss, "MSS", None) or getattr(_mss, "mss")
                    with factory() as grabber:
                        raw = grabber.grab({"left": sx, "top": sy, "width": sw, "height": sh})
                    shot = Image.frombytes("RGB", raw.size, raw.bgra, "raw", "BGRX")
                except Exception:
                    shot = None
            if shot is None:
                k = self._dpi_k()
                shot = ImageGrab.grab(bbox=(sx / k, sy / k, (sx + sw) / k, (sy + sh) / k),
                                     all_screens=True)
            # ---- 静态跳帧（取自 PR #15 的策略，数字照抄）----
            # 先用**没糊过的 raw** 判断有没有动：缩小到 48x30 比一次就够。
            # 背景静止时整条管线（抓屏 17ms + 糊 + 色散 + 折射）全都不用跑；
            # 阈值 mean>0.8/255 比"时间到了就重算"灵敏，慢速滚动不会先停一两帧。
            now_s = time.time()
            try:
                sig = shot.resize((48, 30), Image.BILINEAR).convert("L")
                prev = getattr(self, "_glass_sig", None)
                same_box = getattr(self, "_glass_sig_box", None) == (sx, sy, sw, sh)
                if prev is not None and same_box and prev.size == sig.size:
                    if ImageStat.Stat(ImageChops.difference(prev, sig)).mean[0] > 0.8:
                        self._glass_motion_at = now_s
                    elif now_s - getattr(self, "_glass_motion_at", 0.0) > 0.30:
                        self._glass_sig = sig
                        cached = getattr(self, "_glass_stage", None)
                        if cached is not None:
                            return cached      # 没动：原样复用上一帧，一个像素都不算
                else:
                    self._glass_motion_at = now_s
                self._glass_sig = sig
                self._glass_sig_box = (sx, sy, sw, sh)
            except Exception:
                pass
            small = build_stage(shot, sw, sh, s_scale)
            staged = (small, (sx, sy, sw, sh), time.time())
            self._glass_stage = staged
        except Exception:
            staged = None
        return staged

    # 相邻两帧底板的平均色差低于这个值就认为"背景没动"，跳过重烘。
    # 静止画面下每拍省掉主线程 26ms（重裁 6 + 烘焙 14 + 标题槽 6），也不闪。
    GLASS_EPS = 0.6   # 0.25% 的平均色差就算"变了" —— 太保守会让慢摇镜头被跳过

    def _glass_apply(self, staged):
        """**主线程**：换 stage → 重裁 → 只重画玻璃层。"""
        self._glass_busy = False
        if staged is None or not self.glass_ready():
            return
        prev = getattr(self, "_stage_cache", None)
        if prev is not None:
            try:
                # 只比 1/4 分辨率的 stage（640×400），5ms 以内
                a = ImageStat.Stat(staged[0]).mean
                b = ImageStat.Stat(prev[0]).mean
                if sum(abs(x - y) for x, y in zip(a, b)) < self.GLASS_EPS:
                    return                      # 背景没变：不换图、不重烘
            except Exception:
                pass
        self._stage_cache = staged
        self._blurred = None            # 逼 _grab_backdrop 重新裁一刀
        self._glass_v += 1              # 面板/悬浮条的缓存键里带它，作废
        try:
            size = getattr(self, "_painted_size", None) or (self.w, self.h)
            self._grab_backdrop(size)
            self._repaint_glass()
        except Exception:
            pass


if __name__ == "__main__":
    if not os.path.exists(CHAT_FILE):
        os.makedirs(os.path.dirname(CHAT_FILE), exist_ok=True)
    FloatChat().root.mainloop()
