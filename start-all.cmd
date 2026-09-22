@echo off
chcp 65001 >nul
cd /d "%~dp0"
title MAINCRAFT ALL — Paper + Voice + Opus + TLauncher
echo.
echo  ================================================
echo   ONE CLICK: server + voice + AI companion + TL
echo  ================================================
echo   Your nick default: Steve
echo   Usage: start-all.cmd
echo          start-all.cmd MyNick
echo  ================================================
echo.

if "%~1"=="" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-all.ps1" -PlayerName Steve
) else (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-all.ps1" -PlayerName "%~1"
)

if errorlevel 1 (
  echo.
  echo Something failed. Check logs\ folder.
  pause
)
