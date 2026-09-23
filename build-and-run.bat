@echo off
chcp 65001 >nul
title AI Server Hub - Build and Run

echo ========================================
echo   AI Server Hub - Build and Run
echo ========================================
echo.

:: Check node
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found in PATH!
    echo Download from https://nodejs.org/
    pause
    exit /b 1
)
echo [OK] Node.js found: & node --version

cd /d "%~dp0"

:: Step 1: Build React navigation
echo.
echo [1/3] Installing and building React navigation...
cd renderer-react

call npm install 2>&1
if errorlevel 1 (
    echo [ERROR] npm install failed!
    pause
    exit /b 1
)

call npx vite build 2>&1
if errorlevel 1 (
    echo [ERROR] Vite build failed!
    pause
    exit /b 1
)

if not exist "%~dp0src\renderer\react-dist\admin-nav.iife.js" (
    echo [ERROR] Build output not found!
    pause
    exit /b 1
)
echo [OK] React navigation built.

:: Step 2: Electron deps
cd /d "%~dp0"
echo.
echo [2/3] Checking Electron dependencies...
if not exist "node_modules" (
    call npm install 2>&1
    if errorlevel 1 (
        echo [ERROR] npm install failed!
        pause
        exit /b 1
    )
)
echo [OK] Dependencies ready.

:: Step 3: Launch
echo.
echo [3/3] Starting Electron...
call npx electron .

echo.
echo App exited.
pause
