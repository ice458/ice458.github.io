#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
雑多なメモ等管理GUI - ice458の物置き
雑多なメモ等記事の情報を管理するためのGUIアプリケーション
"""

import tkinter as tk
from tkinter import ttk, messagebox, filedialog
import re
import os
import webbrowser
from pathlib import Path
from datetime import datetime

class BlogManager:
    def __init__(self, root):
        self.root = root
        self.root.title("ice458の物置き - 雑多なメモ等管理")
        self.root.geometry("1200x800")

        # HTMLファイルのパス（雑多なメモ等用の新しいページ）
        self.html_file = Path(__file__).parent / "blog.html"

        # 雑多なメモ等記事データを格納するリスト
        self.articles = []

        # 利用可能なカテゴリ（動的に更新される）
        self.categories = ["技術メモ", "雑記", "読書", "ツール", "Web", "ハードウェア", "ソフトウェア"]

        self.setup_ui()
        self.load_articles()

    def update_categories(self):
        """記事から全カテゴリを抽出して更新"""
        all_categories = set()
        for article in self.articles:
            for category in article['categories']:
                all_categories.add(category.strip())

        # 既存のカテゴリを保持しつつ新しいカテゴリを追加
        self.categories = sorted(list(all_categories))

    def setup_ui(self):
        """UIセットアップ"""
        # メインフレーム
        main_frame = ttk.Frame(self.root, padding="10")
        main_frame.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))

        # ウィンドウのリサイズ設定
        self.root.columnconfigure(0, weight=1)
        self.root.rowconfigure(0, weight=1)
        main_frame.columnconfigure(1, weight=1)
        main_frame.rowconfigure(1, weight=1)

        # タイトル
        title_label = ttk.Label(main_frame, text="ice458の物置き - 雑多なメモ等管理",
                               font=("Arial", 16, "bold"))
        title_label.grid(row=0, column=0, columnspan=3, pady=(0, 10))

        # ボタンフレーム
        button_frame = ttk.Frame(main_frame)
        button_frame.grid(row=1, column=0, sticky=(tk.W, tk.E, tk.N), padx=(0, 10))

        # ボタン群
        ttk.Button(button_frame, text="新規記事追加",
                  command=self.add_article, width=20).grid(row=0, column=0, pady=2, sticky=tk.W)
        ttk.Button(button_frame, text="編集",
                  command=self.edit_article, width=20).grid(row=1, column=0, pady=2, sticky=tk.W)
        ttk.Button(button_frame, text="削除",
                  command=self.delete_article, width=20).grid(row=2, column=0, pady=2, sticky=tk.W)
        ttk.Button(button_frame, text="上に移動",
                  command=self.move_up, width=20).grid(row=3, column=0, pady=2, sticky=tk.W)
        ttk.Button(button_frame, text="下に移動",
                  command=self.move_down, width=20).grid(row=4, column=0, pady=2, sticky=tk.W)

        ttk.Separator(button_frame, orient='horizontal').grid(row=5, column=0, sticky=(tk.W, tk.E), pady=10)

        ttk.Button(button_frame, text="記事ページ生成",
                  command=self.generate_article_page, width=20).grid(row=6, column=0, pady=2, sticky=tk.W)

        ttk.Separator(button_frame, orient='horizontal').grid(row=7, column=0, sticky=(tk.W, tk.E), pady=10)

        ttk.Button(button_frame, text="保存",
                  command=self.save_articles, width=20).grid(row=8, column=0, pady=2, sticky=tk.W)
        ttk.Button(button_frame, text="リロード",
                  command=self.load_articles, width=20).grid(row=9, column=0, pady=2, sticky=tk.W)
        ttk.Button(button_frame, text="プレビュー",
                  command=self.preview_blog, width=20).grid(row=10, column=0, pady=2, sticky=tk.W)

        # 記事リスト
        list_frame = ttk.Frame(main_frame)
        list_frame.grid(row=1, column=1, sticky=(tk.W, tk.E, tk.N, tk.S))
        list_frame.columnconfigure(0, weight=1)
        list_frame.rowconfigure(0, weight=1)

        # ツリービュー
        self.tree = ttk.Treeview(list_frame, columns=('title', 'date', 'categories', 'summary'),
                                show='headings', height=15)
        self.tree.heading('title', text='記事タイトル')
        self.tree.heading('date', text='日付')
        self.tree.heading('categories', text='カテゴリ')
        self.tree.heading('summary', text='概要')

        # 列幅設定
        self.tree.column('title', width=250, minwidth=200)
        self.tree.column('date', width=100, minwidth=80)
        self.tree.column('categories', width=150, minwidth=100)
        self.tree.column('summary', width=300, minwidth=200)

        # スクロールバー
        scrollbar = ttk.Scrollbar(list_frame, orient=tk.VERTICAL, command=self.tree.yview)
        self.tree.configure(yscrollcommand=scrollbar.set)

        self.tree.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        scrollbar.grid(row=0, column=1, sticky=(tk.N, tk.S))

        # ダブルクリックで編集
        self.tree.bind('<Double-1>', lambda e: self.edit_article())

        # 詳細表示フレーム
        detail_frame = ttk.LabelFrame(main_frame, text="記事詳細", padding="10")
        detail_frame.grid(row=1, column=2, sticky=(tk.W, tk.E, tk.N), padx=(10, 0))

        # 詳細表示用のテキストウィジェット
        self.detail_text = tk.Text(detail_frame, width=35, height=15, wrap=tk.WORD)
        detail_scroll = ttk.Scrollbar(detail_frame, orient=tk.VERTICAL, command=self.detail_text.yview)
        self.detail_text.configure(yscrollcommand=detail_scroll.set)

        self.detail_text.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        detail_scroll.grid(row=0, column=1, sticky=(tk.N, tk.S))

        # 選択変更時のイベント
        self.tree.bind('<<TreeviewSelect>>', self.on_select)

        # ステータスバー
        self.status_var = tk.StringVar()
        self.status_var.set("準備完了")
        status_bar = ttk.Label(main_frame, textvariable=self.status_var,
                              relief=tk.SUNKEN, anchor=tk.W)
        status_bar.grid(row=2, column=0, columnspan=3, sticky=(tk.W, tk.E), pady=(10, 0))

    def load_articles(self):
        """HTMLファイルから雑多なメモ等記事情報を読み込み"""
        try:
            if not self.html_file.exists():
                self.status_var.set("blog.htmlファイルが見つかりません。")
                return

            with open(self.html_file, 'r', encoding='utf-8') as f:
                content = f.read()

            # 記事カードを抽出する正規表現パターン（data-search属性も含める）
            # 新しいフォーマット（data-search属性あり）を最初に試す
            pattern_new = r'<div class="article-card" data-categories="([^"]*)" data-date="([^"]*)" data-search="([^"]*)">\s*<div class="article-meta">\s*<div class="article-date">([^<]*)</div>\s*<div class="article-categories">(.*?)</div>\s*</div>\s*<h2 class="article-title"><a href="([^"]*)">(.*?)</a></h2>\s*<p class="article-summary">(.*?)</p>\s*</div>'

            # 古いフォーマット（data-search属性なし）にも対応
            pattern_old = r'<div class="article-card" data-categories="([^"]*)" data-date="([^"]*)">\s*<div class="article-meta">\s*<div class="article-date">([^<]*)</div>\s*<div class="article-categories">(.*?)</div>\s*</div>\s*<h2 class="article-title"><a href="([^"]*)">(.*?)</a></h2>\s*<p class="article-summary">(.*?)</p>\s*</div>'

            # 新しいフォーマットを最初に試す
            matches = re.findall(pattern_new, content, re.DOTALL)

            # 新しいフォーマットがなければ古いフォーマットを試す
            if not matches:
                matches_old = re.findall(pattern_old, content, re.DOTALL)
                # 古いフォーマットの場合はsearch_termsを空文字列に設定
                matches = []
                for match in matches_old:
                    categories_str, date_attr, date_display, category_html, link, title, summary = match
                    matches.append((categories_str, date_attr, '', date_display, category_html, link, title, summary))

            self.articles.clear()
            for i, match in enumerate(matches):
                categories_str, date_attr, search_terms, date_display, category_html, link, title, summary = match

                # カテゴリタグからカテゴリ名を抽出
                category_tags = re.findall(r'<span class="category-tag">([^<]*)</span>', category_html)

                article = {
                    'title': title.strip(),
                    'date': date_display.strip(),
                    'categories': categories_str.split(',') if categories_str else [],
                    'summary': summary.strip(),
                    'link': link.strip(),
                    'search_terms': search_terms.strip()
                }
                self.articles.append(article)

            self.update_tree()
            self.update_categories()
            self.status_var.set(f"{len(self.articles)}件の記事を読み込みました")

        except Exception as e:
            messagebox.showerror("エラー", f"記事の読み込みに失敗しました: {str(e)}")

    def update_tree(self):
        """ツリービューを更新"""
        # 既存のアイテムを削除
        for item in self.tree.get_children():
            self.tree.delete(item)

        # 記事を追加
        for i, article in enumerate(self.articles):
            categories_str = ', '.join([cat.strip() for cat in article['categories']])
            self.tree.insert('', 'end', iid=i, values=(
                article['title'],
                article['date'],
                categories_str,
                article['summary'][:50] + '...' if len(article['summary']) > 50 else article['summary']
            ))

    def on_select(self, event=None):
        """ツリービューの選択変更時"""
        selection = self.tree.selection()
        if selection:
            index = int(selection[0])
            article = self.articles[index]

            # 詳細表示を更新
            self.detail_text.delete(1.0, tk.END)
            detail = f"記事タイトル: {article['title']}\n\n"
            detail += f"日付: {article['date']}\n\n"
            detail += f"カテゴリ: {', '.join(article['categories'])}\n\n"
            detail += f"リンク: {article['link']}\n\n"
            detail += f"概要:\n{article['summary']}"

            self.detail_text.insert(1.0, detail)

    def add_article(self):
        """新規記事追加"""
        self.open_article_dialog()

    def edit_article(self):
        """選択された記事を編集"""
        selection = self.tree.selection()
        if not selection:
            messagebox.showwarning("警告", "編集する記事を選択してください")
            return

        index = int(selection[0])
        self.open_article_dialog(index)

    def delete_article(self):
        """選択された記事を削除"""
        selection = self.tree.selection()
        if not selection:
            messagebox.showwarning("警告", "削除する記事を選択してください")
            return

        index = int(selection[0])
        article = self.articles[index]

        if messagebox.askyesno("確認", f"'{article['title']}'を削除しますか？"):
            del self.articles[index]
            self.update_tree()
            self.status_var.set("記事を削除しました")

    def move_up(self):
        """選択された記事を上に移動"""
        selection = self.tree.selection()
        if not selection:
            messagebox.showwarning("警告", "移動する記事を選択してください")
            return

        index = int(selection[0])
        if index == 0:
            return

        # リスト内で位置を交換
        self.articles[index], self.articles[index-1] = self.articles[index-1], self.articles[index]
        self.update_tree()

        # 選択を維持
        self.tree.selection_set(str(index-1))
        self.tree.focus(str(index-1))

    def move_down(self):
        """選択された記事を下に移動"""
        selection = self.tree.selection()
        if not selection:
            messagebox.showwarning("警告", "移動する記事を選択してください")
            return

        index = int(selection[0])
        if index >= len(self.articles) - 1:
            return

        # リスト内で位置を交換
        self.articles[index], self.articles[index+1] = self.articles[index+1], self.articles[index]
        self.update_tree()

        # 選択を維持
        self.tree.selection_set(str(index+1))
        self.tree.focus(str(index+1))

    def open_article_dialog(self, index=None):
        """記事編集ダイアログを開く"""
        dialog = ArticleDialog(self.root, self.categories)

        if index is not None:
            # 編集モード
            article = self.articles[index]
            dialog.set_article_data(article)

        result = dialog.show()
        if result:
            if index is not None:
                # 既存記事を更新
                self.articles[index] = result
                self.status_var.set("記事を更新しました")
            else:
                # 新規記事を追加（一番上に追加）
                self.articles.insert(0, result)
                self.status_var.set("新規記事を追加しました")

            self.update_tree()

            # 新規追加または編集された記事を選択状態にする
            if index is not None:
                self.tree.selection_set(str(index))
                self.tree.focus(str(index))
            else:
                self.tree.selection_set(str(0))
                self.tree.focus(str(0))

    def save_articles(self):
        """記事情報をHTMLファイルに保存"""
        try:
            if not self.html_file.exists():
                messagebox.showerror("エラー", f"雑多なメモ等ページが見つかりません: {self.html_file}")
                return

            # バックアップを作成
            backup_file = self.html_file.with_suffix('.bak')
            with open(self.html_file, 'r', encoding='utf-8') as f:
                backup_content = f.read()
            with open(backup_file, 'w', encoding='utf-8') as f:
                f.write(backup_content)

            # HTMLファイルを読み込み
            with open(self.html_file, 'r', encoding='utf-8') as f:
                content = f.read()

            # 記事カードを生成
            article_cards = []
            for article in self.articles:
                # カテゴリタグを生成
                category_tags = []
                for cat in article['categories']:
                    category_tags.append(f'<span class="category-tag">{cat.strip()}</span>')

                category_html = '\n                                '.join(category_tags) if category_tags else ''

                # データ属性用のカテゴリ文字列
                data_categories = ','.join([cat.strip() for cat in article['categories']])

                # 検索用キーワード（search_termsがない場合は空文字列）
                search_terms = article.get('search_terms', '')

                card = f'''                    <div class="article-card" data-categories="{data_categories}" data-date="{article['date']}" data-search="{search_terms}">
                        <div class="article-meta">
                            <div class="article-date">{article['date']}</div>
                            <div class="article-categories">
                                {category_html}
                            </div>
                        </div>
                        <h2 class="article-title"><a href="{article['link']}">{article['title']}</a></h2>
                        <p class="article-summary">{article['summary']}</p>
                    </div>'''
                article_cards.append(card)

            # 記事グリッドを置換 - より具体的なパターンを使用
            grid_pattern = r'(<div class="articles-grid">\s*)((?:(?!</div>\s*</div>\s*</div>).)*?)(\s*</div>\s*</div>\s*</div>)'
            new_articles_html = '\n'.join(article_cards)
            new_grid = f"\\g<1>\n{new_articles_html}\n\\g<3>"

            new_content = re.sub(grid_pattern, new_grid, content, flags=re.DOTALL)

            # HTMLの構造を修正（余分な断片やタグの重複を削除）
            # 1. 余分な空行を削除
            new_content = re.sub(r'\n\s*\n\s*\n+', '\n\n', new_content)

            # 2. 不正な閉じタグの構造を修正
            new_content = re.sub(r'</div>\s*<div class="article-categories">', '</div>', new_content)

            # 3. article-categories divが欠落している場合の修正
            new_content = re.sub(
                r'(<div class="article-date">[^<]+</div>\s*)((?!<div class="article-categories">)(<span class="category-tag">))',
                r'\1<div class="article-categories">\n                                \3',
                new_content
            )

            # 4. 不正にネストされた終了タグを修正
            new_content = re.sub(
                r'(<span class="category-tag">[^<]+</span>(?:\s*<span class="category-tag">[^<]+</span>)*)\s*</div>\s*</div>',
                r'\1\n                            </div>\n                        </div>',
                new_content
            )

            # フィルタボタンも更新
            self.update_categories()
            filter_buttons = []
            filter_buttons.append('                    <button class="filter-btn active" data-category="all">全て</button>')
            for category in sorted(self.categories):
                filter_buttons.append(f'                    <button class="filter-btn" data-category="{category}">{category}</button>')

            # フィルタボタン部分を置換
            filter_pattern = r'(<div class="filter-buttons">\s*)(.*?)(\s*</div>)'
            new_filter_html = '\n'.join(filter_buttons)
            new_filter_buttons = f"\\g<1>\n{new_filter_html}\n\\g<3>"
            new_content = re.sub(filter_pattern, new_filter_buttons, new_content, flags=re.DOTALL)

            # ファイルに保存
            with open(self.html_file, 'w', encoding='utf-8') as f:
                f.write(new_content)

            self.status_var.set("記事情報を保存しました")
            messagebox.showinfo("成功", f"記事情報を保存しました\n（バックアップ: {backup_file}）")

        except Exception as e:
            messagebox.showerror("エラー", f"保存に失敗しました: {str(e)}")

    def preview_blog(self):
        """ブラウザで雑多なメモ等をプレビュー"""
        if self.html_file.exists():
            webbrowser.open(f"file:///{self.html_file.absolute()}")
        else:
            messagebox.showerror("エラー", "雑多なメモ等ページが見つかりません")

    def generate_article_page(self):
        """選択された記事のページを生成"""
        selection = self.tree.selection()
        if not selection:
            messagebox.showwarning("警告", "記事ページを生成する記事を選択してください")
            return

        index = int(selection[0])
        article = self.articles[index]

        try:
            # 記事用のディレクトリを作成
            article_slug = self.create_article_slug(article['title'])
            article_dir = self.html_file.parent / "blog" / article_slug
            article_dir.mkdir(parents=True, exist_ok=True)

            # テンプレートファイルのパス
            template_dir = self.html_file.parent / "templates"
            template_file = template_dir / "blog_template.html"

            if not template_file.exists():
                messagebox.showerror("エラー", f"雑多なメモ等テンプレートファイルが見つかりません: {template_file}")
                return

            # テンプレートを読み込み
            with open(template_file, 'r', encoding='utf-8') as f:
                template_content = f.read()

            # カテゴリタグを生成
            category_tags = []
            for cat in article['categories']:
                category_tags.append(f'<span class="category-tag">{cat.strip()}</span>')
            category_tags_html = '\n                        '.join(category_tags)

            # プレースホルダーを置換
            content = template_content.replace('{{TITLE}}', article['title'])
            content = content.replace('{{SUMMARY}}', article['summary'])
            content = content.replace('{{CATEGORY_TAGS}}', category_tags_html)
            content = content.replace('{{DATE}}', article['date'])

            # 記事ファイルを保存
            article_file = article_dir / "index.html"
            with open(article_file, 'w', encoding='utf-8') as f:
                f.write(content)

            # 画像用ディレクトリも作成
            img_dir = article_dir / "img"
            img_dir.mkdir(exist_ok=True)

            # 記事のリンクを更新
            old_link = article['link']
            new_link = f"blog/{article_slug}/index.html"
            article['link'] = new_link
            self.update_tree()

            success_message = f"記事ページを生成しました:\n{article_file}\n\nディレクトリ: {article_dir}\nスラッグ: {article_slug}"
            if old_link != new_link:
                success_message += f"\nリンクも更新されました: {old_link} -> {new_link}"

            messagebox.showinfo("成功", success_message)
            self.status_var.set(f"'{article['title']}'の記事ページを生成しました")

        except Exception as e:
            messagebox.showerror("エラー", f"記事ページの生成に失敗しました: {str(e)}")

    def generate_category_tags(self, categories):
        """カテゴリタグのHTMLを生成"""
        tags = []
        for cat in categories:
            tags.append(f'<span class="category-tag">{cat.strip()}</span>')
        return '\n                        '.join(tags)

    def create_article_slug(self, title):
        """記事タイトルからURLスラッグを生成"""
        import re
        import unicodedata
        import hashlib

        # まず文字列を正規化
        normalized_title = unicodedata.normalize('NFKC', title)

        # 日本語文字が含まれている場合は、MD5ベースの一貫したスラッグを生成
        if any(ord(c) > 127 for c in normalized_title):
            # MD5ハッシュを使用して一貫したスラッグを生成
            hash_obj = hashlib.md5(normalized_title.encode('utf-8'))
            hash_num = int(hash_obj.hexdigest()[:4], 16)  # 16進数の最初の4文字を数値に
            slug = f"article-{hash_num}"
            return slug

        # 英数字のみの場合は従来の処理
        slug = re.sub(r'[^\w\-]', '-', normalized_title.lower())
        slug = re.sub(r'-+', '-', slug)  # 連続するハイフンを1つに
        slug = slug.strip('-')  # 先頭と末尾のハイフンを削除

        # スラッグが短すぎる場合
        if not slug or len(slug) < 3:
            hash_obj = hashlib.md5(normalized_title.encode('utf-8'))
            hash_num = int(hash_obj.hexdigest()[:4], 16)
            slug = f"article-{hash_num}"

        return slug


class ArticleDialog:
    def __init__(self, parent, categories):
        self.parent = parent
        self.categories = categories
        self.result = None

        self.dialog = tk.Toplevel(parent)
        self.dialog.title("記事編集")
        self.dialog.geometry("600x600")
        self.dialog.transient(parent)
        self.dialog.grab_set()

        self.setup_dialog()

    def setup_dialog(self):
        """ダイアログのUIセットアップ"""
        main_frame = ttk.Frame(self.dialog, padding="20")
        main_frame.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))

        self.dialog.columnconfigure(0, weight=1)
        self.dialog.rowconfigure(0, weight=1)
        main_frame.columnconfigure(1, weight=1)

        row = 0

        # 記事タイトル
        ttk.Label(main_frame, text="記事タイトル:").grid(row=row, column=0, sticky=tk.W, pady=5)
        self.title_var = tk.StringVar()
        ttk.Entry(main_frame, textvariable=self.title_var, width=40).grid(row=row, column=1, sticky=(tk.W, tk.E), pady=5)
        row += 1

        # 日付
        ttk.Label(main_frame, text="日付:").grid(row=row, column=0, sticky=tk.W, pady=5)
        self.date_var = tk.StringVar()
        date_frame = ttk.Frame(main_frame)
        date_frame.grid(row=row, column=1, sticky=(tk.W, tk.E), pady=5)
        ttk.Entry(date_frame, textvariable=self.date_var, width=30).grid(row=0, column=0, sticky=(tk.W, tk.E))
        ttk.Button(date_frame, text="今日", command=self.set_today).grid(row=0, column=1, padx=(5, 0))
        date_frame.columnconfigure(0, weight=1)
        row += 1

        # リンク
        ttk.Label(main_frame, text="リンク:").grid(row=row, column=0, sticky=tk.W, pady=5)
        self.link_var = tk.StringVar()
        ttk.Entry(main_frame, textvariable=self.link_var, width=40).grid(row=row, column=1, sticky=(tk.W, tk.E), pady=5)
        row += 1

        # カテゴリ選択
        ttk.Label(main_frame, text="カテゴリ:").grid(row=row, column=0, sticky=(tk.W, tk.N), pady=5)
        category_frame = ttk.Frame(main_frame)
        category_frame.grid(row=row, column=1, sticky=(tk.W, tk.E), pady=5)

        self.category_vars = {}
        for i, category in enumerate(self.categories):
            var = tk.BooleanVar()
            self.category_vars[category] = var
            ttk.Checkbutton(category_frame, text=category, variable=var).grid(row=i//3, column=i%3, sticky=tk.W, padx=5)
        row += 1

        # 新しいカテゴリ
        ttk.Label(main_frame, text="新しいカテゴリ:").grid(row=row, column=0, sticky=tk.W, pady=5)
        new_cat_frame = ttk.Frame(main_frame)
        new_cat_frame.grid(row=row, column=1, sticky=(tk.W, tk.E), pady=5)
        new_cat_frame.columnconfigure(0, weight=1)

        self.new_category_var = tk.StringVar()
        ttk.Entry(new_cat_frame, textvariable=self.new_category_var, width=40).grid(row=0, column=0, sticky=(tk.W, tk.E))

        # ヒントラベルを追加
        hint_label = ttk.Label(new_cat_frame, text="複数の場合は「,」「;」「、」で区切る",
                              font=("Arial", 8), foreground="gray")
        hint_label.grid(row=1, column=0, sticky=tk.W)
        row += 1

        # 検索キーワード
        ttk.Label(main_frame, text="検索キーワード:").grid(row=row, column=0, sticky=tk.W, pady=5)
        search_frame = ttk.Frame(main_frame)
        search_frame.grid(row=row, column=1, sticky=(tk.W, tk.E), pady=5)
        search_frame.columnconfigure(0, weight=1)

        self.search_terms_var = tk.StringVar()
        ttk.Entry(search_frame, textvariable=self.search_terms_var, width=40).grid(row=0, column=0, sticky=(tk.W, tk.E))

        # 検索キーワードのヒントラベルを追加
        search_hint_label = ttk.Label(search_frame, text="検索で使用されるキーワード（スペース区切り）",
                              font=("Arial", 8), foreground="gray")
        search_hint_label.grid(row=1, column=0, sticky=tk.W)
        row += 1

        # 概要
        ttk.Label(main_frame, text="概要:").grid(row=row, column=0, sticky=(tk.W, tk.N), pady=5)
        text_frame = ttk.Frame(main_frame)
        text_frame.grid(row=row, column=1, sticky=(tk.W, tk.E, tk.N, tk.S), pady=5)

        self.summary_text = tk.Text(text_frame, width=40, height=8, wrap=tk.WORD)
        summary_scroll = ttk.Scrollbar(text_frame, orient=tk.VERTICAL, command=self.summary_text.yview)
        self.summary_text.configure(yscrollcommand=summary_scroll.set)

        self.summary_text.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        summary_scroll.grid(row=0, column=1, sticky=(tk.N, tk.S))

        text_frame.columnconfigure(0, weight=1)
        text_frame.rowconfigure(0, weight=1)
        main_frame.rowconfigure(row, weight=1)
        row += 1

        # ボタン
        button_frame = ttk.Frame(main_frame)
        button_frame.grid(row=row, column=0, columnspan=2, pady=20)

        ttk.Button(button_frame, text="OK", command=self.ok_clicked).grid(row=0, column=0, padx=5)
        ttk.Button(button_frame, text="キャンセル", command=self.cancel_clicked).grid(row=0, column=1, padx=5)

        # 初期値設定
        self.set_today()

    def set_today(self):
        """今日の日付を設定"""
        today = datetime.now().strftime('%Y年%m月%d日')
        self.date_var.set(today)

    def set_article_data(self, article):
        """既存記事データを設定"""
        self.title_var.set(article['title'])
        self.date_var.set(article['date'])
        self.link_var.set(article['link'])
        self.summary_text.insert(1.0, article['summary'])

        # 検索キーワードを設定
        self.search_terms_var.set(article.get('search_terms', ''))

        # カテゴリを設定
        for category in article['categories']:
            category = category.strip()
            if category in self.category_vars:
                self.category_vars[category].set(True)

    def ok_clicked(self):
        """OKボタンクリック"""
        title = self.title_var.get().strip()
        if not title:
            messagebox.showerror("エラー", "記事タイトルを入力してください")
            return

        date = self.date_var.get().strip()
        if not date:
            messagebox.showerror("エラー", "日付を入力してください")
            return

        # 選択されたカテゴリを収集
        categories = []
        for category, var in self.category_vars.items():
            if var.get():
                categories.append(category)

        # 新しいカテゴリを追加（複数対応）
        new_categories_text = self.new_category_var.get().strip()
        if new_categories_text:
            # カンマ、セミコロン、日本語読点、改行で分割
            import re
            new_categories = re.split(r'[,;、\n]+', new_categories_text)
            for cat in new_categories:
                cat = cat.strip()
                if cat and cat not in categories:  # 重複を避ける
                    categories.append(cat)

        if not categories:
            messagebox.showerror("エラー", "少なくとも1つのカテゴリを選択してください")
            return

        self.result = {
            'title': title,
            'date': date,
            'link': self.link_var.get().strip() or f"#{title.lower().replace(' ', '-')}",
            'categories': categories,
            'summary': self.summary_text.get(1.0, tk.END).strip(),
            'search_terms': self.search_terms_var.get().strip()
        }

        self.dialog.destroy()

    def cancel_clicked(self):
        """キャンセルボタンクリック"""
        self.dialog.destroy()

    def show(self):
        """ダイアログを表示して結果を返す"""
        self.dialog.wait_window()
        return self.result


def main():
    root = tk.Tk()
    app = BlogManager(root)
    root.mainloop()


if __name__ == "__main__":
    main()
