@echo off
echo ice458の物置き - サイトマップ更新ツール
echo ==========================================
echo.

cd /d "%~dp0"
python generate_sitemap.py

echo.
echo サイトマップの更新が完了しました。
echo Gitにコミット・プッシュを忘れずに！
echo.
pause
