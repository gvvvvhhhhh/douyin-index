@echo off
cd /d "%~dp0"
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
start "" /d "%~dp0" cmd /k "npm run tauri dev"