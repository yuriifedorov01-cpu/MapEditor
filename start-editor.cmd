@echo off
setlocal
chcp 65001 >nul
title HH Editor
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [!] Node.js не найден. Установи Node 18+ : https://nodejs.org
  echo.
  pause
  exit /b 1
)

rem --- свободный порт 8080..8090 ---
set PORT=8080
for /f %%p in ('powershell -NoProfile -Command "$p=8080; while($p -le 8090 -and (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue)){$p++}; $p"') do set PORT=%%p

echo.
echo   Редактор карт Helmet Heroes
echo   Адрес:  http://127.0.0.1:%PORT%/editor
echo   Стоп:   закрой окно "HH editor server".
echo.

start "HH editor server" /min cmd /k "node serve.mjs %PORT%"
timeout /t 2 >nul
start "" "http://127.0.0.1:%PORT%/editor"
exit /b 0

