$ws = New-Object -ComObject WScript.Shell
$desktop = [System.Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop "Residential Complaint System.lnk"
$s = $ws.CreateShortcut($shortcutPath)
$s.TargetPath = "wscript.exe"
$s.Arguments = "`"c:\Users\hp\OneDrive\Desktop\complaint-system 2\launch_silently.vbs`""
$s.WorkingDirectory = "c:\Users\hp\OneDrive\Desktop\complaint-system 2"
$s.IconLocation = "shell32.dll,220"
$s.Description = "Open Residential Complaint Management System (One-Click)"
$s.Save()
Write-Host "Updated desktop shortcut at: $shortcutPath"
