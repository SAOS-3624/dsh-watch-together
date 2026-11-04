"""check-expand-message.py — 长消息展开的回归（不需要真的开窗）。

跑法（仓库根）：

    python scripts/check-expand-message.py

背景：气泡按 `chat_layout()` 的四个固定槽位排，一个槽 88px（窗口 >=560 时），
11 号字行高约 15px，所以一条消息最多五行多一点，再长就被 `_fit_lines` 砍掉加
省略号，没有任何展开入口 —— 长句里最关键的半句经常正好落在省略号后面。

这里守四件事：

1. **槽高和内容无关**：`chat_layout` 是窗口高度的纯函数。被截断不是因为气泡
   高度和内容互相依赖（这是个容易反推错的结论），而是因为槽位网格固定成 4 格。
2. **展开真的变高**：展开那条独占 4 槽的纵向范围，可见行数必须显著增加。
3. **不许压到输入框**：展开后气泡底边仍要在 `input_shape` 上沿之上 —— 文字
   画出底板就落在透明区上，直接看不清。
4. **按消息身份跟随**：展开状态存 (role, text, at)，不是槽位下标。新消息进来
   会让同一条消息换槽，存下标就会变成"展开的是另一条"。
"""

from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "examples" / "floating-chat"))

from glass_geometry import MESSAGE_SLOTS, chat_layout  # noqa: E402
from window import LiveGlass                           # noqa: E402

LS = 15             # 11 号字实测行高
SIZES = (420, 560, 627, 800)

failures: list[str] = []


def check(name, cond, detail=""):
    if not cond:
        failures.append(f"{name}{(': ' + detail) if detail else ''}")


def fit_rows(max_height, ls=LS):
    """_fit_lines 的行数上限部分。"""
    return max(1, int(max_height // ls))


def test_slot_height_is_pure_function_of_h():
    """槽高只由窗口高度决定 —— 和消息内容、条数都无关。"""
    for h in SIZES:
        a = chat_layout(h)
        b = chat_layout(h)
        check(f"h={h} chat_layout 幂等", a == b)
    ys, bh = chat_layout(627)
    check("627 的四个槽等高", bh == 88, str(bh))
    check("627 槽位是 [104,198,292,386]", ys == [104, 198, 292, 386], str(ys))


def test_expand_adds_rows():
    """展开后可见行数必须显著增加。"""
    for h in SIZES:
        ys, bh = chat_layout(h)
        collapsed = bh
        expanded = ys[MESSAGE_SLOTS - 1] + bh - ys[0]
        c_rows, e_rows = fit_rows(collapsed), fit_rows(expanded)
        check(f"h={h} 展开后更高", expanded > collapsed, f"{expanded} <= {collapsed}")
        check(f"h={h} 展开后行数变多", e_rows > c_rows, f"{e_rows} <= {c_rows}")
        check(f"h={h} 至少翻倍", e_rows >= c_rows * 2, f"{c_rows} -> {e_rows}")


def test_expand_never_covers_input():
    """展开后的气泡底边不能压到输入框上沿。"""
    for h in SIZES:
        ys, bh = chat_layout(h)
        bottom = ys[MESSAGE_SLOTS - 1] + bh
        input_top = h - 80
        check(f"h={h} 不压输入框", bottom <= input_top,
              f"气泡底 {bottom} > 输入框顶 {input_top}")


def test_identity_not_index():
    """展开状态按消息身份跟随，换槽不跟错，滚出视野不误展开。"""
    msgs = [
        {"role": "assistant", "text": "短", "at": 1},
        {"role": "user", "text": "也短", "at": 2},
        {"role": "assistant", "text": "很长" * 60, "at": 3},
        {"role": "user", "text": "末尾", "at": 4},
    ]
    key = LiveGlass._msg_key(msgs[2])
    check("_msg_key 是三元组", key == ("assistant", "很长" * 60, 3), str(key))

    stub = object.__new__(LiveGlass)
    stub._expanded = key
    check("命中当前槽", LiveGlass._expanded_index(stub, msgs) == 2)

    # 新消息进来，同一条消息从槽 2 挪到槽 1
    shifted = msgs[1:] + [{"role": "assistant", "text": "新来的", "at": 5}]
    check("换槽后跟着走", LiveGlass._expanded_index(stub, shifted) == 1)
    check("这正是不能存下标的原因",
          LiveGlass._msg_key(shifted[2]) != key)

    # 滚出视野：不许退化成"展开那一槽的任何一条"
    gone = [{"role": "assistant", "text": f"其他{i}", "at": 10 + i} for i in range(4)]
    check("滚出视野返回 None", LiveGlass._expanded_index(stub, gone) is None)

    # 同文不同时间戳是两条消息，不能互相顶替
    twin = dict(msgs[2])
    twin["at"] = 999
    check("同文不同 at 不算同一条",
          LiveGlass._msg_key(twin) != key)


def test_toggle_and_autocollapse():
    """点同一条收起、点另一条换过去；自动收起要真的清掉状态。"""
    laid_out = []
    stub = object.__new__(LiveGlass)
    stub._expanded = None
    stub._layout = lambda *_a, **_k: laid_out.append(True)

    a = ("user", "a", 1)
    b = ("user", "b", 2)
    LiveGlass._toggle_expand(stub, a)
    check("点一下展开", stub._expanded == a, str(stub._expanded))
    LiveGlass._toggle_expand(stub, a)
    check("再点收起", stub._expanded is None, str(stub._expanded))
    LiveGlass._toggle_expand(stub, a)
    LiveGlass._toggle_expand(stub, b)
    check("点另一条就换过去", stub._expanded == b, str(stub._expanded))
    check("每次都重排", len(laid_out) == 4, str(len(laid_out)))

    LiveGlass._collapse_expanded(stub)
    check("自动收起清掉状态", stub._expanded is None)
    LiveGlass._collapse_expanded(stub)
    check("已经收起时再调不报错", stub._expanded is None)


def test_clip_flag():
    """_fit_lines 要如实报告有没有砍：短消息不标、长消息标。"""
    class FakeFont:
        def measure(self, s):
            return len(s) * 10

        def metrics(self, _k):
            return LS

    class FakeFonts:
        def get(self, _size, _bold=False):
            return FakeFont()

    stub = object.__new__(LiveGlass)
    stub.fonts = FakeFonts()
    stub._fit_clipped = False

    # 一个槽 88px → 最多 5 行；每行最多 10 个字符（maxw=100）
    LiveGlass._fit_lines(stub, "短", 11, 100, 88)
    check("短消息不标截断", stub._fit_clipped is False)

    LiveGlass._fit_lines(stub, "x" * 200, 11, 100, 88)
    check("长消息标截断", stub._fit_clipped is True)

    # 展开后放得下的，就不该再标
    lines = LiveGlass._fit_lines(stub, "x" * 60, 11, 100, 88)
    clipped_collapsed = stub._fit_clipped
    LiveGlass._fit_lines(stub, "x" * 60, 11, 100, 386 + 88 - 104)
    check("60 字符收起时被砍", clipped_collapsed is True, f"{len(lines)} 行")
    check("60 字符展开后放得下", stub._fit_clipped is False)


def _stub_for_shapes(h, expanded=None, w=882):
    """能跑 _message_shapes 的最小壳子：它只用到 _geo.width/height、fonts、_expanded。"""
    class FakeFont:
        def measure(self, s):
            return len(s) * 10

        def metrics(self, _k):
            return LS

    class FakeFonts:
        def get(self, _size, _bold=False):
            return FakeFont()

    class FakeGeo:
        width = w
        height = h

    stub = object.__new__(LiveGlass)
    stub.fonts = FakeFonts()
    stub._geo = FakeGeo()
    stub._expanded = expanded
    stub._fit_clipped = False
    return stub


def test_message_shapes_honors_expand():
    """直接验 _message_shapes：展开那条的框必须真的横跨 4 槽，其余是零框。"""
    # 文本要足够长才撑得满展开后的高度：假字体一行放得下 54 个字符，
    # 展开后约 24 行，所以 1500 字才打得满（气泡高度按内容算，内容不够
    # 本来就不该撑满 —— 这里要验的是"长内容能用上多出来的空间"）。
    msgs = [
        {"role": "assistant", "text": "甲" * 1500, "at": 1},
        {"role": "user", "text": "乙", "at": 2},
        {"role": "assistant", "text": "丙" * 1500, "at": 3},
        {"role": "user", "text": "丁", "at": 4},
    ]
    h = 627
    ys, bh = chat_layout(h)
    span = ys[MESSAGE_SLOTS - 1] + bh - ys[0]

    # 收起态：每条各占自己的槽，框高不超过单槽
    shapes, infos = LiveGlass._message_shapes(_stub_for_shapes(h), msgs)
    check("收起态四条都有框", len(infos) == MESSAGE_SLOTS, str(len(infos)))
    for i, info in enumerate(infos):
        _bx0, by0, _bx1, by1, _r = info["shape"]
        check(f"收起态槽 {i} 不超单槽", by1 - by0 <= bh, f"{by1 - by0} > {bh}")
        check(f"收起态槽 {i} 没标展开", info["expanded"] is False)

    # 展开第三条（下标 2）
    key = LiveGlass._msg_key(msgs[2])
    shapes, infos = LiveGlass._message_shapes(_stub_for_shapes(h, key), msgs)
    check("展开态只画一条", len(infos) == 1, str(len(infos)))
    info = infos[0]
    check("展开的是第三条", info["key"] == key)
    check("展开标记置位", info["expanded"] is True)
    _bx0, by0, _bx1, by1, _r = info["shape"]
    check("展开框高跨 4 槽", by1 - by0 > bh,
          f"框高 {by1 - by0} 不比单槽 {bh} 高")
    check("展开框顶对齐第一槽", by0 <= ys[0] + LS, f"by0={by0} ys0={ys[0]}")
    check("展开框底不超第四槽", by1 <= ys[MESSAGE_SLOTS - 1] + bh,
          f"by1={by1} 上限={ys[MESSAGE_SLOTS - 1] + bh}")
    check("展开框底不压输入框", by1 <= h - 80, f"by1={by1} 输入框顶={h - 80}")

    # 其余三槽必须是零框（让位），否则底板会画在老位置
    zero = [s for s in shapes[:MESSAGE_SLOTS] if s == (0, 0, 0, 0, 0)]
    check("其余三槽让位", len(zero) == MESSAGE_SLOTS - 1, str(len(zero)))

    # 展开后能看到的行数要真的比收起时多
    collapsed_rows = fit_rows(bh)
    expanded_rows = len(info["lines"])
    check("展开后行数变多", expanded_rows > collapsed_rows,
          f"{expanded_rows} <= {collapsed_rows}")
    check("展开后用上了多出来的空间", expanded_rows >= fit_rows(span) - 2,
          f"{expanded_rows} 行，跨高能放 {fit_rows(span)} 行")

    # 展开一条已经滚出视野的消息：不许误展开别人
    stray = ("user", "不在列表里", 999)
    shapes, infos = LiveGlass._message_shapes(_stub_for_shapes(h, stray), msgs)
    check("身份不在视野时退回收起态", len(infos) == MESSAGE_SLOTS, str(len(infos)))
    for info in infos:
        check("没有谁被误标成展开", info["expanded"] is False)


def main():
    test_slot_height_is_pure_function_of_h()
    test_expand_adds_rows()
    test_expand_never_covers_input()
    test_identity_not_index()
    test_toggle_and_autocollapse()
    test_clip_flag()
    test_message_shapes_honors_expand()

    if failures:
        print(f"FAIL ({len(failures)})")
        for f in failures:
            print("  -", f)
        return 1

    print("槽高是 h 的纯函数、展开行数翻倍、不压输入框、按身份跟随 —— 全过")
    print()
    print("窗口高   槽高   收起可见行   展开可见行")
    for h in SIZES:
        ys, bh = chat_layout(h)
        e = ys[MESSAGE_SLOTS - 1] + bh - ys[0]
        print(f"{h:<8} {bh:<6} {fit_rows(bh):<12} {fit_rows(e)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
