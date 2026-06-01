@echo off
cd /d "%~dp0"
if not exist dashboard_settings.env copy .env.example dashboard_settings.env >nul
start "" http://127.0.0.1:8000
SoccerDashboard.exe
pause
