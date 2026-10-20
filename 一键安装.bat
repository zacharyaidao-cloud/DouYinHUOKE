@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==== 华贸获客：安装运行依赖 ====
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 没有找到 Node.js。请先安装 Node.js 20 或更高版本：https://nodejs.org/zh-cn
  pause
  exit /b 1
)
node -v
echo.
echo [1/2] 安装后端依赖（playwright-core、ws）...
call npm --prefix dy-lead-app install
if errorlevel 1 (
  echo [错误] 依赖安装失败，请检查网络后重试。国内网络可先执行：npm config set registry https://registry.npmmirror.com
  pause
  exit /b 1
)
echo.
echo [2/2] 复制 node.exe 到 dy-lead-app（桌面版需要）...
for /f "delims=" %%i in ('where node') do (
  copy /y "%%i" "dy-lead-app\node.exe" >nul
  goto copied
)
:copied
echo.
echo 安装完成。双击「启动-网页版.bat」开始使用。
pause
