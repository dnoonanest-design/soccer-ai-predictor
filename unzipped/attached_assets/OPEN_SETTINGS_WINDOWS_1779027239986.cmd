@echo off
cd /d "%~dp0"
if not exist dashboard_settings.env (
  echo Creating dashboard_settings.env...
  copy .env.example dashboard_settings.env >nul
)
notepad dashboard_settings.env
