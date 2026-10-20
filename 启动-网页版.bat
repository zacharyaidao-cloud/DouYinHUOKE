@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist "dy-lead-app\node_modules\playwright-core" (
  echo 还没有安装依赖，请先双击「一键安装.bat」。
  pause
  exit /b 1
)
echo 正在启动华贸获客后台服务，启动后会自动打开浏览器：http://127.0.0.1:17888
echo 使用期间请不要关闭这个窗口；关闭窗口即停止服务。
start "" cmd /c "timeout /t 3 /nobreak >nul & start http://127.0.0.1:17888"
node dy-lead-app\server.js
if errorlevel 1 pause
