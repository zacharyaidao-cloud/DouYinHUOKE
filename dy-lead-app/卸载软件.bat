@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist "unins000.exe" (
  echo 正在打开卸载程序，客户数据会保留...
  start "" "%~dp0unins000.exe"
) else (
  echo 当前是绿色版，请退出软件后手动移除程序文件。
  echo 请先备份 data 文件夹，客户数据不会自动删除。
  pause
)
