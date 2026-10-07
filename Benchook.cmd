@echo off
cd /d "%~dp0"
if not exist "panel\node_modules\electron\dist\electron.exe" (
  echo Dependencies are missing. Run: npm ci --prefix panel
  pause
  exit /b 1
)
call npm start --prefix panel
if errorlevel 1 pause
