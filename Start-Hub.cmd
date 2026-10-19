@echo off
setlocal
cd /d "%~dp0"
if exist "release\win-unpacked\AI Project Hub.exe" (
  start "" "%~dp0release\win-unpacked\AI Project Hub.exe"
  exit /b 0
)
echo Desktop build not found.
echo Open the delivered AI-Project-Hub portable or Setup executable.
echo Developers can run: npm run pack:desktop
pause
exit /b 1
