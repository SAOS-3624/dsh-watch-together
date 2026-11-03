"""glass_capture.py — 抓屏、运动判定、所有渲染路径共用的收尾。

CPU 与 GPU 两条管线以前各写一份「抓屏 → 算静态签名 → 判断要不要重合成 →
贴麦克风 → 贴圆角遮罩」，于是同一个 bug 要修两遍（#39、#48 都是这么来的：
CPU 修了，GPU 漏了）。这里把它们收成一套：

- `CaptureSource.grab()`：窗口矩形外扩 PAD、钳位、守卫零尺寸；
- `MotionTracker.observe()`：返回 `(moved, stale)`，**两个判断一次算完**，
  不会再出现「拖动窗口算不算动」这种两边理解不一致；
- `finish()` / `paste_mic()`：两条路径的最后两步。

渲染器只负责「一张图 → 一张图」，其余都在这里。
"""
from __future__ import annotations

import os
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image

from glass_geometry import KEY, LPF, MIC_MARGIN, MIC_SIZE, PAD, Geometry

try:
    import cv2 as _cv2
except Exception:      # OpenCV 只是加速，缺了仍走 PIL
    _cv2 = None

HERE = Path(__file__).resolve().parent

# 静态跳帧：像素差超过这个就算「动了」
SIG_STEP = 4                      # 采样步长（像素）
MOVE_MEAN = 0.01                  # 平均差阈值（0~255）
MOVE_MAX = 0.5                    # 单点最大差阈值
STALE_AFTER = 0.30                # 运动结束后多久允许跳帧

FORCE = os.environ.get("GLASS_FORCE") == "1"


def _load_mic() -> tuple[Image.Image, Image.Image]:
    """麦克风图标：去背景得到 alpha，再做浅色/深色两版（按背后亮度挑）。"""
    try:
        mask = Image.open(HERE / "mic-dsh.png").convert("L")
        mask = mask.resize((MIC_SIZE, MIC_SIZE), Image.Resampling.LANCZOS)
    except Exception:
        mask = Image.new("L", (MIC_SIZE, MIC_SIZE), 200)
    light = Image.new("RGBA", mask.size, (235, 244, 255, 0))
    light.putalpha(mask)
    dark = Image.new("RGBA", mask.size, (24, 48, 72, 0))
    dark.putalpha(mask)
    return light, dark


MIC_LIGHT, MIC_DARK = _load_mic()


def resample(arr_or_im, size):
    """缩放一张图（两个方向都用）；有 OpenCV 走 OpenCV，比 PIL 快一个数量级。"""
    if _cv2 is not None:
        src = np.asarray(arr_or_im)
        return _cv2.resize(src, size, interpolation=_cv2.INTER_LINEAR)
    im = arr_or_im if isinstance(arr_or_im, Image.Image) else Image.fromarray(arr_or_im)
    return np.asarray(im.resize(size, Image.Resampling.BILINEAR))


def fill_own_rect(im: Image.Image, box) -> Image.Image:
    """录屏模式下把「窗口自己」在抓屏帧里占的那块填掉。

    `capturable: true` 会关掉 WDA，于是 mss 抓背景时把窗口也抓进来，玻璃拿它
    当背景就是「透过自己看自己」：背景里带着上一帧的字 → 亮度判据一直抖 →
    字色来回翻；背景一直在变 → `moved` 恒真 → 越滚越浓的假拖尾。

    填法：取这块上下各一行像素做纵向线性插值，得到一片像磨砂玻璃透出的环境色，
    没有细节也不会带自己的内容。窗口外 PAD 一圈仍是真背景，边缘透镜照常取料。
    """
    x0, y0, x1, y1 = (int(v) for v in box)
    arr = np.asarray(im)
    h, w = arr.shape[:2]
    x0, x1 = max(1, min(w - 1, x0)), max(1, min(w - 1, x1))
    y0, y1 = max(1, min(h - 2, y0)), max(1, min(h - 2, y1))
    n = y1 - y0
    if x1 <= x0 or n <= 0:
        return im
    out = arr.copy()
    top = arr[y0 - 1, x0:x1].astype(np.float32)
    bot = arr[y1, x0:x1].astype(np.float32)
    t = ((np.arange(n, dtype=np.float32) + 1.0) / (n + 1.0))[:, None, None]
    out[y0:y1, x0:x1] = np.clip(
        top[None, :, :] * (1.0 - t) + bot[None, :, :] * t, 0, 255).astype(np.uint8)
    return Image.fromarray(out)


def fill_own_rect_array(arr: np.ndarray, box) -> None:
    """`fill_own_rect` 的原地版本，给直接吃 `shot.bgra` 的 GPU 路径用。

    GPU 不经过 PIL，如果漏了这一步，抓到的背景里永远有自己 —— 每帧都在变，
    静态跳帧一次都不会触发，还叠出自我反馈的拖尾。
    """
    x0, y0, x1, y1 = (int(v) for v in box)
    h, w = arr.shape[:2]
    x0, x1 = max(1, min(w - 1, x0)), max(1, min(w - 1, x1))
    y0, y1 = max(1, min(h - 2, y0)), max(1, min(h - 2, y1))
    n = y1 - y0
    if x1 <= x0 or n <= 0:
        return
    top = arr[y0 - 1, x0:x1].astype(np.float32)
    bot = arr[y1, x0:x1].astype(np.float32)
    t = ((np.arange(n, dtype=np.float32) + 1.0) / (n + 1.0))[:, None, None]
    arr[y0:y1, x0:x1] = np.clip(
        top[None, :, :] * (1.0 - t) + bot[None, :, :] * t, 0, 255).astype(np.uint8)


class MotionTracker:
    """静态跳帧 + 运动强度，两条渲染路径共用。

    语义（和 0.2.9 修过的 CPU 行为一致）：

    - **抓取区域变了就算动**。拖动窗口时 `box` 每帧都不同，旧区域的像素本来
      也不能直接做差；不标 `moved` 的话，拖动全程都走「没在动」分支 ——
      运动模糊一路衰减到 0、反而每帧去做静止才该做的色散。这就是 #48。
    - 静止超过 `STALE_AFTER` 就允许跳帧（`stale=True`），省掉整条合成；
    - `motion` 是 0~1 的平滑值，只有移动帧才拿它去混上一帧。
    """

    def __init__(self, force: bool = FORCE):
        self.force = force
        self.motion = 0.0
        self._sig: np.ndarray | None = None
        self._bbox = None
        self._last_motion = 0.0

    def invalidate(self) -> None:
        """形状/尺寸变了：旧签名和旧背景都不能再用。"""
        self._sig = None
        self._bbox = None
        self._last_motion = 0.0
        self.motion = 0.0

    def observe(self, small_rgb: np.ndarray, box, now: float | None = None):
        """`small_rgb` 是未模糊的 1/4 采样图。返回 `(moved, stale)`。"""
        now = time.perf_counter() if now is None else now
        sig = small_rgb[::SIG_STEP, ::SIG_STEP].astype(np.int16).mean(axis=2)
        moved = False
        if self._bbox is not None and box != self._bbox:
            moved = True
        elif self._sig is not None and sig.shape == self._sig.shape:
            d = np.abs(sig - self._sig)
            moved = bool(float(d.mean()) > MOVE_MEAN or float(d.max()) > MOVE_MAX)
        if moved:
            self._last_motion = now
            self.motion = min(1.0, self.motion * 0.50 + 0.50)
        else:
            self.motion *= 0.55
        stale = (not self.force and not moved and box == self._bbox
                 and now - self._last_motion > STALE_AFTER)
        self._sig = sig
        self._bbox = box
        return moved, stale

    @property
    def blend(self) -> float:
        """移动帧混上一帧的强度；停下后立刻归零，不留残影。"""
        return 0.35 * max(0.0, min(1.0, self.motion))


@dataclass(slots=True)
class Shot:
    """一次抓屏的结果。CPU 用 `rgb`，GPU 用 `bgra`，避免重复抓。"""

    shot: object            # mss 的 ScreenShot
    box: tuple              # 屏幕坐标 (gl, gt, gr, gb)
    offset: tuple           # 窗口左上角在抓屏图里的 1/4 分辨率坐标


class CaptureSource:
    """按窗口矩形抓背景，外扩 PAD 供边缘透镜取「框外」的像素。"""

    def __init__(self, screen: tuple[int, int], pad: int = PAD, cappable: bool = False):
        self.screen = screen
        self.pad = pad
        self.cappable = cappable

    def grab(self, sct, bbox) -> Shot | None:
        l, t, r, b = (int(v) for v in bbox)
        if r <= l or b <= t:
            return None
        sw, sh = self.screen
        gl = max(0, l - self.pad)
        gt = max(0, t - self.pad)
        gr = min(sw, r + self.pad)
        gb = min(sh, b + self.pad)
        # 多显示器 / DPI 变化 / 被别的程序挪出屏幕时，钳位后宽高可能 <= 0；
        # mss 会抛 "Region has zero or negative size"，而 _work() 会每帧吞掉它
        # —— 表现就是日志刷屏、背景永久停在旧帧。没有可抓的区域就别抓。
        if gr - gl <= 0 or gb - gt <= 0:
            return None
        shot = sct.grab({"left": gl, "top": gt, "width": gr - gl, "height": gb - gt})
        return Shot(shot=shot, box=(gl, gt, gr, gb),
                    offset=(int(round((l - gl) / LPF)), int(round((t - gt) / LPF))))

    def to_image(self, shot: Shot, bbox) -> Image.Image:
        """抓屏帧 → RGB 图；录屏模式下先把自己挖掉。"""
        im = Image.frombytes("RGB", shot.shot.size, shot.shot.rgb)
        if self.cappable:
            l, t, r, b = (int(v) for v in bbox)
            gl, gt = shot.box[0], shot.box[1]
            im = fill_own_rect(im, (l - gl, t - gt, r - gl, b - gt))
        return im

    def own_rect(self, shot: Shot, bbox) -> tuple[int, int, int, int]:
        gl, gt = shot.box[0], shot.box[1]
        l, t, r, b = bbox
        return (l - gl, t - gt, r - gl, b - gt)


def finish(geo: Geometry, panel: Image.Image) -> Image.Image:
    """贴二值圆角遮罩；缝隙/圆角外是 KEY，被 Tk 抠成透明。"""
    out = Image.new("RGB", (geo.width, geo.height), KEY)
    out.paste(panel.convert("RGB"), (0, 0), geo.mask_hard)
    return out


def paste_mic(geo: Geometry, im: Image.Image) -> Image.Image:
    """麦克风图标贴进玻璃帧，按背后亮度选浅/深两版（和仓库原做法一致）。"""
    x, y = geo.mic_pos
    box = im.crop((x, y, x + MIC_SIZE, y + MIC_SIZE)).convert("L")
    bg = float(np.median(np.asarray(box))) / 255.0
    out = im.convert("RGBA")
    icon = MIC_LIGHT if bg < 0.48 else MIC_DARK
    out.paste(icon, (x, y), icon)
    return out.convert("RGB")


__all__ = [
    "CaptureSource", "FORCE", "MIC_DARK", "MIC_LIGHT", "MotionTracker", "Shot",
    "fill_own_rect", "finish", "paste_mic", "resample",
]
