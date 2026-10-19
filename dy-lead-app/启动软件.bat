@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动抖音获客软件...
if exist "%~dp0抖音获客软件.exe" (
  start "" "%~dp0抖音获客软件.exe"
) else (
  "%~dp0node.exe" "%~dp0server.js"
  if errorlevel 1 pause
)
