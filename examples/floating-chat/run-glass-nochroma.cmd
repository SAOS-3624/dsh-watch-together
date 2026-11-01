@echo off
rem 同上，但**关掉色散** —— 用来对比"色散到底是不是卡的原因"
set DSH_WATCH_GLASS_TTL=120
set DSH_WATCH_GLASS_CHROMA=0
cd /d "%~dp0"
"C:/Users/10437/AppData/Local/Microsoft/WindowsApps/python.exe" window.py
pause
