"""check-multimonitor.py — 多显示器钳位的回归（不需要第二块显示器）。

跑法（仓库根）：

    python scripts/check-multimonitor.py

覆盖两件事：

1. **单屏等价**：窗口整个在主屏里时，`CaptureSource._clamp_box` 必须和改之前
   逐像素一致（`max(0, l-PAD)` / `min(sw, r+PAD)`）。多屏支持不能把单屏观感改坏。
2. **副屏可用**：副屏在主屏左边（坐标为负）时，钳位后必须仍有正面积 ——
   旧公式会算出 `gr <= gl` → 玻璃永远停在旧帧（#8）。
"""

from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "examples" / "floating-chat"))

from glass_capture import CaptureSource  # noqa: E402

PAD = 40
SW, SH = 2560, 1440
# 副屏在主屏左边：虚拟桌面从 (-1920, 0) 开始，宽 1920+2560
LEFT_BOUNDS = (-1920, 0, 1920 + SW, SH)

failures: list[str] = []


def legacy_clamp(l, t, r, b, sw=SW, sh=SH, pad=PAD):
    """改动前的实现，作为等价性基准。"""
    return max(0, l - pad), max(0, t - pad), min(sw, r + pad), min(sh, b + pad)


def check(name, got, want):
    if got != want:
        failures.append(f"{name}: got {got} want {want}")


def test_single_screen_identical():
    src = CaptureSource((SW, SH))
    for l in range(-200, SW + 200, 137):
        for t in range(-200, SH + 200, 151):
            for w in (80, 420, 900):
                for h in (78, 300, 700):
                    r, b = l + w, t + h
                    # 只比较"窗口矩形完全落在主屏内"的那部分：外面本来就该钳，
                    # 旧实现钳到 0 之后可能小于窗口矩形，语义不同
                    if not (0 <= l and 0 <= t and r <= SW and b <= SH):
                        continue
                    check(f"single {l},{t},{w},{h}",
                          src._clamp_box(l, t, r, b), legacy_clamp(l, t, r, b))


def test_second_screen_left():
    src = CaptureSource((SW, SH), bounds=LEFT_BOUNDS)
    # 窗口整个在左副屏上（x 为负）
    l, t, w, h = -1500, 300, 420, 320
    gl, gt, gr, gb = src._clamp_box(l, t, l + w, t + h)
    if not (gr > gl and gb > gt):
        failures.append(f"left screen produced empty box: {(gl, gt, gr, gb)}")
    check("left screen left edge", gl, l - PAD)   # 外扩一圈仍在虚拟桌面内
    check("left screen right edge", gr, l + w + PAD)
    check("left screen top", gt, t - PAD)


def test_spanning_both_screens():
    src = CaptureSource((SW, SH), bounds=LEFT_BOUNDS)
    # 跨屏：从 -300 到 500
    l, t, r, b = -300, 200, 500, 600
    gl, gt, gr, gb = src._clamp_box(l, t, r, b)
    if not (gr > gl and gb > gt):
        failures.append(f"spanning produced empty box: {(gl, gt, gr, gb)}")
    check("spanning left", gl, -340)
    check("spanning right", gr, 540)


def test_no_bounds_still_works():
    # bounds=None（老调用方 / 单屏）：行为与改动前一致
    src = CaptureSource((SW, SH), bounds=None)
    check("no bounds", src._clamp_box(100, 100, 500, 500), legacy_clamp(100, 100, 500, 500))


def main() -> int:
    test_single_screen_identical()
    test_second_screen_left()
    test_spanning_both_screens()
    test_no_bounds_still_works()
    if failures:
        print(f"FAIL ({len(failures)})")
        for line in failures[:20]:
            print("  " + line)
        return 1
    print("OK — 单屏逐像素等价，副屏/跨屏都有正面积")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
