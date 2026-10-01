@echo off
cd /d "%~dp0"
where py >nul 2>nul
if not errorlevel 1 (
    py -3 tools\launch.py %*
) else (
    python tools\launch.py %*
)
if errorlevel 1 (
    echo.
    echo X-AI did not start. See the message above. Python 3.10+ is required.
    pause
)
