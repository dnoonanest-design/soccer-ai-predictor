@echo off
setlocal
cd /d "%~dp0"
if exist .venv\Scripts\python.exe (
  .venv\Scripts\python.exe -m app.halftime_backtest
) else (
  python -m app.halftime_backtest
)
pause
