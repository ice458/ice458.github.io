#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ローカル用の簡易 Jekyll ビルダー。

本番のビルドは GitHub Pages 上の本家 Jekyll が行う。これはあくまで
「push する前に手元で見て確かめる」ためのもので、_layouts / _includes /
front matter という同じ材料から同じ HTML を組み立てる。

    python _tools/build.py            … _site/ に書き出す
    python _tools/build.py --serve    … ビルドしてローカルサーバを起動
"""
import argparse
import http.server
import os
import shutil
import socketserver
import sys
import threading
import webbrowser
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import yaml                                    # noqa: E402
from liquid_lite import Template, LiquidError  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "_site"

# ビルド対象から外すディレクトリ（先頭 _ のものは Jekyll 同様に自動で除外）
SKIP_DIRS = {".git", ".github", "__pycache__", "templates", "bp",
             "node_modules", ".vscode", ".idea", ".claude"}
SKIP_SUFFIX = {".py", ".bat", ".md", ".bak", ".tmp", ".temp", ".pyc"}
KEEP_NAMES = {"engine.py"}          # _config.yml の include: と対応


def is_skipped(rel: Path) -> bool:
    parts = rel.parts
    if any(p in SKIP_DIRS or p.startswith("_") for p in parts[:-1]):
        return True
    if rel.name in KEEP_NAMES:
        return False
    if rel.suffix.lower() in SKIP_SUFFIX:
        return True
    if parts and (parts[0] in SKIP_DIRS or parts[0].startswith("_")):
        return True
    return False


def split_front_matter(text):
    """(front matter dict, 本文) を返す。front matter が無ければ (None, 全文)。"""
    if not text.startswith("---"):
        return None, text
    lines = text.splitlines(keepends=True)
    if lines[0].strip() != "---":
        return None, text
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            raw = "".join(lines[1:i])
            body = "".join(lines[i + 1:])
            try:
                fm = yaml.safe_load(raw) or {}
            except yaml.YAMLError as e:
                raise SystemExit(f"front matter の YAML が壊れています: {e}")
            if not isinstance(fm, dict):
                return None, text
            return fm, body
    return None, text


def out_path_for(permalink, rel):
    if not permalink:
        return SITE / rel
    p = permalink.lstrip("/")
    if permalink.endswith("/") or permalink == "/":
        return SITE / p / "index.html"
    return SITE / p


class Builder:
    def __init__(self):
        self.config = yaml.safe_load((ROOT / "_config.yml").read_text(encoding="utf-8")) or {}
        self._tpl_cache = {}
        self.pages = []
        self.static = []
        self._collect()

    # ---- 読み込み
    def _collect(self):
        for path in sorted(ROOT.rglob("*")):
            if path.is_dir():
                continue
            rel = path.relative_to(ROOT)
            if is_skipped(rel):
                continue
            if path.suffix.lower() in (".html", ".htm"):
                text = path.read_text(encoding="utf-8", errors="replace")
                fm, body = split_front_matter(text)
                if fm is not None:
                    page = dict(fm)
                    page["_body"] = body
                    page["_rel"] = str(rel).replace("\\", "/")
                    page.setdefault("permalink", "/" + str(rel).replace("\\", "/"))
                    page["url"] = page["permalink"]
                    self.pages.append(page)
                    continue
            self.static.append(rel)

    # ---- テンプレート
    def _load_include(self, name):
        key = ("inc", name)
        if key not in self._tpl_cache:
            f = ROOT / "_includes" / name
            if not f.exists():
                raise LiquidError(f"include が見つかりません: _includes/{name}")
            self._tpl_cache[key] = Template(f.read_text(encoding="utf-8"),
                                            name, self._load_include)
        return self._tpl_cache[key]

    def _load_layout(self, name):
        key = ("lay", name)
        if key not in self._tpl_cache:
            f = ROOT / "_layouts" / f"{name}.html"
            if not f.exists():
                raise LiquidError(f"layout が見つかりません: _layouts/{name}.html")
            text = f.read_text(encoding="utf-8")
            fm, body = split_front_matter(text)
            self._tpl_cache[key] = (fm or {}, Template(body, name, self._load_include))
        return self._tpl_cache[key]

    # ---- 描画
    def site_ctx(self):
        s = dict(self.config)
        s["pages"] = self.pages
        return s

    def render_page(self, page):
        ctx = {"site": self.site_ctx(), "page": page}
        tpl = Template(page["_body"], page["_rel"], self._load_include)
        content = tpl.render(dict(ctx))
        layout = page.get("layout")
        guard = 0
        while layout and layout not in ("null", None, "none"):
            guard += 1
            if guard > 10:
                raise LiquidError(f"layout が循環しています: {page['_rel']}")
            lfm, ltpl = self._load_layout(layout)
            lctx = dict(ctx)
            lctx["content"] = content
            lctx["layout"] = lfm
            content = ltpl.render(lctx)
            layout = lfm.get("layout")
        return content

    def build(self, verbose=True):
        if SITE.exists():
            shutil.rmtree(SITE)
        SITE.mkdir(parents=True)

        errors = []
        for page in self.pages:
            try:
                html = self.render_page(page)
            except LiquidError as e:
                errors.append(f"{page['_rel']}: {e}")
                continue
            dest = out_path_for(page.get("permalink"), Path(page["_rel"]))
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(html, encoding="utf-8")

        for rel in self.static:
            dest = SITE / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / rel, dest)

        if verbose:
            print(f"ページ {len(self.pages)} 件 / 静的ファイル {len(self.static)} 件 -> {SITE}")
        if errors:
            print("\n!! テンプレートのエラー:")
            for e in errors:
                print("   " + e)
            return False
        return True


def serve(port=4000, open_browser=True):
    os.chdir(SITE)

    class Handler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, fmt, *args):
            pass

        def end_headers(self):
            self.send_header("Cache-Control", "no-store")
            super().end_headers()

    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", port), Handler) as httpd:
        url = f"http://127.0.0.1:{port}/"
        print(f"プレビュー: {url}   (終了は Ctrl+C / このウィンドウを閉じる)")
        if open_browser:
            threading.Timer(0.6, lambda: webbrowser.open(url)).start()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n停止しました")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--serve", action="store_true")
    ap.add_argument("--port", type=int, default=4000)
    ap.add_argument("--no-browser", action="store_true")
    a = ap.parse_args()
    ok = Builder().build()
    if not ok:
        sys.exit(1)
    if a.serve:
        serve(a.port, not a.no_browser)


if __name__ == "__main__":
    main()
