#!/usr/bin/env python3
"""真正悬浮窗：不铺全屏背景图，实时抓取窗口背后的桌面并模糊。

关键点：
- Windows 10 2004+ 的 SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)：
  让本窗口从屏幕捕获里消失，于是抓自己所在区域时抓到的是“背后的桌面”，
  不会抓到自己，不会递归，也不需要全屏置顶图片。
- 抓到的背景每 ~100ms 更新一次，所以是实时模糊，不是静态截图。
- 这不是 DWM Acrylic；Acrylic 需要系统“透明效果”开启。这里是软件实时模糊。
"""
import ctypes
import json
import os
import queue
import subprocess
import sys
import threading
import time
from ctypes import wintypes
from pathlib import Path

# 必须在 import tkinter / 创建任何窗口之前声明 per-monitor v2 DPI 感知。
_u = ctypes.windll.user32
try:
    _u.SetProcessDpiAwarenessContext.argtypes = [ctypes.c_void_p]
    _u.SetProcessDpiAwarenessContext.restype = ctypes.c_bool
    _u.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
except Exception:
    pass

try:
    ctypes.windll.winmm.timeBeginPeriod(1)
except Exception:
    pass

import tkinter as tk
import tkinter.font as tkfont
import mss
import numpy as np
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageStat, ImageTk

W, H, R = 760, 560, 58
MIN_W, MIN_H = 480, 420
BAR_FRAC = 0.55
BAR_Y = 20
BAR_THICK = 4
KEY = "#010203"
FONT = "Microsoft YaHei UI"
INTERVAL_MS = 4
MAX_FPS = 120
PAD = 40
BAND = 64          # 全分辨率下的透镜带宽度
AMP = 30           # 全分辨率下的最大采样偏移
FORCE = os.environ.get("GLASS_FORCE") == "1"
# 仅用于文档截图/CI 视觉检查：暂停抓屏并把 WDA 关掉，窗口才会出现在截图里
PREVIEW = os.environ.get("DSH_GLASS_PREVIEW") == "1"
# 文档截图：正常抓屏 2.5 秒后暂停并取消 WDA，保留最后一帧玻璃
SNAPSHOT = os.environ.get("DSH_GLASS_SNAPSHOT") == "1"

# 和 window.py 用同一份聊天流 / 配置，两个窗口可以同时开，看到的是同一条时间线
HERE = Path(__file__).resolve().parent


def cache_dir():
    d = os.environ.get("DSH_VIDEO_CACHE_DIR")
    if d:
        return Path(d)
    local = os.environ.get("LOCALAPPDATA")
    if os.name == "nt" and local:
        return Path(local) / "dsh-video-storyboard" / "cache"
    return Path(os.environ.get("XDG_CACHE_HOME") or "~/.cache").expanduser() / "dsh-video-storyboard"


CHAT_FILE = cache_dir() / "chat.jsonl"
CONFIG = Path(os.environ.get("DSH_HOME") or os.path.expanduser("~/.dsh")) / "watch-window.json"
MIC_SCRIPT = HERE / "mic.py"


def read_config():
    try:
        return json.loads(CONFIG.read_text(encoding="utf-8")) or {}
    except Exception:
        return {}


def write_config(patch):
    cfg = read_config()
    cfg.update(patch or {})
    try:
        CONFIG.parent.mkdir(parents=True, exist_ok=True)
        tmp = CONFIG.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, CONFIG)
    except Exception:
        pass


def append_user(text):
    CHAT_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(CHAT_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps({"role": "user", "text": text, "at": int(time.time() * 1000)},
                           ensure_ascii=False) + "\n")


def clock(ms):
    try:
        return time.strftime("%H:%M:%S", time.localtime(float(ms) / 1000.0))
    except (TypeError, ValueError, OSError):
        return ""


def asr_python():
    """和 window.py 一样：麦克风用 ASR 的 Python，不是带 tkinter 的这个。"""
    for key in ("DSH_ASR_PYTHON", "DSH_FLOAT_PYTHON"):
        v = os.environ.get(key)
        if v:
            return v
    if os.name == "nt":
        return "python.exe"
    return "python3"


def f(size, bold=False):
    return (FONT, size, "bold") if bold else (FONT, size)


def display_hz():
    """显示器刷新率；240Hz 屏也照实返回，但软件管线不会硬追 240。"""
    try:
        u = ctypes.windll.user32
        g = ctypes.windll.gdi32
        dc = u.GetDC(0)
        hz = int(g.GetDeviceCaps(dc, 116))
        u.ReleaseDC(0, dc)
        return hz if hz > 0 else 60
    except Exception:
        return 60


def chat_layout(h):
    """消息区在高度不足 560 时压缩行高；底部输入框始终贴底。"""
    input_top = h - 80
    if h >= 560:
        ys, bh = [124, 214, 304, 404], 60
    else:
        # 顶部留 8px 空隙给最后一条和输入框，避免贴在一起
        avail = max(0, input_top - 124 - 8)
        bh = min(60, max(36, (avail - 24) // 4))
        gap = max(8, (avail - 4 * bh) // 3)
        ys = [124 + i * (bh + gap) for i in range(4)]
    return ys, bh, input_top


def shapes_for(w, h):
    """按窗口尺寸生成内部框位置；宽度横向伸展，底栏贴底。"""
    ys, bh, input_top = chat_layout(h)
    # 真实聊天流每条长度不可预测，四个气泡统一吃满内容宽度；输入/发送仍分开
    return [
        (38, ys[0], w - 38, ys[0] + bh, 30),
        (38, ys[1], w - 38, ys[1] + bh, 30),
        (38, ys[2], w - 38, ys[2] + bh, 30),
        (38, ys[3], w - 38, ys[3] + bh, 30),
        (36, input_top, w - 146, input_top + 54, 27),
        (w - 134, input_top, w - 36, input_top + 54, 27),
    ]


SHAPES = shapes_for(W, H)


def rounded_mask():
    # 4x 超采样再缩小，圆角边缘不会出现锯齿
    m = Image.new("L", (W * 4, H * 4), 0)
    ImageDraw.Draw(m).rounded_rectangle(
        (0, 0, W * 4 - 1, H * 4 - 1), radius=R * 4, fill=255)
    return m.resize((W, H), Image.Resampling.LANCZOS)


def build_overlay():
    """只画气泡和输入控件；窗口本体不再加 tint / 高光 / 外圈。"""
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    # 只给内部框轻微染色，不做描边；窗口本体仍然完全透明
    tints = [
        (235, 242, 255, 5),
        (110, 175, 255, 14),
        (235, 242, 255, 4),
        (235, 242, 255, 4),
        (235, 242, 255, 5),
        (110, 175, 255, 12),
    ]
    for (x0, y0, x1, y1, r), fill in zip(SHAPES, tints):
        d.rounded_rectangle((x0, y0, x1, y1), radius=r, fill=fill)
    return layer


def build_warp():
    """半分辨率边缘位移图：真正采样“边界外”的背景，不是描边。

    半径方向向外取样本，越靠近边偏移越大；到 BAND 内归零。
    只在半分辨率算，成本约 1ms，放大后边缘会有真实的弯曲/压缩。
    """
    hw, hh = W // 4, H // 4
    yy, xx = np.mgrid[0:hh, 0:hw].astype(np.float32)
    r = R / 4.0
    qx = np.abs(xx - hw / 2) - (hw / 2 - r)
    qy = np.abs(yy - hh / 2) - (hh / 2 - r)
    sdf = (np.hypot(np.maximum(qx, 0), np.maximum(qy, 0))
           + np.minimum(np.maximum(qx, qy), 0) - r)
    gy, gx = np.gradient(sdf)
    n = np.maximum(np.hypot(gx, gy), 1e-6)
    d = -sdf
    t = np.clip(1.0 - d / (BAND / 4.0), 0.0, 1.0)
    mag = (AMP / 4.0) * t * t
    edge_mask = np.clip((BAND / 4.0 - d) / 1.5, 0.0, 1.0)
    return xx + gx / n * mag, yy + gy / n * mag, edge_mask.astype(np.float32)


MASK = rounded_mask()
# color-key 透明不能用半透明边缘：半透明像素会和黑色 KEY 混合，形成四角黑边。
# 用二值遮罩硬切，边缘像素保留自身颜色，不再与 KEY 混合。
MASK_HARD = MASK.point(lambda v: 255 if v >= 128 else 0)
OVERLAY = build_overlay()
# 染色层在 1/4 分辨率合成，避免每帧对 760x560 做一次 alpha_composite
OVERLAY_2X = OVERLAY.resize((W // 2, H // 2), Image.Resampling.BILINEAR)

# 用你给的麦克风图：去背景得到 alpha，再分别做浅色/深色两版
MIC_POS = (53, H - 67)
MIC_MASK = Image.open(Path(__file__).with_name("mic-dsh.png")).convert("L")
MIC_MASK = MIC_MASK.resize((28, 28), Image.Resampling.LANCZOS)
MIC_LIGHT = Image.new("RGBA", MIC_MASK.size, (235, 244, 255, 0))
MIC_LIGHT.putalpha(MIC_MASK)
MIC_DARK = Image.new("RGBA", MIC_MASK.size, (24, 48, 72, 0))
MIC_DARK.putalpha(MIC_MASK)
WARP_X, WARP_Y, EDGE_MASK = build_warp()

# 内部框体：气泡 + 输入框 + 发送。透镜在 1/4 分辨率算，染色用全分辨率遮罩。
BOX_BAND = 7      # 1/4 分辨率下的折射带
BOX_AMP = 8       # 1/4 分辨率下的最大采样偏移



def build_box_maps():
    out = []
    for x0, y0, x1, y1, r in SHAPES:
        qx0, qy0 = x0 // 4, y0 // 4
        qw, qh = max(2, (x1 - x0) // 4), max(2, (y1 - y0) // 4)
        xx, yy = np.meshgrid(np.arange(qw, dtype=np.float32),
                             np.arange(qh, dtype=np.float32))
        rr = r / 4.0
        cx, cy = qw / 2.0, qh / 2.0
        qx = np.abs(xx - cx) - (cx - rr)
        qy = np.abs(yy - cy) - (cy - rr)
        sdf = (np.hypot(np.maximum(qx, 0), np.maximum(qy, 0))
               + np.minimum(np.maximum(qx, qy), 0) - rr)
        gy, gx = np.gradient(sdf)
        n = np.maximum(np.hypot(gx, gy), 1e-6)
        d = -sdf
        inside = d >= 0
        alpha = np.clip((d + 0.6) / 1.2, 0.0, 1.0).astype(np.float32)
        edge = inside & (d <= BOX_BAND)
        t = np.clip(1.0 - d / BOX_BAND, 0.0, 1.0)
        mag = BOX_AMP * t * t
        sx = np.rint(qx0 + xx + gx / n * mag).astype(np.int32)
        sy = np.rint(qy0 + yy + gy / n * mag).astype(np.int32)
        np.clip(sx, 0, W // 4 - 1, out=sx)
        np.clip(sy, 0, H // 4 - 1, out=sy)
        out.append((qx0, qy0, qw, qh, alpha, edge, sx, sy))
    return out


BOX_MAPS = build_box_maps()


def build_box_union(ow, oh):
    """目标分辨率下的圆角联合遮罩，4x 超采样后缩小，边界平滑。"""
    ss = 4
    fx, fy = ow / W, oh / H
    m = Image.new("L", (ow * ss, oh * ss), 0)
    d = ImageDraw.Draw(m)
    for x0, y0, x1, y1, r in SHAPES:
        d.rounded_rectangle((x0 * fx * ss, y0 * fy * ss,
                             x1 * fx * ss, y1 * fy * ss),
                            radius=r * min(fx, fy) * ss, fill=255)
    return m.resize((ow, oh), Image.Resampling.LANCZOS)


HW, HH = W // 2, H // 2
BOX_UNION_2X = build_box_union(HW, HH)


def rebuild_geometry(w, h):
    """窗口尺寸变化后重建所有和 W/H 绑定的贴图/遮罩。"""
    global W, H, SHAPES, MASK, MASK_HARD, OVERLAY, OVERLAY_2X
    global WARP_X, WARP_Y, EDGE_MASK, BOX_MAPS, HW, HH, BOX_UNION_2X, MIC_POS
    W, H = w, h
    SHAPES = shapes_for(w, h)
    MASK = rounded_mask()
    MASK_HARD = MASK.point(lambda v: 255 if v >= 128 else 0)
    OVERLAY = build_overlay()
    OVERLAY_2X = OVERLAY.resize((W // 2, H // 2), Image.Resampling.BILINEAR)
    MIC_POS = (53, H - 67)
    WARP_X, WARP_Y, EDGE_MASK = build_warp()
    BOX_MAPS = build_box_maps()
    HW, HH = W // 2, H // 2
    BOX_UNION_2X = build_box_union(HW, HH)


def finish(panel):
    """只做圆角遮罩；染色已经在 1/4 分辨率合成过。"""
    out = Image.new("RGB", (W, H), KEY)
    out.paste(panel.convert("RGB"), (0, 0), MASK_HARD)
    return out


class RECT(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                ("right", ctypes.c_long), ("bottom", ctypes.c_long)]


class LiveGlass:
    def __init__(self):
        global W, H
        cfg = read_config()
        raw_name = cfg.get("name")
        self.name = (raw_name.strip()[:24] if isinstance(raw_name, str) and raw_name.strip()
                     else "陪看")
        self.messages = []
        self._msg_offset = 0
        self._file_pos = 0
        self._file_size = -1
        self._chat_after = None
        self._mic_proc = None
        self._status = ""
        self._cfg_key = None
        self._hidden = False

        self.root = tk.Tk()
        self.root.withdraw()
        self.root.overrideredirect(True)
        self.root.title(self.name)
        self.root.attributes("-topmost", True)
        self.root.configure(bg=KEY)
        self.root.attributes("-transparentcolor", KEY)

        sw, sh = self.root.winfo_screenwidth(), self.root.winfo_screenheight()
        self._sw, self._sh = sw, sh
        # 默认比旧窗宽一点；有 geometry 就恢复，但尺寸仍在玻璃引擎的可用范围内
        self._parse_geometry(cfg.get("geometry") if isinstance(cfg.get("geometry"), str) else "")
        self.root.geometry(f"{W}x{H}+{self._x}+{self._y}")
        rebuild_geometry(W, H)

        self.canvas = tk.Canvas(self.root, width=W, height=H, bg=KEY,
                                highlightthickness=0, bd=0)
        self.canvas.pack(fill="both", expand=True)

        self._img = None
        self._last_frame = None
        self._bg = None
        self._hwnd = None
        self._excluded = False
        self._drag = None
        self._resize = None
        self._preview_at = 0.0
        self._geo_lock = threading.Lock()
        self._q = queue.Queue(maxsize=1)
        self._stop = threading.Event()
        self._pause = threading.Event()
        self._worker = threading.Thread(target=self._work, daemon=True)
        self._hz = display_hz()
        self._target_fps = min(MAX_FPS, self._hz)
        self._sig = None
        self._sig_bbox = None
        self._ema = 1.0 / max(1, self._target_fps)
        self._frames = 0
        self._text_items = []
        self._text_colors = {}
        self._text_shadows = {}
        self._color_at = 0.0
        self._aux_at = 0.0
        self._load_initial()
        self._build_ui()
        self._add_text_shadows()

        self.root.deiconify()
        self.root.update_idletasks()
        shadow_ids = {sid for ids in self._text_shadows.values() for sid in ids}
        self._text_items = [i for i in self.canvas.find_all()
                            if self.canvas.type(i) == "text"
                            and i not in shadow_ids]
        self._set_exclude(True)
        self._worker.start()
        self.root.lift()
        self.root.after(80, self.root.lift)
        self.root.after(120, self.root.focus_set)
        self.root.after(60, self._tick)
        self.root.after(250, self._poll_chat)
        if SNAPSHOT:
            self.root.after(2600, self._snapshot_mode)

    # ---- 真实聊天流 ----

    def _parse_geometry(self, geo):
        global W, H
        sw, sh = self._sw, self._sh
        w, h, x, y = W, H, max(40, sw - W - 80), max(40, (sh - H) // 2 - 40)
        try:
            size, rest = geo.split("+", 1)
            pw, ph = (int(v) for v in size.split("x"))
            px, py = (int(v) for v in rest.split("+")[:2])
            w = max(MIN_W, min(sw - 40, pw))
            h = max(MIN_H, min(sh - 40, ph))
            x = max(0, min(sw - w, px))
            y = max(0, min(sh - h, py))
        except Exception:
            pass
        W, H = w, h
        self._x, self._y = x, y

    def _load_initial(self):
        self.messages = []
        self._file_pos = 0
        try:
            lines = CHAT_FILE.read_text(encoding="utf-8").splitlines()[-80:]
            for line in lines:
                msg = self._parse_message(line)
                if msg:
                    self.messages.append(msg)
            self._file_pos = CHAT_FILE.stat().st_size
        except Exception:
            self._file_pos = 0
        self._file_size = self._file_pos
        self._msg_offset = 0

    @staticmethod
    def _parse_message(line):
        line = (line or "").strip()
        if not line:
            return None
        try:
            raw = json.loads(line)
        except Exception:
            return None
        text = raw.get("text")
        role = raw.get("role") or "assistant"
        # meta 行是宿主/麦克风状态（叫醒失败、录音状态），不是聊天内容；
        # 旧窗口把它们渲染成一屏失败提示，这里直接不进时间线。
        if role == "meta" or not isinstance(text, str) or not text:
            return None
        return {"role": role,
                "text": text,
                "stamp": clock(raw.get("at")) if raw.get("at") is not None else ""}

    def _poll_chat(self):
        try:
            self._sync_visible()
            if self._mic_proc is not None and self._mic_proc.poll() is not None:
                self._mic_proc = None
                self._status = ""
                self._refresh_feed()
            try:
                size = CHAT_FILE.stat().st_size
            except OSError:
                size = 0
            if size < self._file_pos:
                self._load_initial()
                self._refresh_feed()
            elif size > self._file_pos:
                new = []
                with open(CHAT_FILE, "r", encoding="utf-8") as f:
                    f.seek(self._file_pos)
                    data = f.read()
                    self._file_pos = f.tell()
                for line in data.splitlines():
                    msg = self._parse_message(line)
                    if msg:
                        new.append(msg)
                if new:
                    self.messages.extend(new)
                    self.messages = self.messages[-200:]
                    if self._msg_offset > 0:
                        self._msg_offset += len(new)
                    self._msg_offset = max(0, min(self._msg_offset, max(0, len(self.messages) - 1)))
                    self._refresh_feed()
            self._file_size = size
        except Exception as exc:
            print("chat poll error", exc, flush=True)
        if not self._stop.is_set():
            self._chat_after = self.root.after(250, self._poll_chat)

    def _sync_visible(self):
        try:
            st = CONFIG.stat()
            key = (st.st_mtime_ns, st.st_size)
        except OSError:
            key = None
        if key == self._cfg_key:
            return
        self._cfg_key = key
        want = bool(read_config().get("hidden"))
        if want == self._hidden:
            return
        self._hidden = want
        try:
            if want:
                self.root.withdraw()
            else:
                self.root.deiconify()
                self.root.attributes("-topmost", True)
                self.root.lift()
        except Exception:
            self._hidden = not want

    def _visible_messages(self):
        end = max(0, len(self.messages) - self._msg_offset)
        start = max(0, end - 4)
        return self.messages[start:end]

    def _refresh_feed(self):
        """聊天流变了就重画文字；Entry 的草稿和焦点要保住。"""
        if not hasattr(self, "canvas"):
            return
        self._build_ui()
        self._text_items = [i for i in self.canvas.find_all()
                            if self.canvas.type(i) == "text"]
        if self._last_frame is not None:
            try:
                self._img = ImageTk.PhotoImage(self._last_frame, master=self.canvas)
                self.canvas.itemconfigure(self._bg, image=self._img)
                self.canvas.tag_lower(self._bg)
                self._color_at = 0.0
                self._aux_at = 0.0
                self._adapt_text(self._last_frame)
                self._adapt_aux(self._last_frame)
            except Exception:
                pass
    def _send(self, _event=None):
        try:
            text = self.entry.get().strip()
        except Exception:
            return "break"
        if not text:
            return "break"
        try:
            append_user(text)
        except Exception as exc:
            self._status = f"写不进去：{exc}"
            self._refresh_feed()
            return "break"
        try:
            self.entry.delete(0, "end")
        except Exception:
            pass
        self._render_input()
        self.root.after(40, self._poll_chat)
        return "break"

    def _wheel(self, e):
        if not self.messages:
            return
        step = 1 if e.delta > 0 else -1
        self._msg_offset = max(0, min(len(self.messages) - 1, self._msg_offset + step))
        self._refresh_feed()

    def _toggle_mic(self):
        if self._mic_proc is not None and self._mic_proc.poll() is None:
            self._stop_mic()
            return
        if not MIC_SCRIPT.exists():
            self._status = "找不到 mic.py"
            self._refresh_feed()
            return
        try:
            self._mic_proc = subprocess.Popen(
                [asr_python(), str(MIC_SCRIPT), "--engine", "local"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                creationflags=0x08000000 if os.name == "nt" else 0,
            )
            self._status = "录音中"
        except Exception as exc:
            self._status = f"麦起不来：{exc}"
        self._refresh_feed()

    def _stop_mic(self):
        p = self._mic_proc
        self._mic_proc = None
        self._status = ""
        if p is not None and p.poll() is None:
            try:
                p.terminate()
            except Exception:
                pass
        self._refresh_feed()

    def _save_geometry(self):
        write_config({"geometry": f"{self.root.winfo_width()}x{self.root.winfo_height()}"
                                  f"+{self.root.winfo_x()}+{self.root.winfo_y()}"})

    def _hwnd_root(self):
        if self._hwnd is None:
            self._hwnd = ctypes.windll.user32.GetAncestor(self.root.winfo_id(), 2)
        return self._hwnd

    def _set_exclude(self, on):
        hwnd = self._hwnd_root()
        fn = ctypes.windll.user32.SetWindowDisplayAffinity
        fn.argtypes = [wintypes.HWND, wintypes.DWORD]
        fn.restype = wintypes.BOOL
        ok = bool(fn(hwnd, 0x11 if on else 0))
        self._excluded = ok and on
        if not ok:
            print("WDA failed", ctypes.GetLastError(), flush=True)

    def _bbox(self):
        hwnd = self._hwnd_root()
        rc = RECT()
        ctypes.windll.user32.GetWindowRect(hwnd, ctypes.byref(rc))
        return (rc.left, rc.top, rc.right, rc.bottom)

    def _capture(self, sct):
        l, t, r, b = self._bbox()
        if r <= l or b <= t:
            return None
        # 多抓一圈，边缘透镜才能取到“框外”的背景
        gl = max(0, l - PAD)
        gt = max(0, t - PAD)
        gr = min(self._sw, r + PAD)
        gb = min(self._sh, b + PAD)
        shot = sct.grab({"left": gl, "top": gt,
                         "width": gr - gl, "height": gb - gt})
        im = Image.frombytes("RGB", shot.size, shot.rgb)
        sw4, sh4 = max(2, (gr - gl) // 4), max(2, (gb - gt) // 4)
        # 60fps 路径：只在 1/4 分辨率做一次模糊和折射，再放大
        small_raw = im.resize((sw4, sh4), Image.Resampling.BILINEAR)
        small = small_raw.filter(ImageFilter.GaussianBlur(1.45))
        strong = small.filter(ImageFilter.GaussianBlur(2.6))
        arr = np.asarray(small)
        arr_raw = np.asarray(small_raw)
        arr_strong = np.asarray(strong)
        # 背景没变就不重新合成/上传，静态桌面时把 CPU 让出来
        sig = arr[::8, ::8].astype(np.int16).mean(axis=2)
        box = (gl, gt, gr, gb)
        if (not FORCE and self._sig is not None and box == self._sig_bbox
                and float(np.abs(sig - self._sig).mean()) < 0.18):
            self._sig = sig
            return None
        self._sig = sig
        self._sig_bbox = box
        px = int(round((l - gl) / 4.0))
        py = int(round((t - gt) / 4.0))
        sx = np.rint(WARP_X + px).astype(np.int32)
        sy = np.rint(WARP_Y + py).astype(np.int32)
        np.clip(sx, 0, arr.shape[1] - 1, out=sx)
        np.clip(sy, 0, arr.shape[0] - 1, out=sy)
        warped = arr[sy, sx]
        # 内部框：边缘折射 + 中心强模糊仍在 1/4 分辨率完成
        strong_panel = arr_strong[sy, sx]
        out_panel = warped.copy()
        for qx0, qy0, qw, qh, alpha, edge, bsx, bsy in BOX_MAPS:
            base_patch = warped[qy0:qy0 + qh, qx0:qx0 + qw]
            edge_patch = arr_raw[np.clip(bsy + py, 0, arr_raw.shape[0] - 1),
                                 np.clip(bsx + px, 0, arr_raw.shape[1] - 1)]
            strong_patch = strong_panel[qy0:qy0 + qh, qx0:qx0 + qw]
            patch = np.where(edge[..., None], edge_patch, strong_patch)
            a = alpha[..., None]
            out_panel[qy0:qy0 + qh, qx0:qx0 + qw] = (
                base_patch * (1.0 - a) + patch * a)
        # 1/4 透镜结果放大后，用全分辨率联合圆角遮罩贴回；
        # 边界是 PIL 4x 超采样遮罩，不再有 1/4 放大的像素台阶。
        # 2x 合成：比全分辨率轻，比 1/4 明显平滑，兼顾帧率和圆角
        base_2x = Image.fromarray(warped).resize(
            (HW, HH), Image.Resampling.BILINEAR)
        lens_2x = Image.fromarray(out_panel).resize(
            (HW, HH), Image.Resampling.BILINEAR)
        panel = Image.composite(lens_2x, base_2x, BOX_UNION_2X)
        panel = Image.alpha_composite(
            panel.convert("RGBA"), OVERLAY_2X).convert("RGB")
        # 麦克风图标：先回到全分辨率再贴，避免坐标落在 2x 画布外
        out = panel.convert("RGB").resize((W, H), Image.Resampling.BILINEAR)
        mic_box = out.crop((MIC_POS[0], MIC_POS[1],
                            MIC_POS[0] + 28, MIC_POS[1] + 28)).convert("L")
        mic_bg = float(np.median(np.asarray(mic_box))) / 255.0
        out = out.convert("RGBA")
        icon = MIC_LIGHT if mic_bg < 0.48 else MIC_DARK
        out.paste(icon, MIC_POS, icon)
        return finish(out.convert("RGB"))

    def _work(self):
        """抓取 + 模糊 + 合成全在后台，主线程只负责显示最新一帧。"""
        idle = 0
        with mss.MSS() as sct:
            while not self._stop.is_set():
                if self._pause.is_set():
                    time.sleep(0.03)
                    continue
                t0 = time.perf_counter()
                try:
                    with self._geo_lock:
                        out = self._capture(sct)
                    if out is not None:
                        idle = 0
                        try:
                            self._q.get_nowait()
                        except queue.Empty:
                            pass
                        self._q.put(out)
                    else:
                        idle += 1
                except Exception as exc:
                    print("capture error", exc, flush=True)
                dt = time.perf_counter() - t0
                self._ema = self._ema * 0.9 + dt * 0.1
                if FORCE:
                    self._target_fps = MAX_FPS
                elif self._ema > 0.026:
                    self._target_fps = 45
                elif self._ema > 0.016:
                    self._target_fps = 60
                elif self._ema > 0.011:
                    self._target_fps = 90
                else:
                    self._target_fps = min(MAX_FPS, self._hz)
                # 静态画面：跳过合成，但保留 60fps 探针，变化后 ~16ms 内响应
                if idle > 20:
                    time.sleep(max(0.016, 1 / max(1, self._target_fps) - dt))
                else:
                    time.sleep(max(0.0, 1 / max(1, self._target_fps) - dt))

    def _text(self, x, y, text, anchor="center", fill="#f2f8ff",
              font=None, max_width=None, tags=()):
        """按字符拆成 Canvas 文本；每个字单独适配背后的明暗。"""
        fobj = tkfont.Font(root=self.root, font=font)
        measure = fobj.measure
        linespace = fobj.metrics("linespace")
        if max_width is not None:
            lines, cur = [], ""
            for ch in text:
                if not cur or measure(cur + ch) <= max_width:
                    cur += ch
                else:
                    lines.append(cur)
                    cur = ch
            lines.append(cur)
        else:
            lines = [text]
        top_anchor = anchor in ("n", "nw", "ne")
        right_anchor = anchor in ("e", "ne", "se")
        center_anchor = anchor in ("center", "n", "s")
        height = fobj.metrics("ascent") + fobj.metrics("descent")
        for i, line in enumerate(lines):
            lw = measure(line)
            if right_anchor:
                lx = x - lw
            elif center_anchor:
                lx = x - lw / 2
            else:
                lx = x
            if top_anchor:
                ly = y + i * linespace + height / 2
            else:
                ly = y + (i - (len(lines) - 1) / 2) * linespace
            for i, ch in enumerate(line):
                cx = lx + measure(line[:i])
                self.canvas.create_text(cx, ly, text=ch, anchor="w",
                                        fill=fill, font=font, tags=tags)

    def _render_input(self):
        """输入文字画在 Canvas 上；隐藏 Entry 只负责 IME/键盘。"""
        if not hasattr(self, "entry") or self.entry is None:
            return
        c = self.canvas
        c.delete("inputtext", "inputcursor")
        try:
            text = self.entry.get()
            focused = self.root.focus_get() is self.entry
        except Exception:
            text, focused = "", False
        x0, y0, x1, y1, _r = SHAPES[4]
        x, y = x0 + 84, y0 + 27
        maxw = max(60, x1 - x0 - 100)
        if not text and not focused:
            self._text(x, y, "在这里跟它说话…", anchor="w",
                       fill="#8e9db2", font=f(11),
                       tags=("inputtext", "inputzone"))
        elif text:
            fobj = tkfont.Font(root=self.root, font=f(11))
            while text and fobj.measure(text) > maxw:
                text = text[1:]
            self._text(x, y, text, anchor="w", fill="#eef6ff",
                       font=f(11), tags=("inputtext", "inputzone"))
            if focused:
                cx = x + fobj.measure(text)
                c.create_line(cx + 1, y - 9, cx + 1, y + 9,
                              fill="#b9d7ff", width=1, tags=("inputcursor",))
        elif focused:
            c.create_line(x + 1, y - 9, x + 1, y + 9,
                          fill="#b9d7ff", width=1, tags=("inputcursor",))
        self._text_items = [i for i in c.find_all() if c.type(i) == "text"]

    def _on_input_key(self, _e=None):
        self._render_input()
        return None

    def _focus_input(self, _e=None):
        try:
            # 用户已经点了输入区，这里可以抢焦点；启动时仍然不抢系统焦点
            self.entry.focus_force()
            self.entry.icursor("end")
        except Exception:
            pass
        self._render_input()

    def _build_ui(self):
        c = self.canvas
        old_text, old_focus, old_cursor = "", False, 0
        try:
            if getattr(self, "entry", None) is not None:
                old_text = self.entry.get()
                old_cursor = self.entry.index("insert")
                old_focus = self.root.focus_get() is self.entry
                self.entry.destroy()
        except Exception:
            pass
        self.entry = None
        # 背景图 item 先建，后续文字都在它上面
        self._bg = c.create_image(0, 0, anchor="nw")
        if PREVIEW:
            c.create_rectangle(0, 0, W, H, fill="#0d131d", outline="",
                               tags=("preview-bg",))
            c.tag_lower("preview-bg")

        w, h = W, H
        name = self.name[:10]
        self._text(76, 54, name, anchor="w", fill="#f7fbff",
                   font=f(21, True))
        count = self._status or f"{len(self.messages)} 条"
        self._text(176, 54, count, anchor="w", fill="#dbe6f5",
                   font=f(11))
        # 右上角按钮跟随窗口宽度内收
        self._text(w - 94, 38, "▾", anchor="w",
                   fill="#7f8da3", font=f(12), tags=("collapse",))
        self._text(w - 58, 38, "✕", anchor="w", fill="#9fb0c8",
                   font=f(13), tags=("close",))

        ys = [s[1] for s in SHAPES[:4]]
        bh = SHAPES[0][3] - SHAPES[0][1]
        shown = self._visible_messages()
        # 小窗口不放时间戳，避免和压缩后的气泡文字重叠
        if h >= 560:
            for i, msg in enumerate(shown):
                if msg.get("stamp"):
                    self._text(72, ys[i] - 20, msg["stamp"], anchor="nw",
                               fill="#a8b7c9", font=f(9))

        # 可见的最近 4 条；滚轮往前翻时整体换页
        for i, msg in enumerate(shown):
            x0, y0, x1, _y1, _r = SHAPES[i]
            self._text(x0 + 26, y0 + bh // 2, msg["text"], anchor="w",
                       max_width=max(120, x1 - x0 - 52),
                       fill="#edf6ff", font=f(14))
        if not shown:
            self._text(w // 2, SHAPES[0][1] + bh // 2,
                       "在这里跟它说话 · 滚轮翻历史", anchor="center",
                       fill="#8e9db2", font=f(12))

        # 输入：Entry 只做 IME/键盘的背面接收器，放到 2x2 且底色是键色，
        # 真正显示的文字画在 Canvas 上 —— 否则玻璃里会出现一个突兀的黑条。
        x0, y0, x1, y1, _r = SHAPES[4]
        self.entry = tk.Entry(self.root, bg=KEY, fg=KEY, insertbackground=KEY,
                              relief="flat", bd=0, font=f(11), insertwidth=0,
                              highlightthickness=0)
        self._entry_item = c.create_window(
            x0 + 84, y0 + 27, window=self.entry, anchor="w",
            width=2, height=2)
        self.entry.bind("<KeyRelease>", self._on_input_key)
        self.entry.bind("<Return>", self._send)
        self.entry.bind("<FocusIn>", lambda _e: self._render_input())
        self.entry.bind("<FocusOut>", lambda _e: self._render_input())
        if old_text:
            self.entry.insert(0, old_text)
            self.entry.icursor(min(old_cursor, len(old_text)))
        if old_focus:
            self.entry.focus_set()
        self._render_input()

        x0, y0, x1, y1, _r = SHAPES[5]
        self._text((x0 + x1) // 2, y0 + 27, "发送", tags=("send",),
                   fill="#ffffff", font=f(12, True))

        # 最上面正中的细条，长度随窗口宽度走
        self._bar_len = max(72, int(w * BAR_FRAC))
        self._bar = c.create_line(w // 2 - self._bar_len // 2, BAR_Y,
                                  w // 2 + self._bar_len // 2, BAR_Y,
                                  width=BAR_THICK, fill="#b8cbe0",
                                  capstyle="round")

        c.tag_bind("close", "<Button-1>", self._close)
        c.tag_bind("send", "<Button-1>", self._send)
        c.tag_bind("collapse", "<Button-1>", self._hide_window)
        c.tag_bind("inputzone", "<Button-1>", self._focus_input)
        c.tag_raise("close")
        c.tag_raise("send")

    def _preview_resize(self, w, h):
        """拖拽时先缩放上一帧并重排文字，松手后再重建玻璃贴图。"""
        global W, H, SHAPES, MIC_POS
        W, H = w, h
        SHAPES = shapes_for(w, h)
        MIC_POS = (53, h - 67)
        self.canvas.config(width=w, height=h)
        self.canvas.delete("all")
        self._img = None
        self._bg = None
        self._text_items = []
        self._text_colors = {}
        self._text_shadows = {}
        self._build_ui()
        self._add_text_shadows()
        shadow_ids = {sid for ids in self._text_shadows.values() for sid in ids}
        self._text_items = [i for i in self.canvas.find_all()
                            if self.canvas.type(i) == "text"
                            and i not in shadow_ids]
        if self._last_frame is not None:
            preview = self._last_frame.resize(
                (w, h), Image.Resampling.BILINEAR)
            self._img = ImageTk.PhotoImage(preview, master=self.canvas)
            self.canvas.itemconfigure(self._bg, image=self._img)
            self.canvas.tag_lower(self._bg)
            # 预览期间也立刻按新背景选字色，不等松手
            self._color_at = 0.0
            self._aux_at = 0.0
            self._adapt_text(preview)
            self._adapt_aux(preview)

    def _rebuild(self, w, h):
        """按新窗口尺寸重建玻璃贴图和全部 Canvas 控件。"""
        self._pause.set()
        with self._geo_lock:
            rebuild_geometry(w, h)
        self.canvas.config(width=w, height=h)
        self.canvas.delete("all")
        self._img = None
        self._bg = None
        self._text_items = []
        self._text_colors = {}
        self._text_shadows = {}
        self._color_at = 0.0
        self._aux_at = 0.0
        self._sig = None
        self._sig_bbox = None
        self._build_ui()
        self._add_text_shadows()
        shadow_ids = {sid for ids in self._text_shadows.values() for sid in ids}
        self._text_items = [i for i in self.canvas.find_all()
                            if self.canvas.type(i) == "text"
                            and i not in shadow_ids]
        while True:
            try:
                self._q.get_nowait()
            except queue.Empty:
                break
        if self._last_frame is not None:
            seed = self._last_frame.resize(
                (w, h), Image.Resampling.BILINEAR)
            self._img = ImageTk.PhotoImage(seed, master=self.canvas)
            self.canvas.itemconfigure(self._bg, image=self._img)
            self.canvas.tag_lower(self._bg)
            self._color_at = 0.0
            self._aux_at = 0.0
            self._adapt_text(seed)
            self._adapt_aux(seed)
        self._pause.clear()

    def _add_text_shadows(self):
        """不再叠偏移描边；之前四向黑影会看起来像重影。"""
        self._text_shadows = {}

    def _adapt_text(self, out):
        """按文字背后的暗部/亮部比例选色，并同步描边颜色。"""
        now = time.time()
        if now - self._color_at < 0.12:
            return
        self._color_at = now
        for item in self._text_items:
            box = self.canvas.bbox(item)
            if not box:
                continue
            x0, y0, x1, y1 = box
            x0, y0 = max(0, x0 - 2), max(0, y0 - 2)
            x1, y1 = min(W, x1 + 2), min(H, y1 + 2)
            if x1 <= x0 or y1 <= y0:
                continue
            gray = np.asarray(out.crop((x0, y0, x1, y1)).convert("L"))
            p50 = float(np.percentile(gray, 50)) / 255.0
            dark = float(np.mean(gray < 107))
            light = float(np.mean(gray > 158))
            # 先看这块背景是偏暗还是偏亮，混合区域再退回中位亮度
            if dark > light + 0.08:
                color = "#f2f8ff"
            elif light > dark + 0.08:
                color = "#07111d"
            elif p50 < 0.50:
                color = "#f2f8ff"
            else:
                color = "#07111d"
            if color != self._text_colors.get(item):
                self.canvas.itemconfigure(item, fill=color)
                self._text_colors[item] = color

    def _adapt_aux(self, out):
        """最上面细条随背景切换深浅。"""
        now = time.time()
        if now - self._aux_at < 0.25:
            return
        self._aux_at = now
        mid = W // 2
        half = max(50, self._bar_len // 2)
        bar = np.asarray(out.crop(
            (mid - half, BAR_Y - 6, mid + half, BAR_Y + 12)).convert("L"))
        p50 = float(np.median(bar)) / 255.0
        bar_fill = "#b8cbe0" if p50 < 0.48 else "#4e6278"
        self.canvas.itemconfigure(self._bar, fill=bar_fill)



    def _snapshot_mode(self):
        """只给文档截图：停抓取、关 WDA，保留最后一帧（不改变正常路径）。"""
        self._pause.set()
        if self._excluded:
            self._set_exclude(False)

    def _tick(self):
        if PREVIEW:
            self._pause.set()
            if self._excluded:
                self._set_exclude(False)
            self.root.after(100, self._tick)
            return
        # 缩放拖拽期间由 _preview_resize 负责画面，避免旧帧覆盖预览
        if self._resize:
            self.root.after(INTERVAL_MS, self._tick)
            return
        if not self._excluded:
            self._set_exclude(True)
        self._pause.clear()

        try:
            out = self._q.get_nowait()
        except queue.Empty:
            out = None
        if out is not None:
            try:
                self._last_frame = out
                self._img = ImageTk.PhotoImage(out, master=self.canvas)
                self.canvas.itemconfigure(self._bg, image=self._img)
                self.canvas.tag_lower(self._bg)
                self._adapt_text(out)
                self._adapt_aux(out)
            except Exception as exc:
                print("draw error", exc, flush=True)

        self.root.after(INTERVAL_MS, self._tick)

    def _close(self, _e=None):
        try:
            self._save_geometry()
            if self._chat_after is not None:
                try:
                    self.root.after_cancel(self._chat_after)
                except Exception:
                    pass
            self._stop_mic()
            self._stop.set()
            self._pause.set()
            self._set_exclude(False)
            self._worker.join(timeout=0.3)
            ctypes.windll.winmm.timeEndPeriod(1)
        finally:
            self.root.destroy()
        return "break"

    def _hide_window(self, _e=None):
        """藏起来但继续收消息；插件写 hidden=false 后会重新出现。"""
        write_config({"hidden": True})
        self._hidden = True
        self.root.withdraw()
        return "break"

    # 边缘缩放 / 窗口拖动
    def _edge_at(self, x, y):
        w, h = self.root.winfo_width(), self.root.winfo_height()
        edge, corner = 10, 26
        # 圆角区域是透明的，命中区要往内收够，才能点到可见的角
        if x <= corner and y <= corner:
            return "nw"
        if x >= w - corner and y <= corner:
            return "ne"
        if x <= corner and y >= h - corner:
            return "sw"
        if x >= w - corner and y >= h - corner:
            return "se"
        # 顶部中间只拖动，不缩放；四角仍然可同时调宽高
        if y <= edge:
            return None
        if x <= edge:
            return "w"
        if x >= w - edge:
            return "e"
        if y >= h - edge:
            return "s"
        return None

    def _cursor_for(self, mode):
        return {
            "nw": "size_nw_se", "se": "size_nw_se",
            "ne": "size_ne_sw", "sw": "size_ne_sw",
            "w": "size_we", "e": "size_we",
            "n": "size_ns", "s": "size_ns",
        }.get(mode, "")

    def _hover(self, e):
        if self._resize:
            return
        try:
            self.canvas.config(cursor=self._cursor_for(self._edge_at(e.x, e.y)))
        except Exception:
            pass

    def _leave(self, _e):
        if not self._resize:
            self.canvas.config(cursor="")

    def _press(self, e):
        # 麦克风图标是画在玻璃里的，不在 Canvas 上单独建控件；点它不能当拖窗
        if abs(e.x - (MIC_POS[0] + 14)) <= 22 and abs(e.y - (MIC_POS[1] + 14)) <= 22:
            self._toggle_mic()
            return
        x0, y0, x1, y1, _r = SHAPES[4]
        if x0 <= e.x <= x1 and y0 <= e.y <= y1:
            self._focus_input()
            return
        mode = self._edge_at(e.x, e.y)
        if mode:
            self._resize = (mode, e.x_root, e.y_root,
                            self.root.winfo_x(), self.root.winfo_y(),
                            self.root.winfo_width(), self.root.winfo_height())
            self._drag = None
            self._pause.set()
            return
        self._drag = (e.x_root - self.root.winfo_x(),
                      e.y_root - self.root.winfo_y())

    def _motion(self, e):
        if self._resize:
            mode, sx, sy, x0, y0, w0, h0 = self._resize
            dx, dy = e.x_root - sx, e.y_root - sy
            nw, nh, nx, ny = w0, h0, x0, y0
            if "e" in mode:
                nw = max(MIN_W, min(max(MIN_W, self._sw - x0), w0 + dx))
            if "w" in mode:
                nw = max(MIN_W, min(max(MIN_W, x0 + w0), w0 - dx))
                nx = x0 + w0 - nw
            if "s" in mode:
                nh = max(MIN_H, min(max(MIN_H, self._sh - y0), h0 + dy))
            if "n" in mode:
                nh = max(MIN_H, min(max(MIN_H, y0 + h0), h0 - dy))
                ny = y0 + h0 - nh
            nx = max(0, min(nx, max(0, self._sw - nw)))
            ny = max(0, min(ny, max(0, self._sh - nh)))
            self.root.geometry(f"{nw}x{nh}+{nx}+{ny}")
            now = time.time()
            if now - self._preview_at >= 0.04:
                self._preview_at = now
                self._preview_resize(nw, nh)
            return
        if self._drag:
            self.root.geometry(f"+{e.x_root - self._drag[0]}+{e.y_root - self._drag[1]}")

    def _release(self, e):
        if self._resize:
            self._resize = None
            self._preview_at = 0.0
            self.root.update_idletasks()
            w = max(MIN_W, self.root.winfo_width())
            h = max(MIN_H, self.root.winfo_height())
            self._rebuild(w, h)
            self._hover(e)
            return
        self._drag = None

    def run(self):
        self.root.bind("<Escape>", self._close)
        self.root.bind("<MouseWheel>", self._wheel)
        self.root.bind("<Motion>", self._hover, add="+")
        self.root.bind("<Leave>", self._leave, add="+")
        self.root.bind("<ButtonPress-1>", self._press, add="+")
        self.root.bind("<B1-Motion>", self._motion, add="+")
        self.root.bind("<ButtonRelease-1>", self._release, add="+")
        self.root.mainloop()


if __name__ == "__main__":
    LiveGlass().run()
