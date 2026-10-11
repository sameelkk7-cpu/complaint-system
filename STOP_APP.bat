@echo off
title Stop Complaint System Services
echo Stopping Complaint System Services...

for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":4000 "') do (
    taskkill /F /PID %%a >nul 2>&1
)
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":5001 "') do (
    taskkill /F /PID %%a >nul 2>&1
)

echo Services on port 4000 and 5001 stopped.
timeout /t 2 >nul
exit
