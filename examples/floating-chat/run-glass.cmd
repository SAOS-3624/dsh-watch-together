@echo off
rem ---------------------------------------------------------------------------
rem 手工启动悬浮窗（开发/调试用）。正常使用时插件自己会拉起窗口，不需要这个。
rem
rem 【重要】旧版的这组变量在玻璃渲染重写之后**已经全部不读了**，设了也不会有
rem 任何效果 —— 见 issue #43。以前双击 run-glass-acrylic.cmd 以为开了亚克力，
rem 实际还是普通软件模糊：
rem
rem   DSH_WATCH_GLASS_TTL / FPS / CHROMA / BLUR / SAT     （不读）
rem   DSH_GLASS_ACRYLIC                                    （不读，没有 acrylic 路径了）
rem
rem 现在真正有效的开关：
rem
rem   DSH_GLASS_GPU=1        GPU 合成（需要 moderngl + OpenGL 3.3；起不来会回落 CPU）
rem   DSH_GLASS_NATIVE=1     同上，且采样走全分辨率（边缘更干净，更吃显存）
rem   GLASS_FORCE=1          每帧强制重合成（调试用，很费 CPU）
rem   DSH_GLASS_PREVIEW=1    预览模式：不抓屏，只贴最后一帧
rem   DSH_GLASS_SNAPSHOT=1   文档截图模式：跑 2.5 秒后冻结画面
rem   DSH_GLASS_WDA=0        允许截图/录屏拍到窗口（等价于配置里的 capturable）
rem
rem 想开 GPU 的话把下面这行前面的 rem 去掉（或者用 glass_window_gpu.py 起窗）：
rem set DSH_GLASS_GPU=1
rem
rem 尺寸、名字、capturable 这类持久设置写 ~/.dsh/watch-window.json。
rem ---------------------------------------------------------------------------

cd /d "%~dp0"

rem 不写死解释器路径：先在 PATH 上找，找不到再试 py 启动器。
where pythonw >nul 2>&1
if %errorlevel%==0 (
  start "" pythonw window.py
  goto :eof
)
where py >nul 2>&1
if %errorlevel%==0 (
  start "" py -3 window.py
  goto :eof
)

echo 找不到 pythonw / py。
echo 需要一个带 tkinter 的 Python（python.org 官方包勾 tcl/tk，或 Microsoft Store 版），
echo 或者直接用插件拉起窗口（它自己会挑解释器）。
pause
