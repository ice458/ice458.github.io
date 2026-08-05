#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ice458の物置き - サイト管理ツール

各ページの front matter（先頭の --- で囲まれた部分）を読み書きする。
一覧ページ（index.html / blog.html）は Jekyll がこの front matter から
自動生成するので、このツールが HTML を組み立てることは無い。
"""
import hashlib
import os
import re
import subprocess
import sys
import threading
import tkinter as tk
import unicodedata
import urllib.error
import urllib.request
import webbrowser
from datetime import datetime
from pathlib import Path
from tkinter import messagebox, ttk

try:
    import yaml
except ImportError:                       # 初回起動時など
    _r = tk.Tk()
    _r.withdraw()
    if not messagebox.askyesno(
            "部品が足りません",
            "このツールに必要な PyYAML が入っていません。\n\n"
            "今すぐインストールしますか？（ネットワークに接続している必要があります）"):
        sys.exit(1)
    if subprocess.run([sys.executable, "-m", "pip", "install", "--quiet",
                       "pyyaml"]).returncode != 0:
        messagebox.showerror(
            "インストールに失敗しました",
            "PyYAML を入れられませんでした。\n\n"
            "ネットワーク接続を確認してから、もう一度起動してください。")
        sys.exit(1)
    _r.destroy()
    import yaml

ROOT = Path(__file__).resolve().parent
PREVIEW_PORT = 4000

KINDS = {
    "project": {"label": "プロジェクト", "dir": ROOT, "prefix": "project-",
                "layout": "page", "nav": "projects",
                "template": "templates/new_project.html",
                "sitemap": {"priority": 0.7, "changefreq": "monthly"}},
    "article": {"label": "雑多なメモ等", "dir": ROOT / "blog", "prefix": "article-",
                "layout": "page", "nav": "blog",
                "template": "templates/new_article.html",
                "sitemap": {"priority": 0.6, "changefreq": "monthly"}},
}

# front matter に書き出す順序（読みやすさのため固定する）
KEY_ORDER = ["layout", "type", "nav", "permalink", "title", "description",
             "og_description", "og_title_plain", "keywords", "image", "og_type",
             "title_full", "site_jsonld", "script", "categories", "date",
             "date_label", "updated", "summary", "search", "order",
             "video", "video_upload_date", "mathjax", "sitemap"]


# --------------------------------------------------------------- front matter

def split_front_matter(text):
    """(front matter dict, 本文) を返す"""
    if not text.startswith("---"):
        return None, text
    lines = text.splitlines(keepends=True)
    if lines[0].strip() != "---":
        return None, text
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            fm = yaml.safe_load("".join(lines[1:i])) or {}
            return (fm if isinstance(fm, dict) else None), "".join(lines[i + 1:])
    return None, text


def dump_front_matter(fm):
    ordered = {k: fm[k] for k in KEY_ORDER if k in fm and fm[k] is not None}
    for k, v in fm.items():                       # 未知のキーも失わない
        if k not in ordered and v is not None:
            ordered[k] = v
    return yaml.dump(ordered, allow_unicode=True, sort_keys=False,
                     default_flow_style=False, width=10 ** 6)


class Page:
    def __init__(self, path):
        self.path = Path(path)
        text = self.path.read_text(encoding="utf-8")
        self.fm, self.body = split_front_matter(text)
        if self.fm is None:
            raise ValueError(f"front matter がありません: {path}")
        self.dirty = False

    # 使いやすいアクセサ
    def get(self, k, d=None):
        return self.fm.get(k, d)

    def set(self, k, v):
        if v in (None, "", [], {}):
            if k in self.fm:
                del self.fm[k]
                self.dirty = True
            return
        if self.fm.get(k) != v:
            self.fm[k] = v
            self.dirty = True

    @property
    def title(self):
        return self.fm.get("title", "(無題)")

    @property
    def kind(self):
        return self.fm.get("type", "")

    def save(self):
        self.path.write_text(f"---\n{dump_front_matter(self.fm)}---\n{self.body}",
                             encoding="utf-8")
        self.dirty = False


def load_pages():
    """type: project / article のページを全部読み込んで order 順に返す"""
    out = {"project": [], "article": []}
    for pattern in ("project-*/index.html", "blog/article-*/index.html"):
        for p in sorted(ROOT.glob(pattern)):
            try:
                page = Page(p)
            except Exception as e:
                print(f"読み込み失敗 {p}: {e}")
                continue
            if page.kind in out:
                out[page.kind].append(page)
    for k in out:
        out[k].sort(key=lambda pg: (pg.get("order", 9999), pg.title))
    return out


def make_slug(kind, title):
    """タイトルからディレクトリ名を作る。既存と衝突しない値を必ず返す。"""
    cfg = KINDS[kind]
    norm = unicodedata.normalize("NFKC", title)
    digest = hashlib.md5(norm.encode("utf-8")).hexdigest()
    # 32bit 使う（旧ツールは 16bit しか使っておらず衝突しやすかった）
    base = int(digest[:8], 16)
    for bump in range(1000):
        slug = f"{cfg['prefix']}{(base + bump) % 4294967296}"
        if not (cfg["dir"] / slug).exists():
            return slug
    raise RuntimeError("空きスラッグが見つかりません")


def extract_video_id(url):
    if not url:
        return ""
    m = re.search(r"(?:youtube\.com/watch\?.*v=|youtu\.be/|youtube\.com/embed/)"
                  r"([a-zA-Z0-9_-]{11})", url)
    if m:
        return m.group(1)
    return url.strip() if re.fullmatch(r"[a-zA-Z0-9_-]{11}", url.strip()) else ""


def jp_date_to_iso(s):
    m = re.search(r"(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日", s or "")
    if not m:
        return None
    return f"{int(m.group(1)):04d}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"


# --------------------------------------------------------------- 編集ダイアログ

class PageDialog(tk.Toplevel):
    def __init__(self, parent, kind, all_categories, page=None):
        super().__init__(parent)
        self.kind = kind
        self.page = page
        self.result = None
        self.title("編集" if page else "新規作成")
        self.geometry("720x750")
        self.transient(parent)
        self.grab_set()
        self._build(all_categories)
        if page:
            self._fill(page)
        else:
            self.date_var.set(datetime.now().strftime("%Y年%m月%d日"))
            self.updated_var.set(datetime.now().strftime("%Y年%m月%d日"))

    def _row(self, parent, r, label, hint=None):
        ttk.Label(parent, text=label).grid(row=r, column=0, sticky=tk.NW, pady=4, padx=(0, 8))
        f = ttk.Frame(parent)
        f.grid(row=r, column=1, sticky=(tk.W, tk.E), pady=4)
        f.columnconfigure(0, weight=1)
        if hint:
            ttk.Label(f, text=hint, font=("", 8), foreground="gray").grid(
                row=1, column=0, sticky=tk.W)
        return f

    def _build(self, all_categories):
        outer = ttk.Frame(self, padding=16)
        outer.pack(fill=tk.BOTH, expand=True)
        outer.columnconfigure(0, weight=1)
        outer.rowconfigure(0, weight=1)

        canvas = tk.Canvas(outer, highlightthickness=0)
        sb = ttk.Scrollbar(outer, orient=tk.VERTICAL, command=canvas.yview)
        m = ttk.Frame(canvas)
        m.bind("<Configure>", lambda e: canvas.configure(scrollregion=canvas.bbox("all")))
        win = canvas.create_window((0, 0), window=m, anchor="nw")
        canvas.bind("<Configure>", lambda e: canvas.itemconfig(win, width=e.width))
        canvas.configure(yscrollcommand=sb.set)
        canvas.grid(row=0, column=0, sticky="nsew")
        sb.grid(row=0, column=1, sticky="ns")
        canvas.bind_all("<MouseWheel>",
                        lambda e: canvas.yview_scroll(int(-e.delta / 120), "units"))
        m.columnconfigure(1, weight=1)

        r = 0
        f = self._row(m, r, "タイトル *")
        self.title_var = tk.StringVar()
        ttk.Entry(f, textvariable=self.title_var).grid(row=0, column=0, sticky=(tk.W, tk.E))
        r += 1

        f = self._row(m, r, "日付", "一覧の並びや表示に使われます")
        self.date_var = tk.StringVar()
        ttk.Entry(f, textvariable=self.date_var).grid(row=0, column=0, sticky=(tk.W, tk.E))
        bf = ttk.Frame(f)
        bf.grid(row=0, column=1, padx=(6, 0))
        ttk.Button(bf, text="今日", width=6,
                   command=lambda: self.date_var.set(
                       datetime.now().strftime("%Y年%m月%d日"))).pack()
        r += 1

        f = self._row(m, r, "日付の見出し", "ページ本文に「○○: 日付」と出ます")
        self.datelabel_var = tk.StringVar(value="作成日")
        ttk.Combobox(f, textvariable=self.datelabel_var, values=["作成日", "公開", "公開日"],
                     state="normal").grid(row=0, column=0, sticky=(tk.W, tk.E))
        r += 1

        f = self._row(m, r, "最終更新")
        self.updated_var = tk.StringVar()
        ttk.Entry(f, textvariable=self.updated_var).grid(row=0, column=0, sticky=(tk.W, tk.E))
        ttk.Button(f, text="今日", width=6,
                   command=lambda: self.updated_var.set(
                       datetime.now().strftime("%Y年%m月%d日"))).grid(row=0, column=1, padx=(6, 0))
        r += 1

        # カテゴリ
        ttk.Label(m, text="カテゴリ *").grid(row=r, column=0, sticky=tk.NW, pady=4, padx=(0, 8))
        cf = ttk.LabelFrame(m, padding=8)
        cf.grid(row=r, column=1, sticky=(tk.W, tk.E), pady=4)
        self.cat_vars = {}
        for i, c in enumerate(sorted(all_categories)):
            v = tk.BooleanVar()
            self.cat_vars[c] = v
            ttk.Checkbutton(cf, text=c, variable=v).grid(row=i // 3, column=i % 3,
                                                         sticky=tk.W, padx=4)
        r += 1

        f = self._row(m, r, "新しいカテゴリ", "複数は「,」「;」「、」で区切る")
        self.newcat_var = tk.StringVar()
        ttk.Entry(f, textvariable=self.newcat_var).grid(row=0, column=0, sticky=(tk.W, tk.E))
        r += 1

        f = self._row(m, r, "一覧での説明 *", "トップの一覧に出る短い説明")
        self.summary_text = tk.Text(f, height=4, wrap=tk.WORD)
        self.summary_text.grid(row=0, column=0, sticky=(tk.W, tk.E))
        r += 1

        f = self._row(m, r, "検索用キーワード", "検索でヒットさせたい語をスペース区切りで")
        self.search_var = tk.StringVar()
        ttk.Entry(f, textvariable=self.search_var).grid(row=0, column=0, sticky=(tk.W, tk.E))
        r += 1

        ttk.Separator(m, orient="horizontal").grid(row=r, column=0, columnspan=2,
                                                   sticky=(tk.W, tk.E), pady=10)
        r += 1
        ttk.Label(m, text="― 検索エンジン向け ―", foreground="gray").grid(
            row=r, column=0, columnspan=2, pady=(0, 6))
        r += 1

        f = self._row(m, r, "説明(meta)", "空なら「一覧での説明」がそのまま使われます")
        self.desc_text = tk.Text(f, height=4, wrap=tk.WORD)
        self.desc_text.grid(row=0, column=0, sticky=(tk.W, tk.E))
        r += 1

        f = self._row(m, r, "キーワード(meta)", "カンマ区切り")
        self.kw_var = tk.StringVar()
        ttk.Entry(f, textvariable=self.kw_var).grid(row=0, column=0, sticky=(tk.W, tk.E))
        r += 1

        f = self._row(m, r, "YouTube動画", "URLを貼ると動画の構造化データが付きます")
        self.video_var = tk.StringVar()
        ttk.Entry(f, textvariable=self.video_var).grid(row=0, column=0, sticky=(tk.W, tk.E))
        r += 1

        self.mathjax_var = tk.BooleanVar()
        ttk.Checkbutton(m, text="数式(MathJax)を使う", variable=self.mathjax_var).grid(
            row=r, column=1, sticky=tk.W, pady=4)
        r += 1

        bar = ttk.Frame(self, padding=(16, 0, 16, 14))
        bar.pack(fill=tk.X)
        ttk.Button(bar, text="キャンセル", command=self.destroy).pack(side=tk.RIGHT)
        ttk.Button(bar, text="OK", command=self._ok).pack(side=tk.RIGHT, padx=6)

    def _fill(self, p):
        self.title_var.set(p.get("title", ""))
        self.date_var.set(p.get("date", ""))
        self.datelabel_var.set(p.get("date_label", "作成日"))
        self.updated_var.set(p.get("updated", ""))
        self.search_var.set(p.get("search", ""))
        self.kw_var.set(p.get("keywords", ""))
        self.video_var.set(p.get("video", ""))
        self.mathjax_var.set(bool(p.get("mathjax")))
        self.summary_text.insert("1.0", p.get("summary") or p.get("description", ""))
        if p.get("summary") and p.get("description") != p.get("summary"):
            self.desc_text.insert("1.0", p.get("description", ""))
        for c in p.get("categories", []):
            if c in self.cat_vars:
                self.cat_vars[c].set(True)
            else:
                self.cat_vars[c] = tk.BooleanVar(value=True)

    def _ok(self):
        title = self.title_var.get().strip()
        if not title:
            messagebox.showerror("エラー", "タイトルを入力してください", parent=self)
            return
        cats = [c for c, v in self.cat_vars.items() if v.get()]
        for c in re.split(r"[,;、\n]+", self.newcat_var.get().strip()):
            if c.strip() and c.strip() not in cats:
                cats.append(c.strip())
        if not cats:
            messagebox.showerror("エラー", "カテゴリを1つ以上指定してください", parent=self)
            return
        summary = self.summary_text.get("1.0", tk.END).strip()
        if not summary:
            messagebox.showerror("エラー", "一覧での説明を入力してください", parent=self)
            return
        desc = self.desc_text.get("1.0", tk.END).strip() or summary
        self.result = {
            "title": title,
            "date": self.date_var.get().strip(),
            "date_label": self.datelabel_var.get().strip() or "作成日",
            "updated": self.updated_var.get().strip(),
            "categories": cats,
            "summary": summary,
            "description": desc,
            "search": self.search_var.get().strip(),
            "keywords": self.kw_var.get().strip(),
            "video": extract_video_id(self.video_var.get().strip()),
            "mathjax": bool(self.mathjax_var.get()),
        }
        self.destroy()

    def show(self):
        self.wait_window()
        return self.result


# --------------------------------------------------------------- メインウィンドウ

class SiteManager:
    def __init__(self, root):
        self.root = root
        root.title("ice458の物置き - サイト管理")
        root.geometry("1180x760")
        self.pages = {"project": [], "article": []}
        self.trees = {}
        self.details = {}
        self.server = None
        self._build_ui()
        self.reload()

    # ---- UI
    def _build_ui(self):
        top = ttk.Frame(self.root, padding=(10, 10, 10, 4))
        top.pack(fill=tk.X)
        ttk.Label(top, text="ice458の物置き - サイト管理",
                  font=("", 14, "bold")).pack(side=tk.LEFT)
        ttk.Button(top, text="プレビュー", command=self.preview).pack(side=tk.RIGHT)
        ttk.Button(top, text="点検", command=self.check).pack(side=tk.RIGHT, padx=6)
        ttk.Button(top, text="保存", command=self.save_all).pack(side=tk.RIGHT)
        ttk.Button(top, text="再読み込み", command=self.reload).pack(side=tk.RIGHT, padx=6)

        self.nb = ttk.Notebook(self.root)
        self.nb.pack(fill=tk.BOTH, expand=True, padx=10, pady=4)
        for kind, cfg in KINDS.items():
            self.nb.add(self._make_tab(kind), text=cfg["label"])

        self.status = tk.StringVar(value="準備完了")
        ttk.Label(self.root, textvariable=self.status, relief=tk.SUNKEN,
                  anchor=tk.W, padding=4).pack(fill=tk.X, side=tk.BOTTOM)

    def _make_tab(self, kind):
        frame = ttk.Frame(self.nb, padding=8)
        frame.columnconfigure(1, weight=1)
        frame.rowconfigure(0, weight=1)

        bf = ttk.Frame(frame)
        bf.grid(row=0, column=0, sticky=tk.N, padx=(0, 10))
        for text, cmd in (("新規作成", lambda: self.add(kind)),
                          ("編集", lambda: self.edit(kind)),
                          ("本文を編集", lambda: self.edit_body(kind)),
                          ("削除", lambda: self.delete(kind)),
                          (None, None),
                          ("↑ 上に移動", lambda: self.move(kind, -1)),
                          ("↓ 下に移動", lambda: self.move(kind, 1)),
                          (None, None),
                          ("フォルダを開く", lambda: self.open_folder(kind)),
                          ("ブラウザで見る", lambda: self.open_in_browser(kind))):
            if text is None:
                ttk.Separator(bf, orient="horizontal").pack(fill=tk.X, pady=8)
            else:
                ttk.Button(bf, text=text, width=16, command=cmd).pack(pady=2)

        cols = ("title", "date", "cats", "summary")
        tree = ttk.Treeview(frame, columns=cols, show="headings")
        for c, txt, w in (("title", "タイトル", 240), ("date", "日付", 110),
                          ("cats", "カテゴリ", 160), ("summary", "説明", 380)):
            tree.heading(c, text=txt)
            tree.column(c, width=w)
        sb = ttk.Scrollbar(frame, orient=tk.VERTICAL, command=tree.yview)
        tree.configure(yscrollcommand=sb.set)
        tree.grid(row=0, column=1, sticky="nsew")
        sb.grid(row=0, column=2, sticky="ns")
        tree.bind("<Double-1>", lambda e: self.edit(kind))
        tree.bind("<<TreeviewSelect>>", lambda e: self.on_select(kind))
        self.trees[kind] = tree

        det = tk.Text(frame, width=34, wrap=tk.WORD, state=tk.DISABLED)
        det.grid(row=0, column=3, sticky="nsew", padx=(10, 0))
        self.details[kind] = det
        return frame

    def cur_kind(self):
        return list(KINDS)[self.nb.index(self.nb.select())]

    def selected(self, kind):
        sel = self.trees[kind].selection()
        if not sel:
            messagebox.showwarning("警告", "対象を選択してください")
            return None
        return self.pages[kind][int(sel[0])]

    # ---- データ
    def reload(self):
        if self.dirty_count() and not messagebox.askyesno(
                "確認", "保存していない変更があります。破棄して読み直しますか？"):
            return
        self.pages = load_pages()
        for kind in KINDS:
            self.refresh(kind)
        self.status.set(f"プロジェクト {len(self.pages['project'])} 件 / "
                        f"雑多なメモ等 {len(self.pages['article'])} 件を読み込みました")

    def refresh(self, kind, select=None):
        tree = self.trees[kind]
        tree.delete(*tree.get_children())
        for i, p in enumerate(self.pages[kind]):
            s = p.get("summary") or p.get("description", "")
            tree.insert("", "end", iid=str(i), values=(
                ("* " if p.dirty else "") + p.title,
                p.get("date", ""),
                ", ".join(p.get("categories", [])),
                s[:60] + ("..." if len(s) > 60 else "")))
        if select is not None and 0 <= select < len(self.pages[kind]):
            tree.selection_set(str(select))
            tree.focus(str(select))
            tree.see(str(select))

    def on_select(self, kind):
        sel = self.trees[kind].selection()
        det = self.details[kind]
        det.configure(state=tk.NORMAL)
        det.delete("1.0", tk.END)
        if sel:
            p = self.pages[kind][int(sel[0])]
            lines = [f"タイトル: {p.title}", "",
                     f"URL: {p.get('permalink', '')}", "",
                     f"ファイル: {p.path.relative_to(ROOT)}", "",
                     f"カテゴリ: {', '.join(p.get('categories', []))}", "",
                     f"日付: {p.get('date_label', '作成日')}: {p.get('date', '')}", "",
                     f"最終更新: {p.get('updated', '')}", "",
                     f"検索語: {p.get('search', '')}", "",
                     f"動画: {p.get('video', '') or 'なし'}", "",
                     f"数式: {'あり' if p.get('mathjax') else 'なし'}", "",
                     f"一覧での説明:\n{p.get('summary') or p.get('description', '')}"]
            det.insert("1.0", "\n".join(lines))
        det.configure(state=tk.DISABLED)

    def all_categories(self):
        cats = set()
        for lst in self.pages.values():
            for p in lst:
                cats.update(p.get("categories", []))
        return cats

    def dirty_count(self):
        return sum(1 for lst in self.pages.values() for p in lst if p.dirty)

    # ---- 操作
    def add(self, kind):
        data = PageDialog(self.root, kind, self.all_categories()).show()
        if not data:
            return
        cfg = KINDS[kind]
        slug = make_slug(kind, data["title"])
        page_dir = cfg["dir"] / slug
        page_dir.mkdir(parents=True, exist_ok=True)
        (page_dir / "img").mkdir(exist_ok=True)

        permalink = (f"/{slug}/" if kind == "project" else f"/blog/{slug}/")
        fm = {"layout": cfg["layout"], "type": kind, "nav": cfg["nav"],
              "permalink": permalink, "image": "/logo.png",
              "sitemap": dict(cfg["sitemap"]), "order": 0}
        self._apply(fm, data)

        tpl = ROOT / cfg["template"]
        body = tpl.read_text(encoding="utf-8") if tpl.exists() else "\n<p>ここに本文を書きます。</p>\n"
        body = body.replace("{{TITLE}}", data["title"])
        (page_dir / "index.html").write_text(
            f"---\n{dump_front_matter(fm)}---\n{body}", encoding="utf-8")

        page = Page(page_dir / "index.html")
        self.pages[kind].insert(0, page)
        self._renumber(kind)
        self.refresh(kind, 0)
        self.status.set(f"{slug} を作成しました（保存ボタンで確定）")
        if messagebox.askyesno("作成しました",
                               f"{page_dir.relative_to(ROOT)} を作りました。\n\n"
                               "本文を編集しますか？"):
            self._open_file(page_dir / "index.html")

    def edit(self, kind):
        p = self.selected(kind)
        if not p:
            return
        data = PageDialog(self.root, kind, self.all_categories(), p).show()
        if not data:
            return
        idx = self.pages[kind].index(p)
        self._apply(p, data)
        self.refresh(kind, idx)
        self.on_select(kind)
        self.status.set("変更しました（保存ボタンで確定）")

    def _apply(self, target, data):
        """ダイアログの入力を front matter に反映する（dict でも Page でも可）"""
        setter = target.set if isinstance(target, Page) else (
            lambda k, v: target.__setitem__(k, v) if v not in (None, "", [], False)
            else target.pop(k, None))
        setter("title", data["title"])
        setter("description", data["description"])
        setter("summary", data["summary"] if data["summary"] != data["description"] else None)
        setter("keywords", data["keywords"])
        setter("categories", data["categories"])
        setter("date", data["date"])
        setter("date_label", data["date_label"] if data["date_label"] != "作成日" else None)
        setter("updated", data["updated"])
        setter("search", data["search"])
        setter("mathjax", True if data["mathjax"] else None)
        if data["video"]:
            setter("video", data["video"])
            iso = jp_date_to_iso(data["date"]) or datetime.now().strftime("%Y-%m-%d")
            setter("video_upload_date", f"{iso}T00:00:00+09:00")
        else:
            setter("video", None)
            setter("video_upload_date", None)

    def delete(self, kind):
        p = self.selected(kind)
        if not p:
            return
        d = p.path.parent
        if not messagebox.askyesno(
                "削除の確認",
                f"「{p.title}」を削除します。\n\n"
                f"フォルダ {d.relative_to(ROOT)} ごと消えます。\n"
                "画像も含めて元に戻せません。よろしいですか？"):
            return
        import shutil
        shutil.rmtree(d)
        self.pages[kind].remove(p)
        self._renumber(kind)
        self.refresh(kind)
        self.save_all(quiet=True)
        self.status.set(f"{d.name} を削除しました")

    def move(self, kind, delta):
        sel = self.trees[kind].selection()
        if not sel:
            messagebox.showwarning("警告", "対象を選択してください")
            return
        i = int(sel[0])
        j = i + delta
        lst = self.pages[kind]
        if not (0 <= j < len(lst)):
            return
        lst[i], lst[j] = lst[j], lst[i]
        self._renumber(kind)
        self.refresh(kind, j)

    def _renumber(self, kind):
        for i, p in enumerate(self.pages[kind]):
            p.set("order", i)

    def edit_body(self, kind):
        p = self.selected(kind)
        if p:
            self._open_file(p.path)

    def _open_file(self, path):
        try:
            os.startfile(str(path))          # Windows: 既定のエディタで開く
        except AttributeError:
            subprocess.Popen(["xdg-open", str(path)])

    def open_folder(self, kind):
        p = self.selected(kind)
        if p:
            try:
                os.startfile(str(p.path.parent))
            except AttributeError:
                subprocess.Popen(["xdg-open", str(p.path.parent)])

    def open_in_browser(self, kind):
        p = self.selected(kind)
        if not p:
            return
        if not self._ensure_server():
            return
        webbrowser.open(f"http://127.0.0.1:{PREVIEW_PORT}{p.get('permalink', '/')}")

    # ---- 保存・検査・プレビュー
    def save_all(self, quiet=False):
        n = 0
        for lst in self.pages.values():
            for p in lst:
                if p.dirty:
                    p.save()
                    n += 1
        for kind in KINDS:
            self.refresh(kind)
        self.status.set(f"{n} 件を保存しました" if n else "保存が必要な変更はありません")
        if not quiet and n:
            messagebox.showinfo("保存しました",
                                f"{n} 件のページを保存しました。\n\n"
                                "一覧ページはビルド時に自動生成されるので、\n"
                                "ここで他のファイルを触る必要はありません。")

    def check(self):
        """リンク・画像・重複などの点検"""
        problems = []
        seen = {}
        for kind, lst in self.pages.items():
            for p in lst:
                pl = p.get("permalink", "")
                if not pl:
                    problems.append(f"{p.path.relative_to(ROOT)}: permalink がありません")
                elif pl in seen:
                    problems.append(f"permalink の重複: {pl}")
                else:
                    seen[pl] = p
                if not p.get("summary") and not p.get("description"):
                    problems.append(f"{p.title}: 説明が空です")
                if not p.get("categories"):
                    problems.append(f"{p.title}: カテゴリがありません")
                # 本文中の画像が実在するか
                for src in re.findall(r'<img[^>]+src="([^"]+)"', p.body):
                    if src.startswith(("http://", "https://", "data:", "/")):
                        continue
                    if not (p.path.parent / src).exists():
                        problems.append(f"{p.title}: 画像が見つかりません -> {src}")
                # div の対応
                if p.body.count("<div") != p.body.count("</div>"):
                    problems.append(f"{p.title}: 本文の <div> と </div> の数が合いません")

        if problems:
            messagebox.showwarning("点検結果", "問題が見つかりました:\n\n" +
                                   "\n".join(f"・{x}" for x in problems[:25]) +
                                   (f"\n\n他 {len(problems)-25} 件" if len(problems) > 25 else ""))
        else:
            messagebox.showinfo("点検結果", "問題は見つかりませんでした。")
        self.status.set(f"点検: 問題 {len(problems)} 件")

    def _ensure_server(self):
        """ビルドしてプレビュー用サーバを起動する（起動済みなら再ビルドのみ）"""
        self.status.set("ビルド中...")
        self.root.update_idletasks()
        r = subprocess.run([sys.executable, "-X", "utf8",
                            str(ROOT / "_tools" / "build.py")],
                           cwd=ROOT, capture_output=True, text=True, encoding="utf-8")
        if r.returncode != 0:
            messagebox.showerror("ビルド失敗",
                                 "ページの組み立てに失敗しました:\n\n"
                                 + (r.stdout or "") + (r.stderr or ""))
            self.status.set("ビルド失敗")
            return False
        if self.server is None or self.server.poll() is not None:
            self.server = subprocess.Popen(
                [sys.executable, "-X", "utf8", str(ROOT / "_tools" / "build.py"),
                 "--serve", "--no-browser", "--port", str(PREVIEW_PORT)],
                cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            for _ in range(40):
                try:
                    urllib.request.urlopen(f"http://127.0.0.1:{PREVIEW_PORT}/", timeout=0.25)
                    break
                except urllib.error.URLError:
                    threading.Event().wait(0.15)
                except Exception:
                    break
        self.status.set("プレビュー準備完了")
        return True

    def preview(self):
        if self.dirty_count():
            if messagebox.askyesno("確認", "保存していない変更があります。保存してからプレビューしますか？"):
                self.save_all(quiet=True)
        if self._ensure_server():
            webbrowser.open(f"http://127.0.0.1:{PREVIEW_PORT}/")

    def on_close(self):
        if self.dirty_count() and not messagebox.askyesno(
                "確認", "保存していない変更があります。終了しますか？"):
            return
        if self.server and self.server.poll() is None:
            self.server.terminate()
        self.root.destroy()


def main():
    root = tk.Tk()
    app = SiteManager(root)
    root.protocol("WM_DELETE_WINDOW", app.on_close)
    root.mainloop()


if __name__ == "__main__":
    main()
