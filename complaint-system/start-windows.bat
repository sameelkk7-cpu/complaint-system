@echo off
title Residential Complaint Management System - Launcher
setlocal EnableDelayedExpansion

cd /d "%~dp0"

echo ======================================================
echo   Residential Complaint Management System
echo   One-Click Launcher
echo ======================================================
echo.

if not exist backend\node_modules (
    echo Installing backend dependencies...
    cd backend && call npm install && cd ..
)

echo Starting Services...
start "Complaint System - AI Service (YAMNet)" /min cmd /k "cd ai-service && python app.py"
start "Complaint System - Backend Server" /min cmd /k "cd backend && npm start"

timeout /t 3 >nul
start http://localhost:4000
exit
