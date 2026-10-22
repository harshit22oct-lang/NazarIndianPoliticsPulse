@echo off
title NAZAR prototype
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org & pause & exit /b 1)
start "" "http://localhost:3300/live"
node server.js
pause
