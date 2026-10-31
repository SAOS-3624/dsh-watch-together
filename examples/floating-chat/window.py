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

BG = "#12141a"            # 面板
BORDER = "#272c3a"        # 面板描边 / 分隔线
TEXT = "#e8ebf2"
MUTED = "#8a93a5"
DIM = "#5b6473"
ACCENT = "#4a8cdd"
DANGER = "#c8564f"
KEY = "#010203"           # 圆角抠图用的透明键色（只给根窗口和画布用）

# 角色 → (气泡底色, 文字色, 竖线色 或 None, 抬头)
ROLE = {
    "line": ("#241d12", "#f2c46a", "#f0b95c", "台词"),
    "assistant": ("#1d222c", "#d7dfeb", None, "陪看"),
    "user": ("#17293d", "#bcd8f5", None, "我"),
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
    """播放秒 → mm:ss.d（台词的时间码）"""
    try:
        s = max(0.0, float(t))
    except (TypeError, ValueError):
        return ""
    return f"{int(s // 60):02d}:{s % 60:04.1f}"


def clock(ms):
    """墙钟毫秒 → HH:MM（谁说这句话的时刻）"""
    try:
        return time.strftime("%H:%M", time.localtime(float(ms) / 1000.0))
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
    """Canvas 画圆角矩形（smooth 折线近似；不引第三方库）"""
    r = max(0, min(r, (x2 - x1) / 2, (y2 - y1) / 2))
    pts = [
        x1 + r, y1, x2 - r, y1, x2, y1,
        x2, y1 + r, x2, y2 - r, x2, y2,
        x2 - r, y2, x1 + r, y2, x1, y2,
        x1, y2 - r, x1, y1 + r, x1, y1,
    ]
    return cv.create_polygon(pts, smooth=True, **kw)


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
    """一条消息 = 抬头 + 一块圆角气泡。

    为什么不用 Text 拼：Text 的 tag 背景是**整行宽**的方块，右对齐时会变成一条色带。
    这里每条消息是独立的小画布，气泡宽度贴着内容。
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
        self.head.pack(anchor="e" if right else "w",
                       padx=(0, 3 * opt.s) if right else (3 * opt.s, 0))

        self.cv = tk.Canvas(self.row, bg=BG, highlightthickness=0, bd=0)
        self.cv.pack(anchor="e" if right else "w")
        self.lbl = tk.Label(self.cv, text=text, bg=fill, fg=fg, font=opt.font,
                            justify="left", anchor="w", wraplength=int(220 * opt.s))
        self.cv.create_window(opt.padx, opt.pady, window=self.lbl, anchor="nw")
        self.layout(opt.avail)

    def layout(self, avail):
        """按可用宽度重新折行并重画底板（窗口拉伸/缩放时调用）"""
        opt = self.opt
        limit = max(int(120 * opt.s), int(avail * 0.86) - 2 * opt.padx)
        self.lbl.configure(wraplength=limit)
        self.lbl.update_idletasks()
        w = min(limit, max(1, self.lbl.winfo_reqwidth())) + 2 * opt.padx
        h = max(1, self.lbl.winfo_reqheight()) + 2 * opt.pady
        self.cv.configure(width=w, height=h)
        self.cv.delete("bg", "bar")
        round_rect(self.cv, 0, 0, w, h, opt.radius, fill=self.fill, outline="", tags="bg")
        if self.bar:
            # 台词左边那条竖线：细圆头，和文字留一点距离
            x = max(2, opt.padx // 3)
            round_rect(self.cv, x, opt.pady, x + max(2, int(3 * opt.s)), h - opt.pady,
                       2, fill=self.bar, outline="", tags="bar")
        self.cv.tag_lower("bg")


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

        self.root = tk.Tk()
        self.root.title("陪看")
        self.root.overrideredirect(True)                 # 无边框
        self.root.attributes("-topmost", True)           # 置顶
        self.root.configure(bg=KEY)

        try:
            self.s = max(1.0, min(2.2, float(self.root.winfo_fpixels("1i")) / SS))
        except Exception:
            self.s = 1.0
        S = self.s

        self.radius = int(14 * S)
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

        self.family = self._pick_font()
        self.opt = Opt(S, max(160, self.w - 2 * self.pad - int(16 * S)), self.family)

        self.mic_proc = None
        self._drag = None
        self._resize = None
        self.rows = []
        self.empty = None

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
            self.x = max(0, min(sw - 120, x))
            self.y = max(0, min(sh - 80, y))
        except Exception:
            self.x = sw - self.w - int(36 * self.s)
            self.y = sh - self.h - int(96 * self.s)
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
        w = event.width if event else self.root.winfo_width()
        h = event.height if event else self.root.winfo_height()
        self.canvas.delete("panel")
        if self.rounded:
            round_rect(self.canvas, 0, 0, w, h, self.radius, fill=BG,
                       outline=BORDER, width=max(1, int(self.s)), tags="panel")
        inner_w = max(1, w - 2 * self.pad)
        inner_h = max(1, h - 2 * self.pad)
        self.canvas.itemconfigure(self._shell_item, width=inner_w, height=inner_h)
        self._reflow(max(1, inner_w - int(8 * self.s)))

    def _build_header(self):
        head = tk.Frame(self.shell, bg=BG, height=int(40 * self.s))
        head.pack(fill="x")
        head.pack_propagate(False)

        self.dot = tk.Label(head, text="●", bg=BG, fg=ACCENT, font=self._f(7.5))
        self.dot.pack(side="left", padx=(int(14 * self.s), int(7 * self.s)))

        self.title = tk.Label(head, text="陪看", bg=BG, fg=TEXT, font=self._f(9.5, "bold"))
        self.title.pack(side="left")

        self.hint = tk.Label(head, text="", bg=BG, fg=DIM, font=self._f(8))
        self.hint.pack(side="left", padx=(int(8 * self.s), 0))

        for text, cmd, hover in (("✕", self.close, "#ff9b9b"),
                                 ("▾", self.toggle_collapse, TEXT)):
            b = tk.Label(head, text=text, bg=BG, fg=MUTED, font=self._f(9),
                         padx=int(8 * self.s), cursor="hand2")
            b.pack(side="right")
            b.bind("<Button-1>", lambda _e, c=cmd: c())
            b.bind("<Enter>", lambda _e, w=b, c=hover: w.configure(fg=c))
            b.bind("<Leave>", lambda _e, w=b: w.configure(fg=MUTED))

        sep = tk.Frame(self.shell, bg=BORDER, height=1)
        sep.pack(fill="x", padx=int(12 * self.s))

        for widget in (head, self.dot, self.title, self.hint, sep):
            widget.bind("<Button-1>", self._drag_start)
            widget.bind("<B1-Motion>", self._drag_move)

        self.head = head
        self.sep = sep

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
        self._thumb = self.sbar.create_rectangle(0, 0, 0, 0, fill="#2b3140", width=0,
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
                 padx=int(12 * self.s), pady=(int(9 * self.s), int(12 * self.s)))
        self.bar = bar

        self.mic_btn = tk.Label(bar, text="麦", bg="#1e2330", fg=MUTED, font=self._f(9),
                                padx=int(9 * self.s), cursor="hand2")
        self.mic_btn.pack(side="left", ipady=int(6 * self.s), padx=(0, int(8 * self.s)))
        self.mic_btn.bind("<Button-1>", lambda _e: self.toggle_mic())
        self.mic_btn.bind("<Enter>", lambda _e: self._mic_hover(True))
        self.mic_btn.bind("<Leave>", lambda _e: self._mic_hover(False))

        # 1px 描边：外层 Frame 当边框，内层放 Entry（tk 的 Entry 自己画不了细边）
        field = tk.Frame(bar, bg=BORDER)
        field.pack(side="left", fill="x", expand=True)
        inner = tk.Frame(field, bg="#171a21")
        inner.pack(fill="both", expand=True, padx=1, pady=1)
        self.entry = tk.Entry(inner, bg="#171a21", fg=TEXT, insertbackground="#f0b95c",
                              relief="flat", bd=0, font=self._f(10), highlightthickness=0)
        self.entry.pack(fill="x", expand=True, ipady=int(6 * self.s),
                        padx=int(9 * self.s), pady=int(2 * self.s))
        self.entry.bind("<Return>", self._send)
        self.entry.bind("<FocusIn>", lambda _e: field.configure(bg=ACCENT))
        self.entry.bind("<FocusOut>", lambda _e: field.configure(bg=BORDER))

        self.send_btn = tk.Label(bar, text="发送", bg=ACCENT, fg="#ffffff", font=self._f(9),
                                 padx=int(12 * self.s), cursor="hand2")
        self.send_btn.pack(side="left", ipady=int(6 * self.s), padx=(int(8 * self.s), 0))
        self.send_btn.bind("<Button-1>", lambda _e: self._send())
        self.send_btn.bind("<Enter>", lambda _e: self.send_btn.configure(bg="#589ae6"))
        self.send_btn.bind("<Leave>", lambda _e: self.send_btn.configure(bg=ACCENT))

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
        self.mic_btn.configure(bg="#272d3b" if on else "#1e2330")

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
        self.mic_btn.configure(text="●", bg="#7a2b2b", fg="#ffd9d9")
        self.dot.configure(fg=DANGER)
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
        self.mic_btn.configure(text="麦", bg="#1e2330", fg=MUTED)
        self.dot.configure(fg=ACCENT)
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
        """窗口/字体变化后重新折行：气泡宽度按新的可用宽度算"""
        feed = getattr(self, "feed", None)
        if feed is None:            # 画布的 Configure 可能早于列表建好
            return
        width = int(avail or feed.winfo_width() or 300)
        width = max(120, width - int(10 * self.s))      # 给细滚动条留位置
        self.opt.avail = width
        for row in self.rows:
            try:
                row.layout(width)
            except Exception:
                pass
        try:
            feed.itemconfigure(self._inner_item, width=width)
            self.inner.update_idletasks()
            feed.configure(scrollregion=feed.bbox("all"))
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
        self._reflow()
        self._to_bottom()

    def _add_bubble(self, role, text, stamp):
        stick = self._at_bottom()
        self._clear_empty()
        b = Bubble(self.inner, role, text, stamp, self.opt)
        self.rows.append(b)
        self._reflow()
        if stick:
            self._to_bottom()

    def _add_meta(self, text):
        stick = self._at_bottom()
        self._clear_empty()
        m = Meta(self.inner, text, self.opt)
        self.rows.append(m)
        self._reflow()
        if stick:
            self._to_bottom()

    def _render(self, entry):
        """一条 jsonl → 一个气泡。**新消息和历史回放走同一条路**，样式才不会两套。"""
        role = entry.get("role") if entry.get("role") in ROLE else "assistant"
        if role == "line":
            stamp = mmss(entry.get("t")) if entry.get("t") is not None else ""
        else:
            stamp = clock(entry.get("at"))
        self._add_bubble(role, str(entry.get("text") or ""), stamp)

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
            self.hint.configure(text="录音中")
        else:
            self.hint.configure(text=f"{self.seen} 条" if self.seen else "已连上")

    def poll(self):
        try:
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
