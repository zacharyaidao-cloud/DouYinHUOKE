@echo off
setlocal
cd /d "%~dp0"
echo ============================================
echo  Huamao client build 2.4.6
echo  Output: installer exe + portable zip
echo ============================================
echo.

if not exist "%~dp0build-tools\build.ps1" (
  echo [FAILED] build-tools\build.ps1 not found.
  echo Run this file from the project root.
  goto :end
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-tools\build.ps1" -FocusedChecks
if errorlevel 1 (
  echo.
  echo [FAILED] Build stopped. Check the messages above and:
  echo          build-tools\reports\release-verify.json
) else (
  echo.
  echo [OK] Installer and portable package generated.
  echo      Checksums: build-tools\reports\artifacts-2.4.6.json
)

:end
echo.
pause
