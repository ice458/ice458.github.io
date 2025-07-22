#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
プロジェクト管理GUI - ice458の物置き
HTMLファイルのプロジェクト情報を管理するためのGUIアプリケーション
"""

import tkinter as tk
from tkinter import ttk, messagebox, filedialog
import re
import os
import webbrowser
from pathlib import Path

class ProjectManager:
    def __init__(self, root):
        self.root = root
        self.root.title("ice458の物置き - プロジェクト管理")
        self.root.geometry("1000x700")

        # HTMLファイルのパス
        self.html_file = Path(__file__).parent / "index.html"

        # プロジェクトデータを格納するリスト
        self.projects = []

        # 利用可能なカテゴリ（動的に更新される）
        self.categories = ["電子工作", "測定器", "音響", "時計", "無線"]

        self.setup_ui()
        self.load_projects()

    def update_categories(self):
        """プロジェクトから全カテゴリを抽出して更新"""
        all_categories = set()
        for project in self.projects:
            for category in project['categories']:
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
        title_label = ttk.Label(main_frame, text="ice458の物置き - プロジェクト管理",
                               font=("Arial", 16, "bold"))
        title_label.grid(row=0, column=0, columnspan=3, pady=(0, 10))

        # ボタンフレーム
        button_frame = ttk.Frame(main_frame)
        button_frame.grid(row=1, column=0, sticky=(tk.W, tk.E, tk.N), padx=(0, 10))

        # ボタン群
        ttk.Button(button_frame, text="新規プロジェクト追加",
                  command=self.add_project, width=20).grid(row=0, column=0, pady=2, sticky=tk.W)
        ttk.Button(button_frame, text="編集",
                  command=self.edit_project, width=20).grid(row=1, column=0, pady=2, sticky=tk.W)
        ttk.Button(button_frame, text="削除",
                  command=self.delete_project, width=20).grid(row=2, column=0, pady=2, sticky=tk.W)
        ttk.Button(button_frame, text="上に移動",
                  command=self.move_up, width=20).grid(row=3, column=0, pady=2, sticky=tk.W)
        ttk.Button(button_frame, text="下に移動",
                  command=self.move_down, width=20).grid(row=4, column=0, pady=2, sticky=tk.W)

        ttk.Separator(button_frame, orient='horizontal').grid(row=5, column=0, sticky=(tk.W, tk.E), pady=10)

        ttk.Button(button_frame, text="記事ページ生成",
                  command=self.generate_article_page, width=20).grid(row=6, column=0, pady=2, sticky=tk.W)
        ttk.Button(button_frame, text="リンク検証・修正",
                  command=self.validate_and_fix_links_ui, width=20).grid(row=7, column=0, pady=2, sticky=tk.W)
        ttk.Button(button_frame, text="記事カテゴリ更新",
                  command=self.update_article_categories_ui, width=20).grid(row=8, column=0, pady=2, sticky=tk.W)

        ttk.Separator(button_frame, orient='horizontal').grid(row=9, column=0, sticky=(tk.W, tk.E), pady=10)

        ttk.Button(button_frame, text="保存",
                  command=self.save_projects, width=20).grid(row=10, column=0, pady=2, sticky=tk.W)
        ttk.Button(button_frame, text="リロード",
                  command=self.load_projects, width=20).grid(row=11, column=0, pady=2, sticky=tk.W)
        ttk.Button(button_frame, text="プレビュー",
                  command=self.preview_site, width=20).grid(row=12, column=0, pady=2, sticky=tk.W)

        # プロジェクトリスト
        list_frame = ttk.Frame(main_frame)
        list_frame.grid(row=1, column=1, sticky=(tk.W, tk.E, tk.N, tk.S))
        list_frame.columnconfigure(0, weight=1)
        list_frame.rowconfigure(0, weight=1)

        # ツリービュー
        self.tree = ttk.Treeview(list_frame, columns=('title', 'categories', 'description'),
                                show='headings', height=15)
        self.tree.heading('title', text='プロジェクト名')
        self.tree.heading('categories', text='カテゴリ')
        self.tree.heading('description', text='説明')

        # 列幅設定
        self.tree.column('title', width=200, minwidth=150)
        self.tree.column('categories', width=150, minwidth=100)
        self.tree.column('description', width=300, minwidth=200)

        # スクロールバー
        scrollbar = ttk.Scrollbar(list_frame, orient=tk.VERTICAL, command=self.tree.yview)
        self.tree.configure(yscrollcommand=scrollbar.set)

        self.tree.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        scrollbar.grid(row=0, column=1, sticky=(tk.N, tk.S))

        # ダブルクリックで編集
        self.tree.bind('<Double-1>', lambda e: self.edit_project())

        # 詳細表示フレーム
        detail_frame = ttk.LabelFrame(main_frame, text="プロジェクト詳細", padding="10")
        detail_frame.grid(row=1, column=2, sticky=(tk.W, tk.E, tk.N), padx=(10, 0))

        # 詳細表示用のテキストウィジェット
        self.detail_text = tk.Text(detail_frame, width=30, height=10, wrap=tk.WORD)
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

    def load_projects(self):
        """HTMLファイルからプロジェクト情報を読み込み"""
        try:
            if not self.html_file.exists():
                messagebox.showerror("エラー", f"HTMLファイルが見つかりません: {self.html_file}")
                return

            with open(self.html_file, 'r', encoding='utf-8') as f:
                content = f.read()

            # プロジェクト行を抽出する正規表現パターン
            pattern = r'<tr class="project-row" data-category="([^"]*)" data-search="([^"]*)">\s*<td><a href="([^"]*)">(.*?)</a></td>\s*<td>(.*?)</td>\s*<td>(.*?)</td>\s*</tr>'

            matches = re.findall(pattern, content, re.DOTALL)

            self.projects.clear()
            for i, match in enumerate(matches):
                categories_str, search_str, link, title, category_html, description = match

                # カテゴリタグからカテゴリ名を抽出
                category_tags = re.findall(r'<span class="category-tag">([^<]*)</span>', category_html)

                project = {
                    'title': title.strip(),
                    'categories': categories_str.split(','),
                    'description': description.strip(),
                    'link': link.strip(),
                    'search_terms': search_str.strip()
                }
                print(f"プロジェクト読み込み {i+1}: {project['title']} -> {project['link']}")  # デバッグ出力
                self.projects.append(project)

            self.update_tree()
            self.update_categories()  # カテゴリリストを更新
            self.status_var.set(f"{len(self.projects)}件のプロジェクトを読み込みました")

        except Exception as e:
            messagebox.showerror("エラー", f"プロジェクトの読み込みに失敗しました: {str(e)}")

    def update_tree(self):
        """ツリービューを更新"""
        # 既存のアイテムを削除
        for item in self.tree.get_children():
            self.tree.delete(item)

        # プロジェクトを追加
        for i, project in enumerate(self.projects):
            categories_str = ', '.join([cat.strip() for cat in project['categories']])
            self.tree.insert('', 'end', iid=i, values=(
                project['title'],
                categories_str,
                project['description'][:50] + '...' if len(project['description']) > 50 else project['description']
            ))

    def on_select(self, event=None):
        """ツリービューの選択変更時"""
        selection = self.tree.selection()
        if selection:
            index = int(selection[0])
            project = self.projects[index]

            # 詳細表示を更新
            self.detail_text.delete(1.0, tk.END)
            detail = f"プロジェクト名: {project['title']}\n\n"
            detail += f"カテゴリ: {', '.join(project['categories'])}\n\n"
            detail += f"リンク: {project['link']}\n\n"
            detail += f"検索キーワード: {project['search_terms']}\n\n"
            detail += f"説明:\n{project['description']}"

            self.detail_text.insert(1.0, detail)

    def add_project(self):
        """新規プロジェクト追加"""
        self.open_project_dialog()

    def edit_project(self):
        """選択されたプロジェクトを編集"""
        selection = self.tree.selection()
        if not selection:
            messagebox.showwarning("警告", "編集するプロジェクトを選択してください")
            return

        index = int(selection[0])
        self.open_project_dialog(index)

    def delete_project(self):
        """選択されたプロジェクトを削除"""
        selection = self.tree.selection()
        if not selection:
            messagebox.showwarning("警告", "削除するプロジェクトを選択してください")
            return

        index = int(selection[0])
        project = self.projects[index]

        if messagebox.askyesno("確認", f"'{project['title']}'を削除しますか？"):
            del self.projects[index]
            self.update_tree()
            self.status_var.set("プロジェクトを削除しました")

    def move_up(self):
        """選択されたプロジェクトを上に移動"""
        selection = self.tree.selection()
        if not selection:
            messagebox.showwarning("警告", "移動するプロジェクトを選択してください")
            return

        index = int(selection[0])
        if index == 0:
            return

        # リスト内で位置を交換
        self.projects[index], self.projects[index-1] = self.projects[index-1], self.projects[index]
        self.update_tree()

        # 選択を維持
        self.tree.selection_set(str(index-1))
        self.tree.focus(str(index-1))

    def move_down(self):
        """選択されたプロジェクトを下に移動"""
        selection = self.tree.selection()
        if not selection:
            messagebox.showwarning("警告", "移動するプロジェクトを選択してください")
            return

        index = int(selection[0])
        if index >= len(self.projects) - 1:
            return

        # リスト内で位置を交換
        self.projects[index], self.projects[index+1] = self.projects[index+1], self.projects[index]
        self.update_tree()

        # 選択を維持
        self.tree.selection_set(str(index+1))
        self.tree.focus(str(index+1))

    def open_project_dialog(self, index=None):
        """プロジェクト編集ダイアログを開く"""
        dialog = ProjectDialog(self.root, self.categories)

        if index is not None:
            # 編集モード
            project = self.projects[index]
            dialog.set_project_data(project)

        result = dialog.show()
        if result:
            if index is not None:
                # 既存プロジェクトを更新
                old_project = self.projects[index].copy()
                self.projects[index] = result

                # カテゴリが変更された場合は記事ページも更新
                if old_project['categories'] != result['categories']:
                    if self.update_article_categories(result['title'], result['categories']):
                        self.status_var.set("プロジェクトと記事ページを更新しました")
                    else:
                        self.status_var.set("プロジェクトを更新しました")
                else:
                    self.status_var.set("プロジェクトを更新しました")
            else:
                # 新規プロジェクトを追加（一番上に追加）
                self.projects.insert(0, result)
                self.status_var.set("新規プロジェクトを追加しました")

            self.update_tree()

            # 新規追加または編集されたプロジェクトを選択状態にする
            if index is not None:
                # 編集の場合は既存のインデックスを選択
                self.tree.selection_set(str(index))
                self.tree.focus(str(index))
            else:
                # 新規追加の場合は一番上（インデックス0）を選択
                self.tree.selection_set(str(0))
                self.tree.focus(str(0))

    def save_projects(self):
        """プロジェクト情報をHTMLファイルに保存"""
        try:
            if not self.html_file.exists():
                messagebox.showerror("エラー", f"HTMLファイルが見つかりません: {self.html_file}")
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

            # プロジェクト行を生成
            project_rows = []
            for project in self.projects:
                # カテゴリタグを生成
                category_tags = []
                for cat in project['categories']:
                    category_tags.append(f'<span class="category-tag">{cat.strip()}</span>')

                if len(category_tags) > 1:
                    category_html = '\n                                    '.join(category_tags)
                    category_html = f"\n                                    {category_html}\n                                "
                else:
                    category_html = category_tags[0]

                # データ属性用のカテゴリ文字列
                data_categories = ','.join([cat.strip() for cat in project['categories']])

                row = f'''                            <tr class="project-row" data-category="{data_categories}" data-search="{project['search_terms']}">
                                <td><a href="{project['link']}">{project['title']}</a></td>
                                <td>{category_html}</td>
                                <td>{project['description']}</td>
                            </tr>'''
                project_rows.append(row)

            # プロジェクト行を置換（余分な改行を最小限に）
            tbody_pattern = r'(<tbody>\s*)(.*?)(\s*</tbody>)'
            new_projects_html = '\n'.join(project_rows)
            new_tbody = f"\\g<1>\n{new_projects_html}\n\\g<3>"

            new_content = re.sub(tbody_pattern, new_tbody, content, flags=re.DOTALL)

            # フィルタボタンも更新
            self.update_categories()
            filter_buttons = []
            filter_buttons.append('                        <button class="filter-btn active" data-category="all">全て</button>')
            for category in sorted(self.categories):
                filter_buttons.append(f'                        <button class="filter-btn" data-category="{category}">{category}</button>')

            # フィルタボタン部分を置換（余分な改行を最小限に）
            filter_pattern = r'(<div class="filter-buttons">\s*)(.*?)(\s*</div>)'
            new_filter_html = '\n'.join(filter_buttons)
            new_filter_buttons = f"\\g<1>\n{new_filter_html}\n\\g<3>"
            new_content = re.sub(filter_pattern, new_filter_buttons, new_content, flags=re.DOTALL)

            # 余分な連続する空行を削除（段階的に実行）
            # 5つ以上の連続改行を2つに
            new_content = re.sub(r'\n\s*\n\s*\n\s*\n\s*\n+', '\n\n', new_content)
            # 4つの連続改行を2つに
            new_content = re.sub(r'\n\s*\n\s*\n\s*\n', '\n\n', new_content)
            # 3つの連続改行を2つに
            new_content = re.sub(r'\n\s*\n\s*\n', '\n\n', new_content)

            # tbody内の余分な空行も削除
            new_content = re.sub(r'(<tbody>\s*)\n+', r'\g<1>\n', new_content)
            new_content = re.sub(r'\n+(\s*</tbody>)', r'\n\g<1>', new_content)

            # filter-buttons内の余分な空行も削除
            new_content = re.sub(r'(<div class="filter-buttons">\s*)\n+', r'\g<1>\n', new_content)
            new_content = re.sub(r'\n+(\s*</div>)', r'\n\g<1>', new_content)

            # ファイルに保存
            with open(self.html_file, 'w', encoding='utf-8') as f:
                f.write(new_content)

            # 記事ページのカテゴリも更新
            updated_articles = self.update_all_article_categories()

            self.status_var.set("プロジェクト情報を保存しました")

            success_message = f"プロジェクト情報を保存しました\n（バックアップ: {backup_file}）"
            if updated_articles > 0:
                success_message += f"\n{updated_articles}個の記事ページのカテゴリも更新されました"

            messagebox.showinfo("成功", success_message)

        except Exception as e:
            messagebox.showerror("エラー", f"保存に失敗しました: {str(e)}")

    def preview_site(self):
        """ブラウザでサイトをプレビュー"""
        if self.html_file.exists():
            webbrowser.open(f"file:///{self.html_file.absolute()}")
        else:
            messagebox.showerror("エラー", "HTMLファイルが見つかりません")

    def find_existing_article_directory(self, project_title):
        """プロジェクトタイトルに対応する既存の記事ディレクトリを検索"""
        base_path = self.html_file.parent

        # project-* パターンのディレクトリをすべて検索
        for dir_path in base_path.glob("project-*"):
            if dir_path.is_dir():
                index_file = dir_path / "index.html"
                if index_file.exists():
                    try:
                        # index.htmlファイルからタイトルを抽出
                        with open(index_file, 'r', encoding='utf-8') as f:
                            content = f.read()

                        # <title>タグからタイトルを抽出
                        title_match = re.search(r'<title>([^-]+) - ice458の物置き</title>', content)
                        if title_match:
                            found_title = title_match.group(1).strip()
                            if found_title == project_title:
                                return dir_path.name  # ディレクトリ名を返す
                    except Exception as e:
                        print(f"記事ディレクトリ検索エラー ({dir_path}): {e}")

        return None

    def update_article_categories(self, project_title, new_categories):
        """記事ページのカテゴリを更新"""
        try:
            # 既存の記事ディレクトリを検索
            existing_dir = self.find_existing_article_directory(project_title)
            if not existing_dir:
                # 記事が存在しない場合はスキップ
                return False

            article_file = self.html_file.parent / existing_dir / "index.html"
            if not article_file.exists():
                return False

            # 記事ファイルを読み込み
            with open(article_file, 'r', encoding='utf-8') as f:
                content = f.read()

            # カテゴリタグを生成
            category_tags = []
            for cat in new_categories:
                category_tags.append(f'<span class="category-tag">{cat.strip()}</span>')

            if len(category_tags) > 1:
                category_tags_html = '\n                        '.join(category_tags)
            else:
                category_tags_html = category_tags[0]

            # 既存のカテゴリセクションを更新
            # <div class="article-categories">から</div>までの内容を置換（改行の累積を防ぐ）
            category_pattern = r'<div class="article-categories">\s*.*?\s*</div>'
            new_category_section = f'<div class="article-categories">\n                        {category_tags_html}\n                    </div>'

            new_content = re.sub(category_pattern, new_category_section, content, flags=re.DOTALL)

            # ファイルに保存
            with open(article_file, 'w', encoding='utf-8') as f:
                f.write(new_content)

            print(f"記事ページのカテゴリを更新しました: {article_file}")
            return True

        except Exception as e:
            print(f"記事ページのカテゴリ更新エラー ({project_title}): {e}")
            return False

    def update_all_article_categories(self):
        """全ての記事ページのカテゴリを現在のプロジェクト情報で更新"""
        updated_count = 0
        for project in self.projects:
            if self.update_article_categories(project['title'], project['categories']):
                updated_count += 1

        return updated_count

    def validate_and_fix_links(self):
        """プロジェクトリンクの検証と自動修正"""
        fixed_count = 0
        for i, project in enumerate(self.projects):
            project_slug = self.create_project_slug(project['title'])

            # まず既存の記事ディレクトリを検索
            existing_dir = self.find_existing_article_directory(project['title'])
            if existing_dir:
                expected_link = f"{existing_dir}/index.html"
                article_file = self.html_file.parent / existing_dir / "index.html"
            else:
                expected_link = f"{project_slug}/index.html"
                article_file = self.html_file.parent / project_slug / "index.html"

            print(f"プロジェクト: {project['title']}")
            print(f"  現在のリンク: {project['link']}")
            print(f"  既存ディレクトリ: {existing_dir}")
            print(f"  期待されるリンク: {expected_link}")
            print(f"  記事ファイル存在: {article_file.exists()}")

            # ハッシュリンクの場合は記事ページが存在するかチェック
            if project['link'].startswith('#'):
                if article_file.exists():
                    # 記事ページが存在する場合はリンクを更新
                    print(f"ハッシュリンクを記事リンクに更新: {project['link']} -> {expected_link}")
                    project['link'] = expected_link
                    fixed_count += 1

            # 記事ページのリンクが無効になっていないかチェック
            elif not project['link'].startswith('http') and '/' in project['link']:
                current_article_file = self.html_file.parent / project['link']
                if not current_article_file.exists():
                    if article_file.exists():
                        # 正しい記事ファイルが存在する場合はリンクを修正
                        print(f"無効なリンクを修正: {project['link']} -> {expected_link}")
                        project['link'] = expected_link
                        fixed_count += 1
                    else:
                        # 記事ファイルが存在しない場合はハッシュリンクに戻す
                        hash_link = f"#{project['title'].lower().replace(' ', '-')}"
                        print(f"リンクをハッシュリンクに戻す: {project['link']} -> {hash_link}")
                        project['link'] = hash_link
                        fixed_count += 1

            # 外部リンクでない場合、期待されるリンクと異なる場合の修正
            elif not project['link'].startswith('http'):
                if article_file.exists() and project['link'] != expected_link:
                    print(f"リンクを正しいパスに修正: {project['link']} -> {expected_link}")
                    project['link'] = expected_link
                    fixed_count += 1
                elif not article_file.exists() and not project['link'].startswith('#'):
                    # 記事が存在せず、現在のリンクも無効な場合はハッシュリンクに
                    hash_link = f"#{project['title'].lower().replace(' ', '-')}"
                    print(f"記事が存在しないためハッシュリンクに: {project['link']} -> {hash_link}")
                    project['link'] = hash_link
                    fixed_count += 1

        if fixed_count > 0:
            self.update_tree()
            self.status_var.set(f"{fixed_count}個のリンクを修正しました")
            return True
        return False

    def validate_and_fix_links_ui(self):
        """リンク検証・修正のUIコールバック"""
        fixed = self.validate_and_fix_links()
        if fixed:
            response = messagebox.askyesno("リンク修正完了",
                "リンクの修正が完了しました。\n変更内容をHTMLファイルに保存しますか？")
            if response:
                self.save_projects()
        else:
            messagebox.showinfo("確認", "修正が必要なリンクは見つかりませんでした。")

    def update_article_categories_ui(self):
        """記事カテゴリ更新のUIコールバック"""
        updated_count = self.update_all_article_categories()

        if updated_count > 0:
            messagebox.showinfo("更新完了",
                f"{updated_count}個の記事ページのカテゴリを更新しました。")
            self.status_var.set(f"{updated_count}個の記事ページのカテゴリを更新しました")
        else:
            messagebox.showinfo("確認", "更新対象の記事ページが見つかりませんでした。")

    def generate_article_page(self):
        """選択されたプロジェクトの記事ページを生成"""
        selection = self.tree.selection()
        if not selection:
            messagebox.showwarning("警告", "記事ページを生成するプロジェクトを選択してください")
            return

        index = int(selection[0])
        project = self.projects[index]

        try:
            # まず既存の記事ディレクトリを検索
            existing_dir = self.find_existing_article_directory(project['title'])
            if existing_dir:
                project_slug = existing_dir
            else:
                # プロジェクト用のディレクトリを作成
                project_slug = self.create_project_slug(project['title'])

            project_dir = self.html_file.parent / project_slug

            # 既存ページの存在をチェック
            article_file = project_dir / "index.html"
            if article_file.exists():
                response = messagebox.askyesno("確認",
                    f"'{project['title']}'の記事ページは既に存在します。\n\n"
                    f"ファイル: {article_file}\n"
                    f"ディレクトリ: {project_slug}\n\n"
                    "上書きしますか？")
                if not response:
                    return

            project_dir.mkdir(exist_ok=True)

            # テンプレートファイルのパス
            template_dir = self.html_file.parent / "templates"
            template_file = template_dir / "article_template.html"

            if not template_file.exists():
                messagebox.showerror("エラー", f"テンプレートファイルが見つかりません: {template_file}")
                return

            # テンプレートを読み込み
            with open(template_file, 'r', encoding='utf-8') as f:
                template_content = f.read()

            # カテゴリタグを生成
            category_tags = []
            for cat in project['categories']:
                category_tags.append(f'<span class="category-tag">{cat.strip()}</span>')
            category_tags_html = '\n                        '.join(category_tags)

            # 現在の日付を取得
            from datetime import datetime
            current_date = datetime.now().strftime('%Y年%m月%d日')

            # プレースホルダーを置換
            content = template_content.replace('{{TITLE}}', project['title'])
            content = content.replace('{{DESCRIPTION}}', project['description'])
            content = content.replace('{{CATEGORIES}}', ', '.join(project['categories']))
            content = content.replace('{{CATEGORY_TAGS}}', category_tags_html)
            content = content.replace('{{DATE}}', current_date)
            content = content.replace('VIDEO_ID_HERE', 'VIDEO_ID_PLACEHOLDER')

            # 記事ファイルを保存
            article_file = project_dir / "index.html"
            with open(article_file, 'w', encoding='utf-8') as f:
                f.write(content)

            # プロジェクトのリンクを更新してHTMLに反映
            old_link = project['link']
            new_link = f"{project_slug}/index.html"
            link_updated = False

            # リンクが異なる場合、または既存のハッシュリンクの場合は更新
            if project['link'] != new_link:
                project['link'] = new_link
                link_updated = True
                print(f"リンクを更新: {old_link} -> {new_link}")  # デバッグ出力
                self.update_tree()
                # HTMLファイルも更新
                try:
                    self.save_projects()
                    print("HTMLファイルの保存が完了しました")  # デバッグ出力
                except Exception as save_error:
                    print(f"HTMLファイルの保存エラー: {save_error}")  # デバッグ出力
                    messagebox.showerror("警告", f"記事ページは生成されましたが、HTMLファイルの更新に失敗しました: {str(save_error)}")

            success_message = f"記事ページを生成しました:\n{article_file}\n\nディレクトリ: {project_dir}\nスラッグ: {project_slug}"
            if link_updated:
                success_message += f"\nリンクも更新されました: {old_link} -> {project['link']}"
            else:
                success_message += f"\nリンクは既に最新です: {project['link']}"

            messagebox.showinfo("成功", success_message)
            self.status_var.set(f"'{project['title']}'の記事ページを生成しました")

        except Exception as e:
            messagebox.showerror("エラー", f"記事ページの生成に失敗しました: {str(e)}")

    def create_project_slug(self, title):
        """プロジェクトタイトルからURLスラッグを生成（一貫性のあるハッシュ）"""
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
            slug = f"project-{hash_num}"
            return slug

        # 英数字のみの場合は従来の処理
        slug = re.sub(r'[^\w\-]', '-', normalized_title.lower())
        slug = re.sub(r'-+', '-', slug)  # 連続するハイフンを1つに
        slug = slug.strip('-')  # 先頭と末尾のハイフンを削除

        # スラッグが短すぎる場合
        if not slug or len(slug) < 3:
            hash_obj = hashlib.md5(normalized_title.encode('utf-8'))
            hash_num = int(hash_obj.hexdigest()[:4], 16)
            slug = f"project-{hash_num}"

        return slug


class ProjectDialog:
    def __init__(self, parent, categories):
        self.parent = parent
        self.categories = categories
        self.result = None

        self.dialog = tk.Toplevel(parent)
        self.dialog.title("プロジェクト編集")
        self.dialog.geometry("600x500")
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

        # プロジェクト名
        ttk.Label(main_frame, text="プロジェクト名:").grid(row=row, column=0, sticky=tk.W, pady=5)
        self.title_var = tk.StringVar()
        ttk.Entry(main_frame, textvariable=self.title_var, width=40).grid(row=row, column=1, sticky=(tk.W, tk.E), pady=5)
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
            ttk.Checkbutton(category_frame, text=category, variable=var).grid(row=i//2, column=i%2, sticky=tk.W, padx=5)
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
        self.search_var = tk.StringVar()
        ttk.Entry(main_frame, textvariable=self.search_var, width=40).grid(row=row, column=1, sticky=(tk.W, tk.E), pady=5)
        row += 1

        # 説明
        ttk.Label(main_frame, text="説明:").grid(row=row, column=0, sticky=(tk.W, tk.N), pady=5)
        text_frame = ttk.Frame(main_frame)
        text_frame.grid(row=row, column=1, sticky=(tk.W, tk.E, tk.N, tk.S), pady=5)

        self.description_text = tk.Text(text_frame, width=40, height=8, wrap=tk.WORD)
        desc_scroll = ttk.Scrollbar(text_frame, orient=tk.VERTICAL, command=self.description_text.yview)
        self.description_text.configure(yscrollcommand=desc_scroll.set)

        self.description_text.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        desc_scroll.grid(row=0, column=1, sticky=(tk.N, tk.S))

        text_frame.columnconfigure(0, weight=1)
        text_frame.rowconfigure(0, weight=1)
        main_frame.rowconfigure(row, weight=1)
        row += 1

        # ボタン
        button_frame = ttk.Frame(main_frame)
        button_frame.grid(row=row, column=0, columnspan=2, pady=20)

        ttk.Button(button_frame, text="OK", command=self.ok_clicked).grid(row=0, column=0, padx=5)
        ttk.Button(button_frame, text="キャンセル", command=self.cancel_clicked).grid(row=0, column=1, padx=5)

    def set_project_data(self, project):
        """既存プロジェクトデータを設定"""
        self.title_var.set(project['title'])
        self.link_var.set(project['link'])
        self.search_var.set(project['search_terms'])
        self.description_text.insert(1.0, project['description'])

        # カテゴリを設定
        for category in project['categories']:
            category = category.strip()
            if category in self.category_vars:
                self.category_vars[category].set(True)

    def ok_clicked(self):
        """OKボタンクリック"""
        title = self.title_var.get().strip()
        if not title:
            messagebox.showerror("エラー", "プロジェクト名を入力してください")
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
            'link': self.link_var.get().strip() or f"#{title.lower().replace(' ', '-')}",
            'categories': categories,
            'search_terms': self.search_var.get().strip(),
            'description': self.description_text.get(1.0, tk.END).strip()
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
    app = ProjectManager(root)
    root.mainloop()


if __name__ == "__main__":
    main()
