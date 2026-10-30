@echo off
chcp 65001 >nul
setlocal
set "ROOT=%~dp0.."

echo.
echo  ============================================
echo   陪看 · 测试扩展通不通
echo  ============================================
echo.
echo  这个窗口会一直开着，专门接收浏览器扩展报上来的播放进度。
echo  收到一条就说明通了。收到之后可以按 Ctrl+C 关掉。
echo.

node "%ROOT%\bin\watch.mjs" bridge
pause
