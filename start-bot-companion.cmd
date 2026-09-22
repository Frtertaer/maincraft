@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Opus AI Companion - Minecraft
echo.
echo  ========================================
echo   OPUS AI COMPANION (как нейро-Скайрим)
echo  ========================================
echo   Ник бота:  Opus
echo   Твой ник:  Steve  (или передай аргумент)
echo   Сервер:    127.0.0.1:25565
echo   Сначала:   server\start-server.ps1
echo  ========================================
echo.
REM optional: start-bot-companion.cmd MyNick
if "%~1"=="" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-bot-companion.ps1" -PlayerName Steve
) else (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-bot-companion.ps1" -PlayerName "%~1"
)
if errorlevel 1 (
  echo.
  echo FAILED. Paper running? Node installed? API key?
  pause
)
