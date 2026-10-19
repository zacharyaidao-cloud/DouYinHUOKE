Set ws = CreateObject("WScript.Shell")
p = WScript.ScriptFullName
appDir = Left(p, InStrRev(p, "\") - 1)
ws.CurrentDirectory = appDir
Set fso = CreateObject("Scripting.FileSystemObject")
If fso.FileExists(appDir & "\抖音获客软件.exe") Then
  ws.Run """" & appDir & "\抖音获客软件.exe""", 0, False
Else
  ws.Run """" & appDir & "\启动软件.bat""", 1, False
End If
