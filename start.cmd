@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20.11 or newer is required. Install Node.js, then run this file again.
  pause
  exit /b 1
)
node scripts\start.mjs
if errorlevel 1 pause
