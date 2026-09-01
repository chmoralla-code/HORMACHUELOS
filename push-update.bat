@echo off
setlocal
title Hormachuelos - One-Click Update
where node >nul 2>nul
if errorlevel 1 (
  echo [X] Node.js is required but was not found in PATH.
  pause
  exit /b 1
)
cd /d "%~dp0"
node scripts\push-update.mjs %*
echo.
pause
endlocal