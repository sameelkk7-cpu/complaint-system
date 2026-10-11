@echo off
title Residential Complaint Management System - Launcher
setlocal EnableDelayedExpansion

cd /d "%~dp0"

echo ======================================================
echo   Residential Complaint Management System
echo   One-Click Launcher
echo ======================================================
echo.

:: Check project directory path
set "BASE_DIR=%~dp0"
if exist "%BASE_DIR%complaint-system" (
    set "PROJECT_DIR=%BASE_DIR%complaint-system"
) else (
    set "PROJECT_DIR=%BASE_DIR%"
)

echo [1/3] Checking Node.js Backend dependencies...
cd /d "%PROJECT_DIR%\backend"
if not exist "node_modules" (
    echo Installing backend node_modules...
    call npm install
)

echo.
echo [2/3] Starting Services...

:: Kill previous instances on ports 4000 and 5001 if any to avoid port collisions
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":4000 "') do (
    taskkill /F /PID %%a >nul 2>&1
)
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":5001 "') do (
    taskkill /F /PID %%a >nul 2>&1
)

:: Start AI Service (Port 5001)
start "Complaint System - AI Service (YAMNet)" /min cmd /k "cd /d "%PROJECT_DIR%\ai-service" && python app.py"

:: Start Backend Web Server (Port 4000)
start "Complaint System - Backend Server" /min cmd /k "cd /d "%PROJECT_DIR%\backend" && npm start"

echo.
echo [3/3] Opening App in Browser...
timeout /t 3 >nul

start http://localhost:4000

echo.
echo ======================================================
echo   System is UP and RUNNING permanently!
echo   Frontend & API: http://localhost:4000
echo   AI Service:     http://localhost:5001
echo ======================================================
echo You can minimize this window.
timeout /t 5 >nul
exit
