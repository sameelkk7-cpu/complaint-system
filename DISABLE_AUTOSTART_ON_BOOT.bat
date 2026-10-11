@echo off
title Disable Autostart on Windows Boot

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
"$startup = [System.Environment]::GetFolderPath('Startup'); " ^
"$target = Join-Path $startup 'Residential Complaint System (Background).lnk'; " ^
"if (Test-Path $target) { Remove-Item -Force $target; Write-Host 'Autostart shortcut removed from Startup folder.' } else { Write-Host 'Autostart shortcut was not found in Startup folder.' }"

echo.
pause
