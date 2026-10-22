@echo off
title NAZAR - Ngrok Live Share
color 0A

echo ================================================
echo   NAZAR - Internet Live Share via Ngrok
echo ================================================
echo.

REM --- Purani processes band karo (conflict se bachne ke liye) ---
echo [0/2] Pehle existing processes band kar raha hoon...
taskkill /F /IM node.exe >nul 2>&1
timeout /t 2 /nobreak >nul

REM --- Start Node server in background ---
echo [1/2] Nazar server start ho raha hai (port 3300)...
start "Nazar-Server" cmd /k "cd /d %~dp0 && node server.js"
timeout /t 3 /nobreak >nul

REM --- Start ngrok tunnel ---
echo [2/2] Ngrok tunnel shuru ho rahi hai...
echo.
node "%~dp0ngrok-start.js"
pause
