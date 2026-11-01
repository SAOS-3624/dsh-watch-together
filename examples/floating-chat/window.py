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

# ---------------------------------------------------------------- 配色
#
# ## 2026-11-01：液态玻璃（Apple Liquid Glass）
#
# 用户要的是"抄苹果的液态玻璃还有圆角"，同时"台词和陪看不区分、颜色统一"。
#
# 三个视觉支柱（tkinter 没有真模糊，靠这三样做出通透感）：
#   ① **大圆角**（22px）+ 外描边分上下两色（上亮下暗 = 光从上面来）；
#   ② **内侧顶部高光**：贴着圆角走一条 1px 亮线，这是玻璃"边缘折光"的来源；
#   ③ **外圈竖向渐变**：只在 22px 的玻璃边上可见，顶部偏亮、底部偏暗；中间被内容层
#      盖住，所以只画看得见的部分。不是"内部渐变" —— tkinter 的 Frame 没有透明背景。
#
# 气泡改成"玻璃片"：比底板稍亮 + 1px 描边 + 更大圆角，**不再用竖线区分台词**。
# 台词和陪看现在共用同一套颜色（`ROLE` 里两者完全一致），抬头只留时间。

BG = GLASS_FILL = "#121722"   # 面板 = 玻璃主体（子控件也用它，才不会被挡出"色块"）
BORDER = "#2a3446"            # 面板描边 / 分隔线
TEXT = "#eef3fb"
MUTED = "#929eb4"
DIM = "#65728a"
ACCENT = "#5b9cff"
DANGER = "#e06a62"
KEY = "#010203"           # 圆角抠图用的透明键色（只给根窗口和画布用）

# 玻璃层的颜色（自上而下）
#
# **标题栏不单独上色**：它是矩形控件，一旦比底板亮就会在左上/右上圆角内侧露出直角块，
# 反而破坏"一整块玻璃"的观感。受光感交给 `GLASS_HILITE` 那一条折光边，更干净。
HEAD_BG = GLASS_FILL        # = 主体色（保持同一块玻璃）
GLASS_TOP = "#303b50"      # 顶部渐变起点（受光）
GLASS_BOTTOM = "#090c12"   # 底部渐变终点（背光）
GLASS_HILITE = "#dce8ff"   # 内侧顶部高光（1px）—— 这是"折光边"，要能被看见
GLASS_EDGE_HI = "#7183a5"  # 外描边上半（受光）
GLASS_EDGE_LO = "#04060a"  # 外描边下半（背光）

BUBBLE_FILL = "#242e40"    # 玻璃片气泡：比底板亮一档，才像"浮在上面"
BUBBLE_FILL_ME = "#1e456b" # 我说的（自己那侧保留一点蓝，便于对位）


FIELD_BG = "#1a2130"       # 输入框胶囊底色（比气泡暗、比底板亮）
HOVER_BG = "#2b3547"       # 按钮悬停

# 角色 → (气泡底色, 文字色, 竖线色 或 None, 抬头)
#
# **`line` 和 `assistant` 必须完全相同**（2026-11-01 用户要求）：以前台词是暖黄、陪看是冷灰，
# 一条流里两种配色，读起来像两个人在说话。现在只有"它说的"和"我说的"两种。
ROLE = {
    "line": (BUBBLE_FILL, TEXT, None, ""),
    "assistant": (BUBBLE_FILL, TEXT, None, ""),
    "user": (BUBBLE_FILL_ME, "#cfe4ff", None, ""),
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


def round_rect(cv, x1, y1, x2, y2, r, **kw):
    """Canvas 画圆角矩形。

    **不用 `smooth=True` 的多边形**：smooth 是把折线的角"抹圆"，实际半径明显小于设定值
    （要 22 出来只有 14），做液态玻璃时圆角是主角，量不准就全歪。这里直接按四个角
    采样圆弧（每角 6 段），`smooth=False` 拼接 —— 半径是多少就是多少。
    """
    r = max(0, min(r, (x2 - x1) / 2, (y2 - y1) / 2))
    if r <= 0.5:
        return cv.create_rectangle(x1, y1, x2, y2, **kw)
    pts = []
    # 顺时针：右上 → 右下 → 左下 → 左上，起点角度依次 -90 / 0 / 90 / 180
    for cx, cy, a0 in ((x2 - r, y1 + r, -90), (x2 - r, y2 - r, 0),
                       (x1 + r, y2 - r, 90), (x1 + r, y1 + r, 180)):
        for i in range(7):
            a = math.radians(a0 + i * 15)
            pts.extend([cx + r * math.cos(a), cy + r * math.sin(a)])
    return cv.create_polygon(pts, smooth=False, **kw)


def _mix(c1, c2, t):
    """两个 #rrggbb 之间取 t（0→c1，1→c2）。用来做渐变和高光。"""
    t = 0.0 if t < 0 else (1.0 if t > 1 else t)
    a = [int(c1[i:i + 2], 16) for i in (1, 3, 5)]
    b = [int(c2[i:i + 2], 16) for i in (1, 3, 5)]
    return "#%02x%02x%02x" % tuple(int(round(a[k] + (b[k] - a[k]) * t)) for k in range(3))


def _rim_span(y, w, h, r):
    """在圆角矩形里，高度 y 处的可见横向范围（用于把渐变裁进圆角）。"""
    if y < r:
        dy = r - y
    elif y > h - r:
        dy = y - (h - r)
    else:
        return 0.0, float(w)
    dx = r - math.sqrt(max(0.0, r * r - dy * dy))
    return dx, w - dx


def glass_panel(cv, w, h, r, s=1.0, tag="panel"):
    """画一块**液态玻璃**底板：渐变厚边 + 双层高光 + 内外分色描边。

    真正的 Apple Liquid Glass 靠背景模糊；tkinter 的子控件是不透明的 Frame，
    **没有真模糊可做**。这里把"玻璃"拆成看得见的四层：
      ① 只在圆角边上可见的竖向渐变（中间被 shell 盖住，不浪费像素）；
      ② 顶部一条宽而柔的高光 + 左上一小段更亮的镜面反射；
      ③ 内圈亮、外圈暗的双层描边，制造玻璃厚度；
      ④ 底部一条冷色反光，和顶部暖色高光形成上下受光差。

    拖动 resize 时由 `_paint` 合并到 16ms 一帧，渐变按 3~4px 一条带子画，
    所以"更玻璃"不会变成"更卡"。
    """
    # ① 主体 + 圆角轮廓
    round_rect(cv, 0, 0, w, h, r, fill=GLASS_FILL, outline="", tags=(tag, f"{tag}-body"))

    # ② 上下两条"斜边渐变"：只画在圆角弧内，横向渐变到主体色。
    #    中间侧边由内容层盖住，不画；整块玻璃因此只多约 2×r/step 条线。
    step = max(2.0, 3.2 * s)
    y = 0.0
    while y < r:
        cy = min(r - 0.5, y + step / 2.0)
        x0, x1 = _rim_span(cy, w, h, r)
        if x1 - x0 > 0.5:
            cv.create_line(x0, cy, x1, cy,
                           fill=_mix(GLASS_TOP, GLASS_FILL, cy / float(max(1.0, r))),
                           width=max(1, int(step + 1)), tags=(tag, f"{tag}-rim"))
        y += step
    y = max(0.0, h - r)
    while y < h:
        cy = min(h - 0.5, y + step / 2.0)
        x0, x1 = _rim_span(cy, w, h, r)
        if x1 - x0 > 0.5:
            cv.create_line(x0, cy, x1, cy,
                           fill=_mix(GLASS_FILL, GLASS_BOTTOM,
                                     (cy - (h - r)) / float(max(1.0, r))),
                           width=max(1, int(step + 1)), tags=(tag, f"{tag}-rim"))
        y += step

    # ②b 左右侧边：中间段内容层虽然盖住，但 22px 的玻璃边还露着。
    #     左侧受光、右侧背光；只在上下圆角之间画，避免在圆角外露出竖条。
    side_step = max(2.0, 3.0 * s)
    x = 0.0
    while x < r:
        t = x / float(max(1.0, r))
        cv.create_line(x + side_step / 2.0, r, x + side_step / 2.0, h - r,
                       fill=_mix(GLASS_FILL, GLASS_TOP, (1.0 - t) * 0.55),
                       width=max(1, int(side_step + 1)), tags=(tag, f"{tag}-rim"))
        x += side_step
    x = w - r
    while x < w:
        t = (w - x) / float(max(1.0, r))
        cv.create_line(x + side_step / 2.0, r, x + side_step / 2.0, h - r,
                       fill=_mix(GLASS_FILL, "#000000", (1.0 - t) * 0.35),
                       width=max(1, int(side_step + 1)), tags=(tag, f"{tag}-rim"))
        x += side_step

    # ③ 内圈高光 / 外圈受光边：两条线的亮度不同，厚度才出得来
    hi = max(1, int(round(s)))
    cv.create_line(r * 0.55, 1.0 * s, w - r * 0.55, 1.0 * s,
                   fill=GLASS_HILITE, width=hi, tags=(tag, f"{tag}-hilite"))
    cv.create_line(r * 0.55, 2.0 * s, w - r * 0.55, 2.0 * s,
                   fill=_mix(GLASS_TOP, "#ffffff", 0.24), width=1,
                   tags=(tag, f"{tag}-hilite"))

    # 左上镜面反射：更短、更亮；右侧只留一段冷色余晖，避免整条边一样亮
    cv.create_line(r * 1.05, 2.6 * s, w * 0.46, 2.6 * s,
                   fill="#f2f7ff", width=max(1, int(round(1.4 * s))),
                   tags=(tag, f"{tag}-specular"))
    cv.create_line(w * 0.60, 2.1 * s, w - r * 0.9, 2.1 * s,
                   fill="#a9bad9", width=1, tags=(tag, f"{tag}-specular"))

    # ④ 底部冷色反光 + 内圈暗边，像玻璃片压在桌面上
    cv.create_line(r * 0.7, h - 2.0 * s, w - r * 0.7, h - 2.0 * s,
                   fill="#22324a", width=1, tags=(tag, f"{tag}-glow"))
    cv.create_line(1.6 * s, r * 0.8, 1.6 * s, h - r * 0.8,
                   fill=_mix(GLASS_FILL, "#ffffff", 0.10), width=1,
                   tags=(tag, f"{tag}-inner"))
    cv.create_line(w - 1.6 * s, r * 0.8, w - 1.6 * s, h - r * 0.8,
                   fill=_mix(GLASS_FILL, "#000000", 0.42), width=1,
                   tags=(tag, f"{tag}-inner"))

    # ⑤ 外描边：上半受光、下半背光；左右同理
    cv.create_line(r * 0.7, 0.5, w - r * 0.7, 0.5,
                   fill=GLASS_EDGE_HI, width=hi, tags=(tag, f"{tag}-edge"))
    cv.create_line(r * 0.7, h - 0.5, w - r * 0.7, h - 0.5,
                   fill=GLASS_EDGE_LO, width=hi, tags=(tag, f"{tag}-edge"))
    cv.create_line(0.5, r * 0.7, 0.5, h - r * 0.7,
                   fill=GLASS_EDGE_HI, width=hi, tags=(tag, f"{tag}-edge"))
    cv.create_line(w - 0.5, r * 0.7, w - 0.5, h - r * 0.7,
                   fill=GLASS_EDGE_LO, width=hi, tags=(tag, f"{tag}-edge"))


class Opt:
    """一组排版参数（已按 DPI 缩放），气泡和窗口共用"""

    def __init__(self, s, avail, family):
        self.s = s
        self.avail = avail
        self.radius = int(12 * s)
        self.padx = int(13 * s)
        self.pady = int(9 * s)
        self.gap = int(12 * s)
        self.font = (family, max(8, int(10.5 * s)))
        self.font_small = (family, max(7, int(8 * s)))


class Bubble:
    """一条消息 = 一行时间 + 一块玻璃片。

    为什么不用 Text 拼：Text 的 tag 背景是**整行宽**的方块，右对齐时会变成一条色带。
    这里每条消息是独立的小画布，气泡宽度贴着内容。

    2026-11-01：抬头**不再写"台词"/"陪看"** —— 一条流里两种称呼、两种配色，读起来像两个人
    在对话。现在只有时间，颜色全部统一（`ROLE` 里 `line` 与 `assistant` 完全相同）。
    """

    def __init__(self, feed, role, text, stamp, opt):
        self.role = role
        self.opt = opt
        fill, fg, bar, who = ROLE.get(role, ROLE["assistant"])
        self.fill = fill
        self.bar = bar
        right = role == "user"

        self.row = tk.Frame(feed, bg=BG)
        self.row.pack(fill="x", pady=(opt.gap, 0))

        head = " ".join(x for x in (who, stamp) if x)
        self.head = tk.Label(self.row, text=head, bg=BG, fg=DIM, font=opt.font_small,
                             anchor="e" if right else "w")
        # **没有时间戳就别 pack**：老消息可能没有 `at`，空 Label 仍会占掉一行字体高度，
        # 一条流里夹几个空行看起来像排版坏了。
        if head:
            self.head.pack(anchor="e" if right else "w",
                           padx=(0, 3 * opt.s) if right else (3 * opt.s, 0))

        self.cv = tk.Canvas(self.row, bg=BG, highlightthickness=0, bd=0)
        self.cv.pack(anchor="e" if right else "w")
        self.lbl = tk.Label(self.cv, text=text, bg=fill, fg=fg, font=opt.font,
                            justify="left", anchor="w", wraplength=int(220 * opt.s))
        self.cv.create_window(opt.padx, opt.pady, window=self.lbl, anchor="nw")
        self.layout(opt.avail)

    def layout(self, avail):
        """按可用宽度重新折行并重画底板（窗口拉伸/缩放时调用）。

        **宽度没变就直接返回**：追加消息不再触发全量 reflow，只有真的 resize 才走这里。
        """
        avail = int(avail)
        if getattr(self, "_avail", None) == avail and self.cv.winfo_width() > 1:
            return
        self._avail = avail
        opt = self.opt
        limit = max(int(120 * opt.s), int(avail * 0.86) - 2 * opt.padx)
        self.lbl.configure(wraplength=limit)
        self.lbl.update_idletasks()
        w = min(limit, max(1, self.lbl.winfo_reqwidth())) + 2 * opt.padx
        h = max(1, self.lbl.winfo_reqheight()) + 2 * opt.pady
        self.cv.configure(width=w, height=h)
        self.cv.delete("bg", "bar", "edge", "sheen")
        r = min(int(opt.radius * 1.55), max(1, int((h - 1) / 2)))
        round_rect(self.cv, 0.5, 0.5, w - 0.5, h - 0.5, r,
                   fill=self.fill, outline="", tags="bg")

        # 玻璃片边缘：外圈上亮下暗，内圈再压一条更细的 sheen。
        # Label 盖住中间，只有 9px padding 露出来 —— 这两条就够了，画满渐变反而会被遮住。
        self.cv.create_line(r * 0.55, 0.8, w - r * 0.55, 0.8,
                            fill=_mix(self.fill, "#ffffff", 0.20),
                            width=max(1, int(round(opt.s))), tags="edge")
        self.cv.create_line(r * 0.55, 2.1 * opt.s, w - r * 0.55, 2.1 * opt.s,
                            fill=_mix(self.fill, "#ffffff", 0.10),
                            width=1, tags=("edge", "sheen"))
        self.cv.create_line(r * 0.55, h - 1.2 * opt.s, w - r * 0.55, h - 1.2 * opt.s,
                            fill=_mix(self.fill, "#000000", 0.38),
                            width=1, tags=("edge", "sheen"))
        # 左上角的一小段镜面反射：没有它，圆角看起来只是"圆"，不是"玻璃"
        self.cv.create_line(r * 0.55, 1.5 * opt.s, r * 1.8, 1.5 * opt.s,
                            fill=_mix(self.fill, "#ffffff", 0.32),
                            width=max(1, int(round(opt.s))), tags=("edge", "sheen"))

        if self.bar:
            # 台词那条竖线已经不用了（`ROLE` 里是 None），保留分支给将来别的角色
            x = max(2, opt.padx // 3)
            round_rect(self.cv, x, opt.pady, x + max(2, int(3 * opt.s)), h - opt.pady,
                       2, fill=self.bar, outline="", tags="bar")
        self.cv.tag_lower("bg")


class Pill(tk.Canvas):
    """圆角胶囊按钮（胶囊 = 圆角半径取高度一半）。

    tkinter 的 Label 只有直角，"发送"和"麦"两个直角块贴在满屏圆角里最扎眼。
    这里用 Canvas 画胶囊 + 一个 Label 当文字，点击/悬停走 Canvas 的绑定。
    """

    def __init__(self, parent, host, text, fg, bg, hover, pad=(10, 16), command=None):
        self.host = host
        self.padx, self.pady = pad
        self._fg, self._bg, self._hover = fg, bg, hover
        h = int(pad[1] + 12 * host.s)
        super().__init__(parent, bg=BG, highlightthickness=0, bd=0,
                         height=h, width=8)
        self.lbl = tk.Label(self, text=text, fg=fg, bg=bg, font=host._f(9.5))
        self._item = self.create_window(0, 0, window=self.lbl, anchor="center")
        # **必须按文字真实宽度定尺寸**：Canvas 不会像 Label 那样自己长大，
        # 靠 `len(text)*系数` 估会算窄（中文/英文宽度差很多，"发送"直接被挤成 0 宽）。
        self.lbl.update_idletasks()
        self.configure(width=self.lbl.winfo_reqwidth() + 2 * self.padx,
                       height=max(h, self.lbl.winfo_reqheight() + self.pady))
        self.bind("<Configure>", lambda _e: self._draw())
        self.bind("<Button-1>", lambda _e: command() if command else None)
        self.bind("<Enter>", lambda _e: self._tint(self._hover))
        self.bind("<Leave>", lambda _e: self._tint(self._bg))
        self._command = command

    def set(self, text=None, bg=None, fg=None):
        """改文字/底色（麦克风按钮要在"麦"和"●录音中"之间切换）"""
        kw = {}
        if text is not None:
            kw["text"] = text
        if bg is not None:
            self._bg = bg
            kw["bg"] = bg
        if fg is not None:
            self._fg = fg
            kw["fg"] = fg
        if kw:
            self.lbl.configure(**kw)
            self.lbl.update_idletasks()
            # 文字变了宽度也要跟着变（"麦" → "●录音中" 差好几倍）
            self.configure(width=self.lbl.winfo_reqwidth() + 2 * self.padx)
        self._draw()

    def set_bg(self, bg):
        self._bg = bg
        self._tint(bg)

    def _tint(self, bg):
        try:
            self.lbl.configure(bg=bg)
        except Exception:
            pass
        self.delete("cap", "sheen")
        w, h = max(1, self.winfo_width()), max(1, self.winfo_height())
        r = h / 2
        round_rect(self, 0.5, 0.5, w - 0.5, h - 0.5, r,
                   fill=bg, outline="", tags="cap")
        # 胶囊也当成一小片玻璃：上沿高光、下沿暗边，悬停换色时一起重画
        self.create_line(r * 0.75, 1.4 * self.host.s, w - r * 0.75, 1.4 * self.host.s,
                         fill=_mix(bg, "#ffffff", 0.13), width=1, tags=("cap", "sheen"))
        self.create_line(r * 0.75, h - 1.2 * self.host.s, w - r * 0.75, h - 1.2 * self.host.s,
                         fill=_mix(bg, "#000000", 0.28), width=1, tags=("cap", "sheen"))
        self.tag_lower("cap")

    def _draw(self):
        w, h = self.winfo_width(), self.winfo_height()
        if w < 4 or h < 4:
            return
        self.coords(self._item, w / 2, h / 2)
        self._tint(self.lbl.cget("bg"))


class Meta:
    """系统行（麦克风状态、报错）：一行灰字，不做气泡。`center=True` 用于空列表提示"""

    def __init__(self, feed, text, opt, center=False):
        self.row = tk.Frame(feed, bg=BG)
        self.row.pack(fill="x", pady=(0 if center else opt.gap, 0))
        self.lbl = tk.Label(self.row, text=text, bg=BG, fg=DIM, font=opt.font_small,
                            anchor="center" if center else "w",
                            justify="center" if center else "left")
        if center:
            self.lbl.pack(fill="x", pady=int(72 * opt.s))
        else:
            self.lbl.pack(anchor="w", padx=3 * opt.s)

    def layout(self, avail):
        self.lbl.configure(wraplength=max(80, int(avail)))


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

        # 液态玻璃要**大圆角**：14 是"卡片"，22 才是苹果那种"玻璃片"
        self.radius = int(22 * S)
        self.pad = self.radius                          # 内容内缩 = 圆角半径（正好落在弧内）

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

        self.family = self._pick_font()
        self.opt = Opt(S, max(160, self.w - 2 * self.pad - int(16 * S)), self.family)

        self.mic_proc = None
        self._drag = None
        self._resize = None
        self.rows = []
        self.empty = None

        # 渲染节流/缓存：Configure 一帧最多画一次玻璃；reflow 等拖动停下来再做。
        self._paint_job = None
        self._reflow_job = None
        self._glass_size = None
        self._last_reflow_width = None
        self._paint_size = None
        self._scroll_job = None
        self._stick_bottom = False

        # 每 200ms 轮询只 stat 一次配置，内容没变就不读盘
        self._cfg_key = None
        self._cfg_hidden = False

        self._build()

        self._offset = 0
        self._carry = ""
        self.seen = 0
        self._reset_cursor()
        self.poll()

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
            self.w = max(int(320 * self.s), min(sw - 40, w))
            self.h = max(int(220 * self.s), min(sh - 40, h))
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

        self.shell = tk.Frame(self.canvas, bg=BG)
        self._shell_item = self.canvas.create_window(self.pad, self.pad,
                                                    window=self.shell, anchor="nw")

        self._build_header()
        self._build_feed()
        self._build_composer()

        self.grip = tk.Frame(self.shell, bg=BG, cursor="bottom_right_corner")
        self.grip.place(relx=1.0, rely=1.0, anchor="se",
                        width=int(18 * self.s), height=int(18 * self.s))
        self.grip.bind("<Button-1>", self._resize_start)
        self.grip.bind("<B1-Motion>", self._resize_move)

        self.canvas.bind("<Button-1>", self._drag_start)
        self.canvas.bind("<B1-Motion>", self._drag_move)
        # 滚轮绑在整个窗口上：真机上鼠标多半停在气泡上，只绑画布就滚不动
        self.root.bind_all("<MouseWheel>", self._on_wheel)

    def _paint(self, event=None):
        """合并 Configure 事件：拖动边框时一帧只重画一次玻璃，不跟着每个像素抖。"""
        if event is not None:
            self._paint_size = (event.width, event.height)
        if self._paint_job is not None:
            return
        self._paint_job = self.root.after(16, self._paint_now)

    def _paint_now(self):
        self._paint_job = None
        if self._paint_size is not None:
            w, h = self._paint_size
        else:
            w, h = self.canvas.winfo_width(), self.canvas.winfo_height()
        if w < 2 or h < 2:
            return
        if (w, h) != self._glass_size:
            self._glass_size = (w, h)
            self.canvas.delete("panel")
            if self.rounded:
                # 液态玻璃底板：只在圆角边上可见的渐变 + 双层高光 + 内外分色描边
                glass_panel(self.canvas, w, h, self.radius, self.s)
        inner_w = max(1, w - 2 * self.pad)
        inner_h = max(1, h - 2 * self.pad)
        self.canvas.itemconfigure(self._shell_item, width=inner_w, height=inner_h)
        self._schedule_reflow()

    def _schedule_reflow(self, delay=70):
        """把全量折行推迟到 resize 停下来之后：拖动时只画边框，不排 200 条消息。"""
        if self._reflow_job is not None:
            try:
                self.root.after_cancel(self._reflow_job)
            except Exception:
                pass
        self._reflow_job = self.root.after(delay, self._reflow_now)

    def _reflow_now(self):
        self._reflow_job = None
        stick = self._at_bottom()
        self._stick_bottom = self._stick_bottom or stick
        try:
            w = self.canvas.winfo_width()
        except Exception:
            w = self.w
        self._reflow(max(1, w - 2 * self.pad - int(8 * self.s)))

    def _build_header(self):
        head = tk.Frame(self.shell, bg=HEAD_BG, height=int(42 * self.s))
        head.pack(fill="x")
        head.pack_propagate(False)

        # 状态球：外圈冷光 + 内芯高亮，比一个"●"字符更像玻璃上的小指示灯
        dot_size = max(10, int(13 * self.s))
        self.dot = tk.Canvas(head, width=dot_size, height=dot_size, bg=HEAD_BG,
                             highlightthickness=0, bd=0)
        self.dot.pack(side="left", padx=(int(15 * self.s), int(8 * self.s)))
        self._dot_ring = self.dot.create_oval(0.5, 0.5, dot_size - 0.5, dot_size - 0.5,
                                              outline="#2f5f9e", width=1)
        self._dot_core = self.dot.create_oval(dot_size * 0.31, dot_size * 0.31,
                                              dot_size * 0.69, dot_size * 0.69,
                                              fill=ACCENT, outline="")

        # **名字可以改**：用户要把它改成自己的叫法（"大肥鱼"之类），不再写死"陪看"。
        # 单击标题 → 就地变成输入框，回车/失焦保存到 `~/.dsh/watch-window.json` 的 `name`。
        # 用 Label 而不是 Entry 起手：Entry 一直有光标和虚线框，看着不像标题。
        self.title = tk.Label(head, text=self.name, bg=HEAD_BG, fg=TEXT,
                              font=self._f(9.5, "bold"), cursor="xterm")
        self.title.pack(side="left")
        self.title.bind("<Button-1>", self._edit_title)

        self.title_entry = tk.Entry(head, bg="#2a3040", fg=TEXT, relief="flat", bd=0,
                                    insertbackground=TEXT, font=self._f(9.5, "bold"),
                                    highlightthickness=0, width=12)
        self.title_entry.bind("<Return>", self._commit_title)
        self.title_entry.bind("<Escape>", lambda _e: self._cancel_title())
        self.title_entry.bind("<FocusOut>", lambda _e: self._commit_title(None))

        self.hint = tk.Label(head, text="", bg=HEAD_BG, fg=DIM, font=self._f(8))
        self.hint.pack(side="left", padx=(int(8 * self.s), 0))

        for text, cmd, hover in (("✕", self.close, "#ff9b9b"),
                                 ("▾", self.toggle_collapse, TEXT)):
            b = tk.Label(head, text=text, bg=HEAD_BG, fg=MUTED, font=self._f(9),
                         padx=int(8 * self.s), cursor="hand2")
            b.pack(side="right")
            b.bind("<Button-1>", lambda _e, c=cmd: c())
            b.bind("<Enter>", lambda _e, w=b, c=hover: w.configure(fg=c))
            b.bind("<Leave>", lambda _e, w=b: w.configure(fg=MUTED))

        sep = tk.Frame(self.shell, bg="#2a2f3c", height=1)
        sep.pack(fill="x", padx=int(14 * self.s))

        # 拖动绑在 header 的元素上，但**标题除外**（点它是改名，不是拖窗）
        for widget in (head, self.dot, self.hint, sep):
            widget.bind("<Button-1>", self._drag_start)
            widget.bind("<B1-Motion>", self._drag_move)

        self.head = head
        self.sep = sep

    def _set_dot(self, color):
        """切换状态球颜色；环色跟主体混一下，避免外圈比内芯还抢眼。"""
        try:
            self.dot.itemconfigure(self._dot_core, fill=color)
            self.dot.itemconfigure(self._dot_ring, outline=_mix(color, HEAD_BG, 0.55))
        except Exception:
            pass

    # ---- 改名 ----
    def _edit_title(self, _event=None):
        """标题就地变输入框（不弹对话框 —— 那会把置顶窗口挡掉一半）"""
        self._editing = True
        self.title.pack_forget()
        self.title_entry.delete(0, "end")
        self.title_entry.insert(0, self.name)
        self.title_entry.pack(side="left", ipady=int(3 * self.s))
        self.title_entry.focus_set()
        self.title_entry.select_range(0, "end")
        return "break"

    def _commit_title(self, _event=None):
        # **用显式标志，不用 `winfo_ismapped()`**：widget 刚 pack 完的那一帧
        # ismapped 还是 False，用户输入快一点回车就被这行吞掉（实测）。
        if not getattr(self, "_editing", False):
            return
        self._editing = False
        text = self.title_entry.get().strip()
        self.title_entry.pack_forget()
        self.title.pack(side="left", before=self.hint)
        if text and text != self.name:
            self.name = text[:24]
            self.title.configure(text=self.name)
            self.root.title(self.name)
            write_config({"name": self.name})
        elif not text:
            self.title.configure(text=self.name)
        return "break"

    def _cancel_title(self):
        self._editing = False
        self.title_entry.pack_forget()
        self.title.pack(side="left", before=self.hint)
        return "break"

    def _build_feed(self):
        outer = tk.Frame(self.shell, bg=BG)
        outer.pack(side="top", fill="both", expand=True)
        self.feed_outer = outer

        self.feed = tk.Canvas(outer, bg=BG, highlightthickness=0, bd=0)
        self.feed.pack(side="left", fill="both", expand=True)

        self.inner = tk.Frame(self.feed, bg=BG)
        self._inner_item = self.feed.create_window(0, 0, window=self.inner, anchor="nw")
        # 顶部留白：第一条消息不要贴着分隔线
        tk.Frame(self.inner, bg=BG, height=int(6 * self.s)).pack(fill="x")

        # 细滚动条：只在真的滚得动时出现（原生 Scrollbar 太丑）
        self.sbar = tk.Canvas(outer, bg=BG, width=int(6 * self.s),
                              highlightthickness=0, bd=0)
        self.sbar.pack(side="right", fill="y", padx=(0, int(4 * self.s)))
        self._thumb = self.sbar.create_rectangle(0, 0, 0, 0, fill="#39415a", width=0,
                                                 state="hidden")
        self.feed.configure(yscrollcommand=self._on_scroll)

    def _on_scroll(self, first, last):
        try:
            h = max(1, self.sbar.winfo_height())
            f, l = float(first), float(last)
            self.sbar.coords(self._thumb, 0, f * h, int(6 * self.s), l * h)
            self.sbar.itemconfigure(self._thumb, state="normal" if (l - f) < 0.999 else "hidden")
        except Exception:
            pass

    def _build_composer(self):
        bar = tk.Frame(self.shell, bg=BG)
        # side="bottom"：入口栏先占住底部，中间的列表再怎么长也挤不掉它
        bar.pack(side="bottom", fill="x",
                 padx=int(14 * self.s), pady=(int(9 * self.s), int(14 * self.s)))
        self.bar = bar

        self.mic_btn = Pill(bar, self, "麦", MUTED, "#222732", "#2c323f",
                            pad=(int(11 * self.s), int(17 * self.s)),
                            command=self.toggle_mic)
        self.mic_btn.pack(side="left", padx=(0, int(8 * self.s)))

        # **先占右边**：`send` 用 `side="right"` 先把自己的位置钉住，输入框再拿剩下的。
        # 反过来（field 先 expand 再 pack send）实测会被挤没 —— pack 的空间分配是按顺序来的。
        self.send_btn = Pill(bar, self, "发送", "#ffffff", ACCENT, "#5aa0f0",
                             pad=(int(13 * self.s), int(14 * self.s)),
                             command=self._send)
        self.send_btn.pack(side="right", padx=(int(8 * self.s), 0))

        # 圆角输入框：tk 的 Entry 只能画直角，所以**底下垫一块 Canvas 画胶囊**，
        # Entry 自己去掉一切边框浮在上面（`bg` 和胶囊同色，看起来就是一体的）。
        field = tk.Frame(bar, bg=BG)
        field.pack(side="left", fill="x", expand=True)
        self.field_cv = tk.Canvas(field, bg=BG, highlightthickness=0, bd=0,
                                 height=int(34 * self.s))
        self.field_cv.pack(fill="both", expand=True)
        self.entry = tk.Entry(self.field_cv, bg=FIELD_BG, fg=TEXT, insertbackground=TEXT,
                              relief="flat", bd=0, font=self._f(10), highlightthickness=0)
        self._entry_item = self.field_cv.create_window(
            int(12 * self.s), int(17 * self.s), window=self.entry, anchor="w")
        self.field_cv.bind("<Configure>", self._paint_field)
        self.entry.bind("<Return>", self._send)
        self.entry.bind("<FocusIn>", lambda _e: self._paint_field(accent=True))
        self.entry.bind("<FocusOut>", lambda _e: self._paint_field())

    def _paint_field(self, event=None, accent=False):
        """画输入框的胶囊底（圆角随窗口宽高变，所以要重画）"""
        cv = getattr(self, "field_cv", None)
        if cv is None:
            return
        w = event.width if event else cv.winfo_width()
        h = event.height if event else cv.winfo_height()
        if w < 4 or h < 4:
            return
        cv.delete("pill")
        r = h / 2
        round_rect(cv, 0.5, 0.5, w - 0.5, h - 0.5, r,
                   fill=FIELD_BG, outline="", tags="pill")
        cv.create_line(r, 0.8, w - r, 0.8,
                       fill=ACCENT if accent else "#333a4b", width=1, tags="pill")
        cv.create_line(r * 0.8, h - 1.2 * self.s, w - r * 0.8, h - 1.2 * self.s,
                       fill=_mix(FIELD_BG, "#000000", 0.30), width=1, tags="pill")
        cv.tag_lower("pill")
        cv.coords(self._entry_item, int(12 * self.s), h / 2)
        try:
            self.entry.configure(width=max(4, int((w - 24 * self.s) / (7.2 * self.s))))
        except Exception:
            pass

    def _focus_entry(self):
        """把焦点交给输入框，但**不抢系统焦点**。

        以前用 `focus_force()`：窗口一开就把焦点从浏览器抢走 —— 用户正看着片，
        敲空格想暂停，结果字打进了聊天框。`focus_set()` 只在本窗口内部指定焦点：
        点一下窗口就能直接打字，不点就完全不影响他在浏览器里的操作。
        """
        try:
            self.entry.focus_set()
        except Exception:
            pass

    # ---- 语音输入 ----
    def _mic_hover(self, on):
        if self.mic_proc and self.mic_proc.poll() is None:
            return
        self.mic_btn.set_bg(HOVER_BG if on else "#222732")

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
        self._set_dot(DANGER)
        self.hint.configure(text="录音中")
        threading.Thread(target=self._mic_log, args=(self.mic_proc,), daemon=True).start()

    def _stop_mic(self):
        p = self.mic_proc
        self.mic_proc = None
        if p and p.poll() is None:
            try:
                p.terminate()
            except Exception:
                pass
        self.mic_btn.set(text="麦", bg="#222732", fg=MUTED)
        self._set_dot(ACCENT)
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
    def _drag_start(self, event):
        self._drag = (event.x_root - self.root.winfo_x(), event.y_root - self.root.winfo_y())

    def _drag_move(self, event):
        if not self._drag:
            return
        dx, dy = self._drag
        self.x, self.y = event.x_root - dx, event.y_root - dy
        self.root.geometry(f"+{self.x}+{self.y}")

    def _resize_start(self, event):
        self._resize = (event.x_root, event.y_root, self.w, self.h)

    def _resize_move(self, event):
        if not self._resize:
            return
        x0, y0, w0, h0 = self._resize
        self.w = max(int(320 * self.s), w0 + (event.x_root - x0))
        self.h = max(int(220 * self.s), h0 + (event.y_root - y0))
        self.root.geometry(f"{self.w}x{self.h}+{self.x}+{self.y}")

    def _on_wheel(self, event):
        try:
            self.feed.yview_scroll(int(-1 * (event.delta / 120)), "units")
        except Exception:
            pass

    # ---- 交互 ----
    def toggle_collapse(self):
        if self.body_visible():
            self.feed_outer.pack_forget()
            self.bar.pack_forget()
            self.h = int(40 * self.s) + 2 * self.pad
        else:
            self.bar.pack(side="bottom", fill="x",
                          padx=int(12 * self.s), pady=(int(9 * self.s), int(12 * self.s)))
            self.feed_outer.pack(side="top", fill="both", expand=True)
            self.h = int(540 * self.s)
        self.root.geometry(f"{self.w}x{self.h}+{self.x}+{self.y}")

    def body_visible(self):
        return bool(self.feed_outer.winfo_ismapped())

    def close(self):
        self._stop_mic()      # 窗口关了就别留个录音进程在后台
        write_config({"geometry": f"{self.w}x{self.h}+{self.x}+{self.y}"})
        self.root.destroy()

    def _send(self, _event=None):
        text = self.entry.get().strip()
        if not text:
            return "break"
        self.entry.delete(0, "end")
        try:
            append_user(text)
        except Exception as exc:
            self._add_meta(f"写不进去：{exc}")
            return "break"
        self.poll()      # 立刻回显，不等下一拍
        return "break"

    # ---- 列表 ----
    def _reflow(self, avail=None):
        """窗口/字体变化后重新折行：气泡宽度按新的可用宽度算。

        **只在宽度真的变了时工作**。追加消息走 `_append` 的单条 layout，
        不再每来一句就把所有历史气泡重排一遍（旧行为是 O(n²)）。
        """
        feed = getattr(self, "feed", None)
        if feed is None:            # 画布的 Configure 可能早于列表建好
            return
        width = int(avail or feed.winfo_width() or 300)
        width = max(120, width - int(10 * self.s))      # 给细滚动条留位置
        if width == self._last_reflow_width:
            return
        self._last_reflow_width = width
        self.opt.avail = width
        for row in self.rows:
            try:
                row.layout(width)
            except Exception:
                pass
        self._update_scrollregion(width)

    def _update_scrollregion(self, width=None):
        """安排一次 idle 更新：合并整批新增消息，滚到真正的底部。

        **不能在 append 里同步 update_idletasks**：那会把整棵树重排一遍，每来一句都付
        O(rows) 的代价，正是旧版越用越卡的主因。把 update 合并到一次 idle，既快又不会
        因为 bbox 早了一帧而留下底部空白。
        """
        feed = getattr(self, "feed", None)
        if feed is None:
            return
        if width is not None:
            try:
                feed.itemconfigure(self._inner_item, width=width)
            except Exception:
                pass
        if self._scroll_job is None:
            self._scroll_job = self.root.after_idle(self._scroll_now)

    def _scroll_now(self):
        self._scroll_job = None
        feed = getattr(self, "feed", None)
        if feed is None:
            return
        try:
            self.inner.update_idletasks()
            feed.configure(scrollregion=feed.bbox("all"))
            if self._stick_bottom:
                self._to_bottom()
                self._stick_bottom = False
        except Exception:
            pass

    def _at_bottom(self):
        try:
            return self.feed.yview()[1] > 0.98
        except Exception:
            return True

    def _to_bottom(self):
        try:
            self.feed.yview_moveto(1.0)
        except Exception:
            pass

    def _clear_empty(self):
        if self.empty is not None:
            try:
                self.empty.row.destroy()
            except Exception:
                pass
            if self.empty in self.rows:
                self.rows.remove(self.empty)
            self.empty = None

    def _show_empty(self):
        if self.empty is not None or self.rows:
            return
        self.empty = Meta(self.inner, "在这里跟它说话 · 回车发送", self.opt, center=True)
        self.rows.append(self.empty)
        self._stick_bottom = True
        self._update_scrollregion()

    def _add_bubble(self, role, text, stamp):
        # 在 append **之前**判断：加完这一条之后 yview 已经变了，再判断就永远"不在底部"。
        stick = self._at_bottom()
        self._clear_empty()
        b = Bubble(self.inner, role, text, stamp, self.opt)
        self.rows.append(b)
        self._stick_bottom = self._stick_bottom or stick
        self._update_scrollregion()

    def _add_meta(self, text):
        stick = self._at_bottom()
        self._clear_empty()
        m = Meta(self.inner, text, self.opt)
        self.rows.append(m)
        self._stick_bottom = self._stick_bottom or stick
        self._update_scrollregion()

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
        if self.mic_proc and self.mic_proc.poll() is None:
            text = "录音中"
        else:
            text = f"{self.seen} 条" if self.seen else "已连上"
        # 每 200ms 都 configure 一次会让 Tk 重排 header；内容没变就别碰。
        try:
            if self.hint.cget("text") != text:
                self.hint.configure(text=text)
        except Exception:
            pass

    def _hidden_from_config(self):
        """每 200ms 只 stat 配置文件；内容没变就不读盘、不解析 JSON。"""
        try:
            st = os.stat(CONFIG)
            key = (st.st_mtime_ns, st.st_size)
        except OSError:
            key = None
        if key != self._cfg_key:
            self._cfg_key = key
            self._cfg_hidden = bool(read_config().get("hidden"))
        return self._cfg_hidden

    def _sync_visible(self):
        """跟随配置里的 `hidden`：插件写 true 就藏起来（进程还活着，照样收话、照样念），写 false 就回来。

        为什么要"藏"而不是"关"：关窗在陪看里等于"不看了"（会停表、落挂断记录）。
        用户想的是**这一次别挡着画面**，陪看继续 —— 那是两件事。
        用 withdraw 而不是 iconify：图标化的窗口还会占任务栏/出现在 Alt+Tab 里，
        而这是置顶悬浮窗，藏起来就该完全看不见。
        """
        want = self._hidden_from_config()
        if want == self.hidden:
            return
        self.hidden = want
        try:
            if want:
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


if __name__ == "__main__":
    if not os.path.exists(CHAT_FILE):
        os.makedirs(os.path.dirname(CHAT_FILE), exist_ok=True)
    FloatChat().root.mainloop()
