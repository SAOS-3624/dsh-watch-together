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

REM --no-wait：让 node 不自己等回车，统一由下面的 pause 兜住（只按一次）
node "%ROOT%\bin\watch.mjs" install-extension --no-wait
echo.
echo  --------------------------------------------
echo   装好之后，再双击 scripts\bridge.cmd 可以验证通不通。
echo  --------------------------------------------
echo.
pause
