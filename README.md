# ice458.github.io

ice458の物置き — 製作物やメモを置いているサイトのソースです。
GitHub Pages 上の Jekyll でビルドされ、https://ice458.github.io/ で公開されています。

## 更新のしかた

`サイト管理.bat` をダブルクリックしてください。
使い方の詳細は、作業用 PC のリポジトリ直下にある `マニュアル.md` を参照。

## 構成

| 場所 | 中身 |
|---|---|
| `_layouts/` `_includes/` | 全ページ共通の骨格と部品 |
| `index.html` `blog.html` | 一覧ページ。中身は各記事の front matter から自動生成 |
| `project-*/` `blog/article-*/` | 各記事（front matter + 本文） |
| `site_manager.py` | 記事管理ツール（GUI） |
| `_tools/` | ローカルプレビュー用の簡易ビルダー |
| `tools/` | 公開している Web ツール（一部は submodule） |
