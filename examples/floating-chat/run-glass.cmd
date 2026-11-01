@echo off
rem 悬浮窗（液态玻璃）
rem   DSH_WATCH_GLASS_TTL     0 = 关掉实时玻璃（回到"开窗截一次"）；非 0 = 启用
rem   DSH_WATCH_GLASS_FPS     目标帧率，默认 30（本机实测能跑到 26~30Hz）
rem   DSH_WATCH_GLASS_CHROMA  色散强度，默认 8（0 = 完全关掉）
rem   DSH_WATCH_GLASS_BLUR    模糊半径，默认 13
rem   DSH_WATCH_GLASS_SAT     饱和度，默认 1.75
set DSH_WATCH_GLASS_TTL=60
set DSH_WATCH_GLASS_FPS=30
cd /d "%~dp0"
"C:/Users/10437/AppData/Local/Microsoft/WindowsApps/python.exe" window.py
pause
