@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Current dir: %CD%
echo.

if not exist "node_modules" (
    echo Installing...
    call npm install
)

echo Starting Electron...
echo.
node node_modules\electron\cli.js . 2>&1
echo.
echo Exit code: %ERRORLEVEL%
pause
