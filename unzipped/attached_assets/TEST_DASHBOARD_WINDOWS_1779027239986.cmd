@echo off
setlocal EnableExtensions
cd /d "%~dp0"
call RUN_DASHBOARD_WINDOWS.cmd --setup-only
if errorlevel 1 exit /b 1
call .venv\Scripts\activate.bat
python -m app.self_check
if errorlevel 1 (
    echo.
    echo Self-check failed. Copy the error above and send it here.
    pause
    exit /b 1
)
echo.
echo Self-check passed.
pause
