# ice458.github.io

ice458の物置き - 電子工作・製作物紹介サイト

## 概要

電子工作や製作物を紹介する個人サイトです。プロジェクトページと技術メモ・ブログを公開しています。

## サイト管理ツール

### プロジェクト管理
- `project_manager.py` - プロジェクトページの追加・編集・削除を行うGUIツール
- `run_manager.bat` - プロジェクト管理ツールを起動するバッチファイル

### ブログ管理
- `blog_manager.py` - ブログ記事の追加・編集・削除を行うGUIツール

### サイトマップ管理
- `generate_sitemap.py` - XMLサイトマップを自動生成するスクリプト
- `update_sitemap.bat` - サイトマップ更新を簡単に実行するバッチファイル

## 使用方法

### 新しいプロジェクトページを追加する場合
1. `run_manager.bat` を実行（または `python project_manager.py`）
2. 「新規プロジェクト追加」ボタンをクリック
3. 必要な情報を入力
4. 「保存」で index.html を更新
5. 「サイトマップ更新」で sitemap.xml を更新

### 新しいブログ記事を追加する場合
1. `python blog_manager.py` を実行
2. 「新規記事追加」ボタンをクリック
3. 必要な情報を入力
4. 「保存」で blog.html を更新
5. `update_sitemap.bat` でサイトマップを更新

### サイトマップを手動更新する場合
- `update_sitemap.bat` を実行（または `python generate_sitemap.py`）

## SEO対策

- **XMLサイトマップ**: `sitemap.xml` で全ページを検索エンジンに通知
- **robots.txt**: 検索エンジンのクロール指示
- **メタタグ**: description, keywords, Open Graph, Twitter Cards
- **構造化データ**: JSON-LD形式でサイト情報を提供
- **Google Site Verification**: 検索エンジンでのサイト確認

## ディレクトリ構造

```
├── index.html              # メインページ
├── blog.html              # ブログトップページ
├── links.html             # リンク集
├── sitemap.xml            # XMLサイトマップ
├── robots.txt             # 検索エンジン向け指示
├── project-*/             # プロジェクトページ（各ディレクトリ）
├── blog/article-*/        # ブログ記事（各ディレクトリ）
├── templates/             # テンプレートファイル
├── *_manager.py           # 管理ツール
└── generate_sitemap.py    # サイトマップ生成スクリプト
```

## 注意事項

- 新しいページを追加した後は必ずサイトマップを更新してください
- Git にコミット・プッシュを忘れずに実行してください
- Google Search Console でサイトマップを送信してください

## セキュリティ

このサイトはGitHub Pagesで公開されます。以下のセキュリティ対策を実装済みです：

- **管理ツールの除外**: `.gitignore` で Python管理ツールとバッチファイルを除外
- **robots.txt**: 検索エンジンによる管理ファイルのクロールを拒否
- **HTTPS**: GitHub Pagesで自動的に有効化
- **静的ファイルのみ**: サーバーサイドスクリプトは実行されません

### 管理ツールの取り扱い

管理ツール（`*_manager.py`, `*.bat`）はローカル環境でのみ使用し、公開リポジトリには含まれません：
- これらのファイルは `.gitignore` で除外されています
- 誤ってコミットしないよう注意してください
- ローカルでのサイト管理にのみ使用してください