@echo off
rem Run-Pipeline.cmd — double-clickable launcher for cicd-pipeline-lab.
rem Runs the full pipeline and keeps the window open so you can read the summary.
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required but was not found on PATH.
  echo Install it from https://nodejs.org and run this again.
  pause
  exit /b 1
)
node pipeline.mjs %*
echo.
pause
