#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
画像・アニメGIF の最適化。

方針:
  * 解像度とフレームレートは一切変えない。縮小もコマ落としもしない。
    削減はすべて符号化方式の変更によるもの。
  * 静止画は WebP の可逆・非可逆の両方を試し、小さい方を採る。
    写真は非可逆が圧倒的に有利だが、図やスクリーンショットは
    非可逆だと逆に膨らむため（実測あり）、一律の設定にはしない。
  * アニメ GIF は WebM(VP9) と MP4(H.264) に変換し <video> に置き換える。
    GIF はディザ済みのため可逆圧縮では元より大きくなる（実測 28MB→56MB）。
  * 変換後は SSIM を測り、画質が基準を下回るものは採用しない。

    python _tools/optimize_media.py            … 何をするか表示するだけ
    python _tools/optimize_media.py --write    … 変換して HTML も書き換える
    python _tools/optimize_media.py --write --delete-originals
                                               … 変換後に元ファイルを削除
"""
import argparse
import html as htmlmod
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

STILL_EXT = {".png", ".jpg", ".jpeg"}
WEBP_QUALITY = 90          # 非可逆 WebP の品質
VP9_CRF = 20               # 動画の品質（小さいほど高画質）
MIN_SSIM_STILL = 0.95
MIN_SSIM_VIDEO = 0.95
MIN_GAIN = 0.05            # 5% 以上小さくならないなら変換しない


def have(cmd):
    return shutil.which(cmd) is not None


def run(args):
    return subprocess.run(args, capture_output=True, text=True, encoding="utf-8",
                          errors="replace")


def ffmpeg(*args):
    r = run(["ffmpeg", "-y", "-loglevel", "error", *[str(a) for a in args]])
    return r.returncode == 0


def ssim(a, b):
    """a と b の SSIM（1.0 が完全一致）。測れなければ None。"""
    r = run(["ffmpeg", "-loglevel", "info", "-i", str(a), "-i", str(b),
             "-lavfi", "[0:v][1:v]ssim", "-f", "null", "-"])
    m = re.findall(r"All:([0-9.]+)", r.stderr)
    return float(m[-1]) if m else None


def probe(path):
    r = run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_frames",
             "-show_entries", "stream=width,height,nb_read_frames,avg_frame_rate",
             "-of", "json", str(path)])
    try:
        s = json.loads(r.stdout)["streams"][0]
        return s
    except Exception:
        return {}


def is_animated_gif(path):
    return probe(path).get("nb_read_frames", "1") not in ("1", "0", "N/A")


def size(p):
    return p.stat().st_size if p.exists() else 0


def fmt(n):
    return f"{n/1048576:.2f}MB" if n >= 1048576 else f"{n/1024:.0f}KB"


# ------------------------------------------------------------ 静止画

def convert_still(src, write):
    """PNG/JPG -> WebP（可逆・非可逆の小さい方）。(出力パス, 元, 新, ssim, 方式) を返す"""
    dst = src.with_suffix(".webp")
    tmp_l = src.parent / (src.stem + ".__ll.webp")
    tmp_q = src.parent / (src.stem + ".__q.webp")
    ok_l = ffmpeg("-i", src, "-c:v", "libwebp", "-lossless", "1", tmp_l)
    ok_q = ffmpeg("-i", src, "-c:v", "libwebp", "-lossless", "0",
                  "-quality", WEBP_QUALITY, tmp_q)
    cands = []
    if ok_l and size(tmp_l):
        cands.append((size(tmp_l), tmp_l, "可逆", 1.0))
    if ok_q and size(tmp_q):
        s = ssim(tmp_q, src)
        if s is None or s >= MIN_SSIM_STILL:
            cands.append((size(tmp_q), tmp_q, "非可逆q%d" % WEBP_QUALITY, s))
    if not cands:
        for t in (tmp_l, tmp_q):
            t.unlink(missing_ok=True)
        return None
    cands.sort()
    new_size, best, mode, s = cands[0]
    orig = size(src)
    if new_size > orig * (1 - MIN_GAIN):
        for t in (tmp_l, tmp_q):
            t.unlink(missing_ok=True)
        return None                      # 縮まないなら変換しない
    if write:
        best.replace(dst)
    for t in (tmp_l, tmp_q):
        t.unlink(missing_ok=True)
    return (dst, orig, new_size, s, mode)


# ------------------------------------------------------------ アニメGIF

def convert_gif(src, write):
    """アニメGIF -> WebM(VP9) + MP4(H.264)。解像度・フレームレートは維持。"""
    info = probe(src)
    webm = src.with_suffix(".webm")
    mp4 = src.with_suffix(".mp4")
    t_webm = src.parent / (src.stem + ".__t.webm")
    t_mp4 = src.parent / (src.stem + ".__t.mp4")
    # WebM(VP9) は奇数サイズも扱えるので、元の解像度そのままで符号化する
    ok1 = ffmpeg("-i", src, "-c:v", "libvpx-vp9", "-crf", VP9_CRF, "-b:v", "0",
                 "-pix_fmt", "yuv420p", "-fps_mode", "passthrough", "-an", t_webm)

    # H.264 は縦横が偶数でないと符号化できない。まず等倍で試し、
    # 失敗したときだけ 1px 分を右下に足す（WebM が先に選ばれるので実害は小さい）
    def enc_mp4(extra):
        return ffmpeg("-i", src, *extra, "-c:v", "libx264", "-crf", 23, "-preset", "slow",
                      "-pix_fmt", "yuv420p", "-fps_mode", "passthrough",
                      "-movflags", "+faststart", "-an", t_mp4)

    mp4_padded = False
    ok2 = enc_mp4([])
    if not (ok2 and size(t_mp4)):
        ok2 = enc_mp4(["-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2"])
        mp4_padded = ok2 and bool(size(t_mp4))
    if not (ok1 and ok2 and size(t_webm) and size(t_mp4)):
        for t in (t_webm, t_mp4):
            t.unlink(missing_ok=True)
        return None
    s = ssim(t_webm, src)
    out_info = probe(t_webm)
    same_geom = (str(out_info.get("width")) == str(info.get("width")) and
                 str(out_info.get("height")) == str(info.get("height")))
    same_frames = str(out_info.get("nb_read_frames")) == str(info.get("nb_read_frames"))
    if s is not None and s < MIN_SSIM_VIDEO:
        for t in (t_webm, t_mp4):
            t.unlink(missing_ok=True)
        return None
    before, after = size(src), size(t_webm) + size(t_mp4)   # 消す前に測る
    if write:
        t_webm.replace(webm)
        t_mp4.replace(mp4)
    else:
        for t in (t_webm, t_mp4):
            t.unlink(missing_ok=True)
    return (webm, mp4, before, after, s, same_geom, same_frames, info, mp4_padded)


# ------------------------------------------------------------ HTML 書き換え

def rewrite_html(page, still_map, gif_map, write):
    """<img src=...png> の拡張子差し替えと、GIF の <video> 置換"""
    t = page.read_text(encoding="utf-8")
    orig = t

    # 1) アニメGIF -> <video>
    def gif_sub(m):
        tag = m.group(0)
        sm = re.search(r'src="([^"]+)"', tag)
        am = re.search(r'alt="([^"]*)"', tag)      # src の前後どちらにあっても拾う
        if not sm:
            return tag
        src, alt = sm.group(1), (am.group(1) if am else "")
        key = (page.parent / re.split(r"[?#]", src)[0]).resolve()
        if key not in gif_map:
            return tag
        base = re.split(r"[?#]", src)[0].rsplit(".", 1)[0]
        label = f' aria-label="{alt}"' if alt else ""
        return (f'<video autoplay loop muted playsinline{label}>\n'
                f'                        <source src="{base}.webm" type="video/webm">\n'
                f'                        <source src="{base}.mp4" type="video/mp4">\n'
                f'                    </video>')

    t = re.sub(r'<img[^>]*\.gif[^>]*>', gif_sub, t)

    # 2) 静止画 -> .webp
    def still_sub(m):
        src = m.group(1)
        clean = re.split(r"[?#]", src)[0]
        key = (page.parent / clean).resolve()
        if key not in still_map:
            return m.group(0)
        return m.group(0).replace(src, clean.rsplit(".", 1)[0] + ".webp")

    t = re.sub(r'<img[^>]+src="([^"]+)"', still_sub, t)

    if t != orig and write:
        page.write_text(t, encoding="utf-8")
    return t != orig


# ------------------------------------------------------------ 本体

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true", help="実際に変換・書き換えする")
    ap.add_argument("--delete-originals", action="store_true",
                    help="変換に成功した元ファイルを削除する")
    a = ap.parse_args()

    if not (have("ffmpeg") and have("ffprobe")):
        print("ffmpeg / ffprobe が見つかりません。\n"
              "  https://www.gyan.dev/ffmpeg/builds/ から入手し、PATH を通してください。")
        return 1

    pages = sorted(list(ROOT.glob("project-*/index.html")) +
                   list(ROOT.glob("blog/*/index.html")))
    imgs = []
    for d in [p.parent for p in pages]:
        for f in sorted((d / "img").glob("*")) if (d / "img").exists() else []:
            if f.suffix.lower() in STILL_EXT or f.suffix.lower() == ".gif":
                imgs.append(f)

    still_map, gif_map = {}, {}
    tot_before = tot_after = 0
    print(f"{'ファイル':52} {'元':>9} {'変換後':>9} {'削減':>6}  方式 / SSIM")
    print("-" * 100)

    for f in imgs:
        if f.suffix.lower() == ".gif" and is_animated_gif(f):
            r = convert_gif(f, a.write)
            if not r:
                print(f"{str(f.relative_to(ROOT))[:52]:52} {fmt(size(f)):>9}   (見送り)")
                continue
            webm, mp4, before, after, s, geom, frames, info, padded = r
            gif_map[f.resolve()] = (webm, mp4)
            tot_before += before; tot_after += after
            note = "解像度・コマ数維持" if (geom and frames) else "!! 幾何/コマ数が不一致"
            if padded:
                note += " (mp4のみ1px調整)"
            print(f"{str(f.relative_to(ROOT))[:52]:52} {fmt(before):>9} {fmt(after):>9} "
                  f"{100*(before-after)//before:5}%  webm+mp4 SSIM={s:.4f} {note}")
        elif f.suffix.lower() in STILL_EXT:
            r = convert_still(f, a.write)
            if not r:
                continue
            dst, before, after, s, mode = r
            still_map[f.resolve()] = dst
            tot_before += before; tot_after += after
            ss = f"SSIM={s:.4f}" if s and s < 1 else "画質劣化なし"
            print(f"{str(f.relative_to(ROOT))[:52]:52} {fmt(before):>9} {fmt(after):>9} "
                  f"{100*(before-after)//before:5}%  {mode} {ss}")

    print("-" * 100)
    if tot_before:
        print(f"{'合計':52} {fmt(tot_before):>9} {fmt(tot_after):>9} "
              f"{100*(tot_before-tot_after)//tot_before:5}%")

    changed = 0
    for p in pages:
        if rewrite_html(p, still_map, gif_map, a.write):
            changed += 1
    print(f"\n参照を書き換えるページ: {changed}")

    if a.write and a.delete_originals:
        n = 0
        for f in list(still_map) + list(gif_map):
            Path(f).unlink(missing_ok=True); n += 1
        print(f"元ファイルを削除: {n} 個")
    elif a.write:
        print("元ファイルは残しています（--delete-originals で削除できます）")
    if not a.write:
        print("\n※ ドライラン。--write を付けると実際に変換します。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
