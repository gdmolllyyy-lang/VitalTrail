@echo off
chcp 65001 >nul
title Healthy 健身饮食管家
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [错误] 未检测到 Node.js
  echo  请先安装 Node.js 22.5 或更高版本: https://nodejs.org/
  echo.
  pause
  exit /b 1
)

echo.
echo  正在启动 Healthy ...
echo  浏览器将自动打开 http://localhost:3000
echo.

start "" /b cmd /c "timeout /t 2 >nul & start http://localhost:3000"
node --experimental-sqlite --no-warnings server/app.js

pause
