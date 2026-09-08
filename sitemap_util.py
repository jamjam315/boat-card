# -*- coding: utf-8 -*-
"""sitemap.xml の組み立て。build_all_player_pages.py と build_race_pages.py の共通部分。

【なぜ1か所にまとめたか】
sitemap.xml は上の2本が「全体を」書き出す。片方の一覧にだけ在るURLは、後から
走ったほうに消される。実際に yomi-guide.html がそれで消えていた。写しを2つ
持たないよう、固定ページは site_pages.json、検証結果は checked_data.json から
両方がここ経由で引く。

【lastmod は中身が変わった日にする】
以前は生成した日を全URLに一律で入れていた。選手ページは10日間変わっていない
のに、毎日1,636件が「更新された」と申告していたことになる。Googleに対して
嘘を毎日つくと lastmod ごと信用されなくなるので、中身で判定する。

判定は「ファイルの中身のハッシュが前回と違うか」。ファイルの更新時刻は使えない
(CIの actions/checkout は全ファイルの mtime をチェックアウト時刻にする)。
git の履歴も使えない(checkout の既定は depth=1 で、履歴が無い)。
記録は site_lastmod.json に持ち、sitemap から消えたURLの行は捨てる。
"""
import datetime
import hashlib
import json
import os
from xml.sax.saxutils import escape

SITE = "https://teiyomi.com"
PAGES_JSON = "site_pages.json"
CHECKED_JSON = "checked_data.json"
LASTMOD_JSON = "site_lastmod.json"
SITEMAP = "sitemap.xml"


def _load(path, default):
    if not os.path.exists(path):
        return default
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def fixed_urls():
    """トップや各ガイドなど、生成物でない固定ページ。"""
    doc = _load(PAGES_JSON, {})
    return [SITE + p for p in doc.get("fixed", [])]


def checked_urls():
    """定番の検証結果。一覧 + 各ページ。"""
    doc = _load(CHECKED_JSON, {})
    items = doc.get("items", [])
    if not items:
        return []
    return [f"{SITE}/checked/"] + [f"{SITE}/checked/{it['slug']}.html" for it in items]


def local_path(url):
    """URL からリポジトリ内のファイルへ。無ければ None。

    ディレクトリで終わるURLは index.html を見る。"""
    p = url[len(SITE):].lstrip("/")
    if p == "" or p.endswith("/"):
        p += "index.html"
    return p if os.path.exists(p) else None


def _digest(path):
    h = hashlib.sha1()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()[:16]


def lastmod_map(urls, today=None):
    """URLごとの lastmod。中身が前回と違うURLだけ今日の日付にする。

    ファイルが見つからないURL(まだ生成していない・外部)は今日にする。
    嘘をつかないための仕組みなので、判定できないものを古い日付で
    据え置くほうが危ない。"""
    today = today or datetime.date.today().isoformat()
    store = _load(LASTMOD_JSON, {})
    out = {}
    kept = changed = unknown = 0
    for url in urls:
        path = local_path(url)
        if path is None:
            out[url] = {"d": today, "h": None}
            unknown += 1
            continue
        h = _digest(path)
        before = store.get(url)
        if before and before.get("h") == h and before.get("d"):
            out[url] = {"d": before["d"], "h": h}
            kept += 1
        else:
            out[url] = {"d": today, "h": h}
            changed += 1
    # sitemap から消えたURLの記録は残さない(レースページは7日で入れ替わる)。
    with open(LASTMOD_JSON, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    print(f"[sitemap] lastmod 据え置き{kept}件 / 更新{changed}件 / ファイル無し{unknown}件")
    return {u: v["d"] for u, v in out.items()}


def write(urls):
    """sitemap.xml を書き出す。重複は先に出たほうを残して落とす。"""
    seen = set()
    uniq = []
    for u in urls:
        if u in seen:
            continue
        seen.add(u)
        uniq.append(u)
    mods = lastmod_map(uniq)
    lines = ['<?xml version="1.0" encoding="UTF-8"?>',
             '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for u in uniq:
        lines.append(f"  <url><loc>{escape(u)}</loc><lastmod>{mods[u]}</lastmod></url>")
    lines.append("</urlset>")
    with open(SITEMAP, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    return len(uniq)
