@echo off
echo ice458の物置き - プロジェクト管理ツール
echo ==========================================
echo.

REM Pythonがインストールされているかチェック
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo エラー: Pythonがインストールされていません。
    echo Python 3.6以上をインストールしてください。
    pause
    exit /b 1
)

REM 管理ツールを起動
echo プロジェクト管理ツールを起動しています...
python project_manager.py

pause
