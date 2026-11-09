@echo off
set "ELECTRON_RUN_AS_NODE="
cd /d "%~dp0"
if not exist "%~dp0node_modules\electron\dist\electron.exe" (
  echo [ERROR] electron.exe not found. Run: npm install
  pause
  exit /b 1
)
start "" "%~dp0node_modules\electron\dist\electron.exe" .
exit
