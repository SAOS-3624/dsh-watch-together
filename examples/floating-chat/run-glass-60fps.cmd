@echo off
rem 同上，但目标 60fps —— 本机一轮 32ms，实际约 30Hz，多出来的帧会被丢掉
set DSH_WATCH_GLASS_TTL=60
set DSH_WATCH_GLASS_FPS=60
cd /d "%~dp0"
"C:/Users/10437/AppData/Local/Microsoft/WindowsApps/python.exe" window.py
pause
