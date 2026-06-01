@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ================================================
echo Build Windows EXE

echo ================================================
echo This creates dist\SoccerDashboard\SoccerDashboard.exe on your Windows PC.
echo.

call RUN_DASHBOARD_WINDOWS.cmd --setup-only
if not exist .venv\Scripts\python.exe (
    echo Python environment missing. Run INSTALL_AND_RUN_WINDOWS.cmd first.
    pause
    exit /b 1
)
call .venv\Scripts\activate.bat
python -m pip install pyinstaller
python -m PyInstaller --noconfirm --name SoccerDashboard --onedir --add-data "app;app" run_dashboard.py
if errorlevel 1 (
    echo EXE build failed.
    pause
    exit /b 1
)
copy .env.example dist\SoccerDashboard\dashboard_settings.env >nul
copy START_EXE_DASHBOARD.cmd dist\SoccerDashboard\START_EXE_DASHBOARD.cmd >nul

echo.
echo Build complete. Open:
echo dist\SoccerDashboard\START_EXE_DASHBOARD.cmd
echo or dist\SoccerDashboard\SoccerDashboard.exe
pause
