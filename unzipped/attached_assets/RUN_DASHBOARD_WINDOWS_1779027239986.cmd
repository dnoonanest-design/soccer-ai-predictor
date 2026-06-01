@echo off
setlocal EnableExtensions
cd /d "%~dp0"

if not exist "requirements.txt" (
    echo ERROR: requirements.txt was not found in this folder:
    echo %CD%
    echo.
    echo Fix:
    echo 1. Right-click the ZIP file and choose Extract All.
    echo 2. Open the extracted dashboard folder.
    echo 3. Double-click RUN_DASHBOARD_WINDOWS.cmd from inside that folder.
    echo.
    echo Do not run this file from inside the ZIP preview window.
    pause
    exit /b 1
)

if not exist "run_dashboard.py" (
    echo ERROR: run_dashboard.py was not found in this folder:
    echo %CD%
    echo The files may not have extracted correctly. Extract the full ZIP again.
    pause
    exit /b 1
)

echo ================================================
echo Live Soccer Probability Dashboard
echo ================================================
echo Folder: %CD%
echo.

set PYEXE=
where py >nul 2>nul
if not errorlevel 1 set PYEXE=py -3
if "%PYEXE%"=="" (
    where python >nul 2>nul
    if not errorlevel 1 set PYEXE=python
)

if "%PYEXE%"=="" (
    echo Python was not found on this PC.
    echo.
    echo Install Python 3.11+ from https://www.python.org/downloads/windows/
    echo IMPORTANT: tick "Add Python to PATH" during installation.
    echo.
    pause
    exit /b 1
)

%PYEXE% --version
if errorlevel 1 (
    echo.
    echo Python command exists but did not run correctly.
    echo If Microsoft Store opens, disable python.exe and python3.exe aliases in:
    echo Settings ^> Apps ^> Advanced app settings ^> App execution aliases
    pause
    exit /b 1
)

if not exist "dashboard_settings.env" (
    copy ".env.example" "dashboard_settings.env" >nul
    echo Created dashboard_settings.env for your API keys/settings.
)

if not exist ".venv\Scripts\python.exe" (
    echo Creating Python environment...
    %PYEXE% -m venv .venv
    if errorlevel 1 (
        echo.
        echo Failed to create Python environment.
        echo Reinstall Python with "Add Python to PATH" ticked.
        pause
        exit /b 1
    )
)

set VPY=.venv\Scripts\python.exe

%VPY% -m pip --version >nul 2>nul
if errorlevel 1 (
    echo Repairing pip...
    %VPY% -m ensurepip --upgrade
    if errorlevel 1 goto package_error
)

echo Checking required packages...
%VPY% -c "import fastapi, uvicorn, httpx, dotenv; import uvicorn.main" >nul 2>nul
if errorlevel 1 goto install_packages

for %%F in ("requirements.txt") do for %%G in (".venv\installed_requirements.ok") do if not exist "%%~G" goto install_packages
for %%F in ("requirements.txt") do for %%G in (".venv\installed_requirements.ok") do if "%%~tF" GTR "%%~tG" goto install_packages

goto after_install

:install_packages
echo Installing/updating required packages...
%VPY% -m pip install --upgrade pip
if errorlevel 1 goto package_error
%VPY% -m pip install --upgrade --no-cache-dir -r "%CD%\requirements.txt"
if errorlevel 1 goto package_error
%VPY% -c "import fastapi, uvicorn, httpx, dotenv; import uvicorn.main" >nul 2>nul
if errorlevel 1 goto package_error
echo ok> ".venv\installed_requirements.ok"

:after_install
%VPY% -m compileall -q app run_dashboard.py
if errorlevel 1 (
    echo.
    echo Python code check failed. The program files may be damaged.
    pause
    exit /b 1
)

if /I "%~1"=="--setup-only" (
    echo Setup complete.
    exit /b 0
)

echo.
echo Starting dashboard...
echo A browser window should open automatically.
echo Leave this black window open while using the dashboard.
echo Press CTRL+C here to stop it.
echo.
%VPY% run_dashboard.py
pause
exit /b 0

:package_error
echo.
echo Package installation failed or a required module is still missing.
echo Check your internet connection, then try again.
echo If antivirus blocks .venv, unzip this folder somewhere trusted like Documents.
echo Current folder: %CD%
echo.
echo Manual repair command:
echo .\.venv\Scripts\python.exe -m pip install --upgrade --no-cache-dir -r requirements.txt
pause
exit /b 1
