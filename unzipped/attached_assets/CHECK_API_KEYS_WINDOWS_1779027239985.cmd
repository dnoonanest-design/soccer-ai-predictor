@echo off
setlocal EnableExtensions
cd /d "%~dp0"
call RUN_DASHBOARD_WINDOWS.cmd --setup-only
if errorlevel 1 exit /b 1
.venv\Scripts\python.exe -c "from app.config import SETTINGS, SETTINGS_FILE; print('Settings file:', SETTINGS_FILE); print('ODDS_API_KEY detected:', bool(SETTINGS.odds_api_key)); print('Football API key detected:', bool(SETTINGS.api_football_key)); print('Refresh seconds:', SETTINGS.refresh_seconds)"
pause
