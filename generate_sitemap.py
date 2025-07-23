#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
サイトマップ自動生成スクリプト - ice458の物置き
サイト内のHTMLファイルを自動検出してXMLサイトマップを生成します。
"""

import os
import re
from datetime import datetime
from pathlib import Path
import xml.etree.ElementTree as ET
from xml.dom import minidom

class SitemapGenerator:
    def __init__(self, base_url="https://ice458.github.io", root_dir=None):
        self.base_url = base_url.rstrip('/')
        self.root_dir = Path(root_dir) if root_dir else Path(__file__).parent
        self.sitemap_data = []

        # 優先度とchangefreqの設定
        self.page_configs = {
            'index.html': {'priority': 1.0, 'changefreq': 'weekly'},
            'blog.html': {'priority': 0.8, 'changefreq': 'weekly'},
            'links.html': {'priority': 0.6, 'changefreq': 'monthly'},
            'project-': {'priority': 0.7, 'changefreq': 'monthly'},  # プロジェクトページ
            'blog/article-': {'priority': 0.6, 'changefreq': 'yearly'},  # ブログ記事
        }

    def get_file_modification_date(self, file_path):
        """ファイルの最終更新日を取得"""
        try:
            timestamp = os.path.getmtime(file_path)
            return datetime.fromtimestamp(timestamp).strftime('%Y-%m-%d')
        except:
            return datetime.now().strftime('%Y-%m-%d')

    def extract_title_from_html(self, file_path):
        """HTMLファイルからタイトルを抽出"""
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                content = f.read()
                title_match = re.search(r'<title[^>]*>([^<]+)</title>', content, re.IGNORECASE)
                if title_match:
                    return title_match.group(1).strip()
        except:
            pass
        return None

    def get_page_config(self, relative_path):
        """ページの設定（優先度、changefreq）を取得"""
        # 完全一致の設定
        if relative_path == 'index.html':
            return {'priority': 1.0, 'changefreq': 'weekly'}
        elif relative_path == 'blog.html':
            return {'priority': 0.8, 'changefreq': 'weekly'}
        elif relative_path == 'links.html':
            return {'priority': 0.6, 'changefreq': 'monthly'}

        # パターンマッチの設定
        if relative_path.startswith('project-') and '/index.html' in relative_path:
            return {'priority': 0.7, 'changefreq': 'monthly'}
        elif relative_path.startswith('blog/article-'):
            return {'priority': 0.6, 'changefreq': 'yearly'}

        # デフォルト設定
        return {'priority': 0.5, 'changefreq': 'monthly'}

    def scan_html_files(self):
        """HTMLファイルをスキャンしてサイトマップデータを収集"""
        self.sitemap_data = []

        # 除外するパターン
        exclude_patterns = [
            r'__pycache__',
            r'\.git',
            r'\.bak$',
            r'test_.*\.html',
            r'.*_files/',  # bp/内のリソースファイル
            r'bp/.*\.htm$',  # bp/内のバックアップHTMLファイル
        ]

        def should_exclude(path_str):
            for pattern in exclude_patterns:
                if re.search(pattern, path_str):
                    return True
            return False

        # HTMLファイルを再帰的に検索
        for html_file in self.root_dir.rglob('*.html'):
            relative_path = html_file.relative_to(self.root_dir)
            relative_path_str = str(relative_path).replace('\\', '/')

            # 除外パターンをチェック
            if should_exclude(relative_path_str):
                continue

            # URLを構築
            if relative_path_str == 'index.html':
                url = f"{self.base_url}/"
            elif relative_path_str.endswith('/index.html'):
                # プロジェクトやブログ記事のindex.htmlの場合はディレクトリ形式に
                dir_path = relative_path_str[:-11]  # '/index.html'を除去
                url = f"{self.base_url}/{dir_path}/"
            else:
                url = f"{self.base_url}/{relative_path_str}"

            # ページ設定を取得
            config = self.get_page_config(relative_path_str)

            # タイトルを抽出（デバッグ用）
            title = self.extract_title_from_html(html_file)

            # 最終更新日を取得
            lastmod = self.get_file_modification_date(html_file)

            self.sitemap_data.append({
                'url': url,
                'lastmod': lastmod,
                'changefreq': config['changefreq'],
                'priority': config['priority'],
                'title': title,
                'file_path': relative_path_str
            })

        # プロジェクトディレクトリを個別にチェック（index.htmlがある場合）
        for project_dir in self.root_dir.glob('project-*'):
            if project_dir.is_dir():
                index_file = project_dir / 'index.html'
                if index_file.exists():
                    relative_path = index_file.relative_to(self.root_dir)
                    relative_path_str = str(relative_path).replace('\\', '/')

                    # 既に追加済みかチェック
                    if not any(item['file_path'] == relative_path_str for item in self.sitemap_data):
                        url = f"{self.base_url}/{project_dir.name}/"
                        config = self.get_page_config(relative_path_str)
                        title = self.extract_title_from_html(index_file)
                        lastmod = self.get_file_modification_date(index_file)

                        self.sitemap_data.append({
                            'url': url,
                            'lastmod': lastmod,
                            'changefreq': config['changefreq'],
                            'priority': config['priority'],
                            'title': title,
                            'file_path': relative_path_str
                        })

        # 優先度順でソート（高い優先度から低い優先度へ）
        self.sitemap_data.sort(key=lambda x: (-x['priority'], x['url']))

    def generate_xml_sitemap(self):
        """XMLサイトマップを生成"""
        # XML名前空間
        ns = "http://www.sitemaps.org/schemas/sitemap/0.9"

        # ルート要素を作成
        urlset = ET.Element("urlset")
        urlset.set("xmlns", ns)

        # 各URLを追加
        for item in self.sitemap_data:
            url_elem = ET.SubElement(urlset, "url")

            # loc要素（必須）
            loc = ET.SubElement(url_elem, "loc")
            loc.text = item['url']

            # lastmod要素
            lastmod = ET.SubElement(url_elem, "lastmod")
            lastmod.text = item['lastmod']

            # changefreq要素
            changefreq = ET.SubElement(url_elem, "changefreq")
            changefreq.text = item['changefreq']

            # priority要素
            priority = ET.SubElement(url_elem, "priority")
            priority.text = str(item['priority'])

        return urlset

    def save_sitemap(self, output_file="sitemap.xml"):
        """サイトマップをファイルに保存"""
        xml_tree = self.generate_xml_sitemap()

        # XMLを整形
        rough_string = ET.tostring(xml_tree, encoding='unicode')
        reparsed = minidom.parseString(rough_string)
        pretty_xml = reparsed.toprettyxml(indent="  ")

        # 空行を削除
        lines = [line for line in pretty_xml.split('\n') if line.strip()]
        formatted_xml = '\n'.join(lines)

        # ファイルに保存
        output_path = self.root_dir / output_file
        with open(output_path, 'w', encoding='utf-8') as f:
            f.write(formatted_xml)

        return output_path

    def print_summary(self):
        """スキャン結果のサマリーを表示"""
        print("=== サイトマップ生成結果 ===")
        print(f"検出されたページ数: {len(self.sitemap_data)}")
        print(f"ベースURL: {self.base_url}")
        print(f"ルートディレクトリ: {self.root_dir}")
        print()

        # カテゴリ別の統計
        categories = {}
        for item in self.sitemap_data:
            path = item['file_path']
            if path == 'index.html':
                category = 'メインページ'
            elif path == 'blog.html':
                category = 'ブログトップ'
            elif path == 'links.html':
                category = 'リンク集'
            elif path.startswith('project-'):
                category = 'プロジェクトページ'
            elif path.startswith('blog/article-'):
                category = 'ブログ記事'
            else:
                category = 'その他'

            categories[category] = categories.get(category, 0) + 1

        print("カテゴリ別統計:")
        for category, count in categories.items():
            print(f"  {category}: {count}ページ")
        print()

        print("優先度の高いページ（上位10件）:")
        for i, item in enumerate(self.sitemap_data[:10]):
            title = item['title'] or item['file_path']
            if len(title) > 50:
                title = title[:47] + "..."
            print(f"  {i+1:2d}. {title} (優先度: {item['priority']}, 更新: {item['lastmod']})")

        if len(self.sitemap_data) > 10:
            print(f"  ... 他 {len(self.sitemap_data) - 10} ページ")

def main():
    """メイン関数"""
    print("ice458の物置き - サイトマップ自動生成ツール")
    print("=" * 50)

    # サイトマップジェネレーターを初期化
    generator = SitemapGenerator()

    # HTMLファイルをスキャン
    print("HTMLファイルをスキャン中...")
    generator.scan_html_files()

    # サマリーを表示
    generator.print_summary()

    # サイトマップを生成・保存
    print("XMLサイトマップを生成中...")
    output_path = generator.save_sitemap()

    print(f"✅ サイトマップが正常に生成されました: {output_path}")
    print(f"📁 ファイルサイズ: {output_path.stat().st_size} bytes")

    # robots.txtの確認
    robots_file = generator.root_dir / "robots.txt"
    if robots_file.exists():
        print("✅ robots.txt が見つかりました")
    else:
        print("⚠️  robots.txt が見つかりません")
        print("   検索エンジンにサイトマップを知らせるため、robots.txt の作成を推奨します")

    print("\n次のステップ:")
    print("1. Google Search Console にサイトマップを送信")
    print("2. Bing Webmaster Tools にも送信（推奨）")
    print("3. 新しいページを追加したら、このスクリプトを再実行")

if __name__ == "__main__":
    main()
