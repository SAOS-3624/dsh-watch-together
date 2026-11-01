@echo off
rem 磨砂模式：背景由 Windows 的 GPU 合成（DWM Acrylic），一次屏都不截。
rem 气泡和标题栏会变成实心卡片（Tk 不支持半透明叠加）。
rem 想调色调：DSH_GLASS_ACRYLIC_TINT，ABGR 十六进制，默认 0xB4121014
set DSH_GLASS_ACRYLIC=1
cd /d "%~dp0"
"C:/Users/10437/AppData/Local/Microsoft/WindowsApps/python.exe" window.py
pause
