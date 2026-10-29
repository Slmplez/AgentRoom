@echo off
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
if not exist "%~dp0node_modules\electron\dist\electron.exe" (
  echo Electron runtime is missing. Run npm install and npm run install-runtime first.
  pause
  exit /b 1
)
start "Agent Room" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
