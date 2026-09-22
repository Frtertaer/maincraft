@echo off
chcp 65001 >nul
cd /d "%~dp0"
title BERSERK bot - kills all living
echo.
echo  BERSERK — combat bot (mobs + animals)
echo  Server must be up: 127.0.0.1:25565
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-bot-berserk.ps1" %*
if errorlevel 1 (
  echo.
  echo FAILED. Is Paper running? Is Node installed?
  pause
)
