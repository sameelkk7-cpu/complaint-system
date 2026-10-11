@echo off
title Enable Autostart on Windows Boot
setlocal EnableDelayedExpansion

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
"$ws = New-Object -ComObject WScript.Shell; " ^
"$startup = [System.Environment]::GetFolderPath('Startup'); " ^
"$s = $ws.CreateShortcut((Join-Path $startup 'Residential Complaint System (Background).lnk')); " ^
"$s.TargetPath = 'wscript.exe'; " ^
"$s.Arguments = '\"c:\Users\hp\OneDrive\Desktop\complaint-system 2\launch_silently.vbs\"'; " ^
"$s.WorkingDirectory = 'c:\Users\hp\OneDrive\Desktop\complaint-system 2'; " ^
"$s.IconLocation = 'shell32.dll,220'; " ^
"$s.Description = 'Start Complaint System Background Services on Boot'; " ^
"$s.Save(); " ^
"Write-Host 'Autostart configured successfully! The app will start silently in the background whenever your PC turns on.'"

echo.
pause
