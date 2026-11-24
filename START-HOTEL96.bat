@echo off
setlocal
cd /d "%~dp0"
title HOTEL 96 - Server
color 0B

echo ========================================
echo            HOTEL 96 SERVER
echo ========================================
echo.

set "USE_PORTABLE=0"
where node >nul 2>nul
if errorlevel 1 set "USE_PORTABLE=1"
if not "%USE_PORTABLE%"=="1" (
    node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 18 ? 0 : 1)" >nul 2>nul
    if errorlevel 1 set "USE_PORTABLE=1"
)

if "%USE_PORTABLE%"=="1" (
    if not exist ".runtime\node.exe" (
        echo بار اول است؛ ابزار اجراي لازم را خودکار دريافت مي‌کنم...
        powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-node.ps1"
        if errorlevel 1 (
            echo.
            echo دريافت Node.js ناموفق بود. اتصال اينترنت را بررسي کن.
            pause
            exit /b 1
        )
    )
    set "PATH=%~dp0.runtime;%PATH%"
)

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js پيدا نشد.
    pause
    exit /b 1
)

echo نسخه Node.js:
node --version
echo.

node -e "require.resolve('socket.io'); require.resolve('pg')" >nul 2>nul
if errorlevel 1 (
    echo در حال آماده‌سازی سرور (فقط بار اول)...
    call npm install --no-audit --no-fund
    if errorlevel 1 (
        echo.
        echo نصب کتابخانه‌ها ناموفق بود. اتصال اینترنت را بررسی کن.
        pause
        exit /b 1
    )
)
echo.
echo آدرس اين کامپيوتر براي دستگاه‌هاي همين Wi-Fi:
powershell -NoProfile -Command "Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | ForEach-Object { Write-Host ('  http://' + $_.IPAddress + ':3000') }"
echo.
echo اين پنجره را باز نگه دار تا سرور روشن بماند.
echo براي خاموش کردن سرور، کليدهاي Ctrl + C را بزن.
echo.
start "" /b cmd /c "timeout /t 2 /nobreak >nul ^& start http://localhost:3000"
call npm start
pause
