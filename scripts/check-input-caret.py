"""check-input-caret.py — 输入框光标的回归（不需要真的开窗）。

跑法（仓库根）：

    python scripts/check-input-caret.py

覆盖两件事：

1. **光标跟着插入点走**：`LiveGlass._visible_input` 要以插入点为锚点开窗，
   并把插入点换算成可见段里的下标。旧实现只从左边砍（`text = text[1:]`），
   光标恒在末尾 —— 左右键移动时画面上那条线根本不动（#20 的同一处输入框）。
2. **右边留余量**：插入点不在原文末尾时，可见段右端必须比插入点再多几个字符，
   否则往左移动时光标一直贴着右缘，看不出右边还有内容。

`_visible_input` 只用到 `self.fonts.get(11).measure`，所以这里拿一个等宽假字体
注入，边界值可以手算核对，不需要 Tk、不需要显示器。
"""

from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "examples" / "floating-chat"))

CHAR_W = 10         # 假字体：每个字符固定 10px，断言才能手算

failures: list[str] = []


class FakeFont:
    def measure(self, s):
        return len(s) * CHAR_W


class FakeFonts:
    def get(self, _size, _bold=False):
        return FakeFont()


def check(name, cond, detail=""):
    if not cond:
        failures.append(f"{name}{(': ' + detail) if detail else ''}")


def visible_input(text, maxw, caret):
    """调真实实现：只绑 fonts，其余属性都用不到。"""
    from window import LiveGlass

    stub = object.__new__(LiveGlass)
    stub.fonts = FakeFonts()
    return LiveGlass._visible_input(stub, text, maxw, caret)


def legacy_visible(text, maxw):
    """改动前的实现，作为对照：只从左边砍，光标恒在末尾。"""
    font = FakeFont()
    while text and font.measure(text) > maxw:
        text = text[1:]
    return text


def test_caret_stays_visible():
    """每个插入点位置，光标都必须落在可见段里，且下标换算不错位。"""
    text = "0123456789abcdefghij"          # 20 字符
    maxw = 10 * CHAR_W                     # 可见 10 字符
    for caret in range(len(text) + 1):
        shown, idx = visible_input(text, maxw, caret)
        check(f"caret={caret} 可见段不超宽",
              FakeFont().measure(shown) <= maxw, f"{shown!r}")
        check(f"caret={caret} 光标在可见段内",
              0 <= idx <= len(shown), f"idx={idx} len={len(shown)}")
        # 光标右边那个字符若也在可见段里，必须对得上原文（下标没错位）
        if caret < len(text) and idx < len(shown):
            check(f"caret={caret} 下标不错位",
                  shown[idx] == text[caret], f"{shown[idx]!r} != {text[caret]!r}")


def test_right_padding():
    """插入点不在末尾时，右边要留得出余量。"""
    text = "0123456789abcdefghij"
    maxw = 10 * CHAR_W
    for caret in range(len(text)):          # 不含末尾
        shown, idx = visible_input(text, maxw, caret)
        check(f"caret={caret} 右边有余量", len(shown) - idx >= 1,
              f"右余量={len(shown) - idx}")


def test_legacy_loses_caret():
    """对照：旧实现在插入点靠前时，连插入点那个字符都不在可见段里。"""
    text = "0123456789abcdefghij"
    maxw = 10 * CHAR_W
    old = legacy_visible(text, maxw)
    check("旧实现把句首砍掉了", text[3] not in old,
          f"{old!r} 里不该还有 {text[3]!r}")
    # 新实现同样位置必须看得见
    shown, idx = visible_input(text, maxw, 3)
    check("新实现句首可见", idx < len(shown) and shown[idx] == text[3],
          f"{shown!r} idx={idx}")


def test_short_text_untouched():
    """放得下就原样返回，插入点下标不变 —— 不能为了开窗改短消息的观感。"""
    for text, caret in (("", 0), ("abc", 0), ("abc", 3), ("0123456789", 5)):
        shown, idx = visible_input(text, 10 * CHAR_W, caret)
        check(f"{text!r} 原样返回", (shown, idx) == (text, caret),
              f"得到 {(shown, idx)}")


def test_narrow_window():
    """窗口窄到只剩一个字符时也不能抛、不能返回负下标。"""
    text = "0123456789abcdefghij"
    for maxw in (CHAR_W, CHAR_W * 2, CHAR_W * 3):
        for caret in (0, 5, len(text)):
            shown, idx = visible_input(text, maxw, caret)
            check(f"maxw={maxw} caret={caret} 不超宽",
                  FakeFont().measure(shown) <= maxw, f"{shown!r}")
            check(f"maxw={maxw} caret={caret} 下标合法",
                  0 <= idx <= len(shown), f"idx={idx}")


def test_blink_contract():
    """闪烁只认两个常量和三个方法；改名了这里要跟着改。"""
    from window import LiveGlass

    check("CARET_MS 是 530", LiveGlass.CARET_MS == 530, str(LiveGlass.CARET_MS))
    check("CARET_PAD 是 3", LiveGlass.CARET_PAD == 3, str(LiveGlass.CARET_PAD))
    for m in ("_schedule_caret", "_blink_caret", "_visible_input"):
        check(f"{m} 还在", callable(getattr(LiveGlass, m, None)))


def main():
    test_caret_stays_visible()
    test_right_padding()
    test_legacy_loses_caret()
    test_short_text_untouched()
    test_narrow_window()
    test_blink_contract()

    if failures:
        print(f"FAIL ({len(failures)})")
        for f in failures:
            print("  -", f)
        return 1
    print("OK: 光标跟随插入点、右边留余量、短文本不动、窄窗口不崩")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
