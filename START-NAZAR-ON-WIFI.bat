@echo off
title NAZAR prototype (open on this Wi-Fi)
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org & pause & exit /b 1)
echo.
echo  On the TV / phone (same Wi-Fi) open:  http://THIS-LAPTOP-IP:3300/live
echo  This laptop's IP address:
ipconfig | findstr /i "IPv4"
set HOST=0.0.0.0
start "" "http://localhost:3300/live"
node server.js
pause
