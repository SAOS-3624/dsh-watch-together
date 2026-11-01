"""PR #15 的窗口模块名兼容层。

GPU 伴生文件按原始 PR 的布局 `import glass_window as G`；这里的窗口已经改名为
`window.py`（交互补全都在里面），所以用这个别名保持 GPU 路径可直接运行。
"""

from window import *  # noqa: F401,F403  (GPU companion expects module-level names)
