@echo off
rem Double-click entry point for the qq-bridge (avoids PowerShell execution policy).
rem Finds the current DSH Desktop port, syncs config.json, then runs the bridge.
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-desktop.ps1" %*
echo.
echo [bridge exited with code %errorlevel%]
pause
