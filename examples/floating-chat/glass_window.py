"""PR #15 的窗口模块名兼容层。

GPU 伴生文件按原始 PR 的布局 `import glass_window as G`；这里的窗口已经改名为
`window.py`（交互补全都在里面），所以用这个别名保持 GPU 路径可直接运行。

不再 `from window import *`：那样会在导入时复制一份全局量（W/H/SHAPES/
OVERLAY/BOX_MAPS），窗口缩放或气泡按文字改宽后，GPU 仍拿旧坐标合成，
表现就会和 CPU 不一致。这里改成动态代理，每次访问都回到 window.py。
"""

import window as _window


def __getattr__(name):
    return getattr(_window, name)
