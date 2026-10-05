@echo off
title aceHub - Windows Home Server
cd /d "%~dp0"
echo =======================================================
echo          Khoi dong aceHub Windows Server
echo =======================================================

:: Kiem tra va khoi dong AceStream Engine ngam neu chua chay
tasklist /FI "IMAGENAME eq ace_console.exe" 2>NUL | find /I /N "ace_console.exe">NUL
if "%ERRORLEVEL%"=="1" (
    tasklist /FI "IMAGENAME eq ace_engine.exe" 2>NUL | find /I /N "ace_engine.exe">NUL
    if "%ERRORLEVEL%"=="1" (
        echo [aceHub] Dang khoi dong AceStream Engine ngam...
        if exist "%APPDATA%\ACEStream\engine\ace_console.exe" (
            start "" /B "%APPDATA%\ACEStream\engine\ace_console.exe" --client-console
        ) else if exist "%APPDATA%\ACEStream\engine\ace_engine.exe" (
            start "" /B "%APPDATA%\ACEStream\engine\ace_engine.exe"
        )
        timeout /t 2 /nobreak >nul
    )
)

node acehub-server.js
pause
