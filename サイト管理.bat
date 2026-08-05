@echo off
chcp 65001 >nul
cd /d "%~dp0"
title site manager

python --version >nul 2>&1
if errorlevel 1 (
    echo.
    echo  Python が見つかりません。
    echo  https://www.python.org/downloads/ からインストールしてください。
    echo  インストール時に "Add Python to PATH" にチェックを入れてください。
    echo.
    pause
    exit /b 1
)

python -c "import yaml" >nul 2>&1
if errorlevel 1 (
    echo  必要な部品 ^(PyYAML^) を入れています...
    python -m pip install --quiet pyyaml
    if errorlevel 1 (
        echo  インストールに失敗しました。ネットワークを確認してください。
        pause
        exit /b 1
    )
)

python -X utf8 site_manager.py
if errorlevel 1 (
    echo.
    echo  エラーで終了しました。上の内容を確認してください。
    pause
)
