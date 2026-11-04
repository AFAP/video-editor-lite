@echo off
chcp 65001 >nul
cd /d "%~dp0"
setlocal

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [X] 没找到 node.exe —— 这个工具需要 Node.js 18+。
  echo      装好 Node 后重新双击本文件。
  echo.
  pause
  exit /b 1
)

echo.
echo  Lite Video Editor · 本机 ffmpeg 服务
echo  服务地址: http://127.0.0.1:8787/
echo  关掉那个最小化的窗口就等于关掉服务。
echo.

start "视频工具 ffmpeg 服务" /min cmd /k node "%~dp0ffmpeg-bridge.mjs"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:8787/"
exit /b 0
