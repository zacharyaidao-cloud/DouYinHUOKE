Set ws = CreateObject("WScript.Shell")
p = WScript.ScriptFullName
appDir = Left(p, InStrRev(p, "\") - 1)
ws.CurrentDirectory = appDir
ws.Run Chr(34) & appDir & "\抖音获客软件.exe" & Chr(34), 1, False
