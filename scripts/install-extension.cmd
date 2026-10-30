@echo off
chcp 65001 >nul
setlocal
set "ROOT=%~dp0.."

echo.
echo  ============================================
echo   陪看 · 安装浏览器扩展
echo  ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo  [x] 没找到 Node.js。
  echo      这个扩展靠 Node 把文件复制到固定位置。先装 Node.js 再来。
  echo      下载： https://nodejs.org
  echo.
  pause
  exit /b 1
)

REM 不加 --no-wait：装完它会一直等，确认装好了才打印“全部完成”
node "%ROOT%\bin\watch.mjs" install-extension
echo  --------------------------------------------
echo   不用再开别的窗口了：这个窗口自己会等到装好，
echo   并且告诉你「全部完成」。
echo  --------------------------------------------
echo.
pause
