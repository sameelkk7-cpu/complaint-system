Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

strPath = fso.GetParentFolderName(WScript.ScriptFullName)

' Set project directories
backendDir = strPath & "\complaint-system\backend"
aiDir = strPath & "\complaint-system\ai-service"

' Start AI Service silently in background if not already running
WshShell.Run "cmd /c ""cd /d " & Chr(34) & aiDir & Chr(34) & " && python app.py""", 0, False

' Start Backend Node Server silently in background if not already running
WshShell.Run "cmd /c ""cd /d " & Chr(34) & backendDir & Chr(34) & " && npm start""", 0, False

' Wait 2 seconds and open the web browser
WScript.Sleep 2000
WshShell.Run "http://localhost:4000"
