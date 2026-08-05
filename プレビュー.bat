@echo off
cd /d "%~dp0"
title ice458 site preview

python --version >nul 2>&1
if errorlevel 1 goto nopython

python _tools/build.py --serve
if errorlevel 1 goto err
exit /b 0

:nopython
echo.
echo   Python was not found on this PC.
echo.
echo   Install it from:  https://www.python.org/downloads/
echo   In the installer, check "Add Python to PATH".
echo.
echo   The manual in this folder has more details.
echo.
pause
exit /b 1

:err
echo.
echo   Finished with an error. Please read the message above.
echo.
pause
exit /b 1
