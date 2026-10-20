@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist "dy-lead-app\node.exe" (
  echo 还没有安装依赖，请先双击「一键安装.bat」。
  pause
  exit /b 1
)
echo 首次运行会下载 Electron 44.6.0（约 100MB），请耐心等待...
call npx --yes electron@44.6.0 desktop
if errorlevel 1 pause
