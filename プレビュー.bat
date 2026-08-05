@echo off
chcp 65001 >nul
cd /d "%~dp0"
title site preview

python --version >nul 2>&1
if errorlevel 1 (
    echo  Python が見つかりません。site_manager と同じ手順で入れてください。
    pause
    exit /b 1
)

python -c "import yaml" >nul 2>&1
if errorlevel 1 python -m pip install --quiet pyyaml

echo.
echo  サイトを組み立ててブラウザで開きます。
echo  このウィンドウを閉じるとプレビューは終了します。
echo.
python -X utf8 _tools/build.py --serve
if errorlevel 1 pause
