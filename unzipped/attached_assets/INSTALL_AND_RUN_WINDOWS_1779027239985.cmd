@echo off
setlocal EnableExtensions
cd /d "%~dp0"
echo This will install/repair the local Python environment and start the dashboard.
echo.
call RUN_DASHBOARD_WINDOWS.cmd --setup-only
if errorlevel 1 exit /b 1
call RUN_DASHBOARD_WINDOWS.cmd
