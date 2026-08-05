#!/usr/bin/env python3
"""和欧文の境界に手で入れた半角スペースを削除する（text-autospace 移行用）。

CSS の text-autospace: normal がブラウザ側で八分アキを入れるため、記事中の
手動スペースが残っていると「半角スペース + 八分アキ」で開きすぎる。
テキストノードのうち、片側が和文（かな/漢字/和文約物）でもう片側が ASCII 英数
という境界にある半角スペース1個だけを削除する。

除外するもの:
  - タグの内部（属性値）と HTML コメント
  - script / style / pre / code / textarea の中身
  - front matter（search: など空白区切りのフィールドがあるため）
  - MathJax の数式（mathjax: true のページのみ判定）

使い方:
    python _tools/strip_autospace.py            # dry-run（差分を表示するだけ）
    python _tools/strip_autospace.py --apply    # 実際に書き換える
"""
from __future__ import annotations

import argparse
import io
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# ビルド成果物・旧サイトアーカイブ・サブモジュールは対象外
SKIP_DIRS = {"_site", "bp", ".git", "__pycache__", "node_modules"}

# 和文とみなす範囲。U+3000（全角スペース）はそれ自体が空白なので除く。
JA = r"[、-〿぀-ヿㇰ-ㇿ㐀-䶿一-鿿豈-﫿！-ﾟ]"
ALNUM = r"[0-9A-Za-z]"

# 和欧の間にあっても「地続き」とみなすインライン要素。
# code / pre はここに入れない（中身を保護する側なので跨がせない）。
INLINE_TAGS = (
    "span|strong|em|b|i|a|sub|sup|small|u|mark|abbr|cite|q|s|del|ins|var|time"
)
INLINE = rf"(?:</?(?:{INLINE_TAGS})\b[^>]*>)*"

PAT_JA_FIRST = re.compile(
    rf"(?P<a>{JA})(?P<t1>{INLINE})(?P<sp> )(?P<t2>{INLINE})(?P<b>{ALNUM})"
)
PAT_AL_FIRST = re.compile(
    rf"(?P<a>{ALNUM})(?P<t1>{INLINE})(?P<sp> )(?P<t2>{INLINE})(?P<b>{JA})"
)

RE_COMMENT = re.compile(r"<!--.*?-->", re.S)
RE_RAW_BLOCK = re.compile(
    r"<(script|style|pre|code|textarea)\b[^>]*>.*?</\1\s*>", re.S | re.I
)
RE_TAG = re.compile(r"<[^>]*>")
# Liquid（テンプレートのコメント・タグ・出力）は組版対象ではないので触らない
RE_LIQUID = [
    re.compile(r"\{%-?\s*comment\s*-?%\}.*?\{%-?\s*endcomment\s*-?%\}", re.S),
    re.compile(r"\{%.*?%\}", re.S),
    re.compile(r"\{\{.*?\}\}", re.S),
]
RE_MATH = [
    re.compile(r"\$\$.*?\$\$", re.S),
    re.compile(r"\$[^$\n]+\$"),
    re.compile(r"\\\(.*?\\\)", re.S),
    re.compile(r"\\\[.*?\\\]", re.S),
]


def build_protected(text: str) -> bytearray:
    """書き換えてはいけない位置に 1 を立てたマスクを返す。"""
    mask = bytearray(len(text))

    def protect(start: int, end: int) -> None:
        for i in range(start, end):
            mask[i] = 1

    # front matter
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            protect(0, text.index("\n", end + 1) if "\n" in text[end + 1:] else len(text))

    for pat in (RE_COMMENT, RE_RAW_BLOCK, *RE_LIQUID, RE_TAG):
        for m in pat.finditer(text):
            protect(m.start(), m.end())

    if re.search(r"^mathjax:\s*true", text, re.M):
        for pat in RE_MATH:
            for m in pat.finditer(text):
                protect(m.start(), m.end())

    return mask


def find_removals(text: str) -> list[int]:
    """削除すべき半角スペースの位置を昇順で返す。"""
    mask = build_protected(text)
    positions: set[int] = set()
    for pat in (PAT_JA_FIRST, PAT_AL_FIRST):
        for m in pat.finditer(text):
            sp = m.start("sp")
            if mask[sp] or mask[m.start("a")] or mask[m.start("b")]:
                continue
            positions.add(sp)
    return sorted(positions)


def apply_removals(text: str, positions: list[int]) -> str:
    out: list[str] = []
    prev = 0
    for p in positions:
        out.append(text[prev:p])
        prev = p + 1
    out.append(text[prev:])
    return "".join(out)


def context(text: str, pos: int, width: int = 20) -> str:
    snippet = text[max(0, pos - width): pos + width + 1]
    return snippet.replace("\n", "\\n")


def iter_html_files() -> list[Path]:
    files = []
    for p in sorted(ROOT.rglob("*.html")):
        rel = p.relative_to(ROOT)
        if any(part in SKIP_DIRS for part in rel.parts):
            continue
        files.append(p)
    return files


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="実際にファイルを書き換える")
    ap.add_argument("--verbose", action="store_true", help="変更箇所を全件表示する")
    args = ap.parse_args()

    total_files = 0
    total_hits = 0
    for path in iter_html_files():
        text = io.open(path, encoding="utf-8", newline="").read()
        positions = find_removals(text)
        if not positions:
            continue
        total_files += 1
        total_hits += len(positions)
        rel = path.relative_to(ROOT).as_posix()
        print(f"{rel}: {len(positions)} 箇所")
        if args.verbose or not args.apply:
            shown = positions if args.verbose else positions[:5]
            for p in shown:
                print(f"    …{context(text, p)}…")
            if len(positions) > len(shown):
                print(f"    …ほか {len(positions) - len(shown)} 箇所")
        if args.apply:
            io.open(path, "w", encoding="utf-8", newline="").write(
                apply_removals(text, positions)
            )

    verb = "削除しました" if args.apply else "削除対象（dry-run）"
    print(f"\n合計: {total_files} ファイル / {total_hits} 箇所 {verb}")
    if not args.apply:
        print("実際に書き換えるには --apply を付けて実行してください。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
