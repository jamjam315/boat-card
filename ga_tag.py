# -*- coding: utf-8 -*-
"""
Google アナリティクス 4(GA4)の計測タグを HTML に入れる共通の部品(2026-11-22)。

  import ga_tag
  html = ga_tag.add_ga(html)      # 生成したページを書き出す直前に通す(二重には入らない)

  python ga_tag.py               # 公開している全 HTML に入れる(手書きのページ・生成済みのページ)
  python ga_tag.py --check       # 入っていないページ・二重に入っているページを数えるだけ

【タグ】Google 公式の gtag.js をそのまま使う(測定 ID は GA_ID)。<head> の中のできるだけ上、
CSP の <meta> の直後に置く(CSP より前に置くと、その後の計測の送信が CSP に止められる。
CSP が無いページは <meta charset> の直後)。

【CSP も一緒に直す】
どのページも <meta http-equiv="Content-Security-Policy"> で、読み込めるスクリプトと通信先を
自分のサイトなどに限っている。そのままではタグが止められて計測できないので、Google の公式の
指定(https://developers.google.com/tag-platform/security/guides/csp の Google Analytics・
広告の機能なし)を足す:
  script-src  https://www.googletagmanager.com
  img-src     https://www.googletagmanager.com https://*.google-analytics.com
  connect-src https://www.googletagmanager.com https://*.google-analytics.com https://*.google.com
タグの2つ目の <script>(window.dataLayer … の部分)はページに直接書くコードなので、
'unsafe-inline' の無いページ(検証済み・五十音の一覧)では、このコードのハッシュ値(GA_INLINE_HASH)
だけを許可に足す。'unsafe-inline' のあるページにはハッシュを足さない(ハッシュがあると
'unsafe-inline' が効かなくなり、ほかの直書きのコードが止まるため)。

【入れないもの】docs/ のメールの雛形(ウェブページではない)。
"""
import base64
import hashlib
import re
import subprocess
import sys

GA_ID = "G-M31X1QLSLM"
GA_INLINE = (
    "\n"
    "  window.dataLayer = window.dataLayer || [];\n"
    "  function gtag(){dataLayer.push(arguments);}\n"
    "  gtag('js', new Date());\n"
    f"  gtag('config', '{GA_ID}');\n"
)
GA_SNIPPET = (
    f'<script async src="https://www.googletagmanager.com/gtag/js?id={GA_ID}"></script>\n'
    f"<script>{GA_INLINE}</script>\n"
)
GA_INLINE_HASH = "'sha256-" + base64.b64encode(hashlib.sha256(GA_INLINE.encode("utf-8")).digest()).decode() + "'"

GTM = "https://www.googletagmanager.com"
CSP_ADD = {
    "script-src": [GTM],
    "img-src": [GTM, "https://*.google-analytics.com"],
    "connect-src": [GTM, "https://*.google-analytics.com", "https://*.google.com"],
}

CSP_META = re.compile(r'(<meta\s+http-equiv="Content-Security-Policy"\s+content=")([^"]*)("\s*/?>)', re.I)
CHARSET_META = re.compile(r"<meta\s+charset=[^>]*>", re.I)
HEAD_OPEN = re.compile(r"<head(\s[^>]*)?>", re.I)

EXCLUDE_PREFIXES = ("docs/",)   # メールの雛形など、ウェブページではないもの


def csp_with_ga(csp):
    """CSP の中身に GA4 の読み込み元・送信先を足す(足し済みなら何もしない)。"""
    parts = [p.strip() for p in csp.split(";") if p.strip()]
    names = [p.split()[0].lower() for p in parts]
    for name, hosts in CSP_ADD.items():
        if name in names:
            i = names.index(name)
            tokens = parts[i].split()
        else:
            # 書いていない指示は default-src('self')に従っていたので、'self' から始める
            tokens = [name, "'self'"]
            parts.append("")
            names.append(name)
            i = len(parts) - 1
        for h in hosts:
            if h not in tokens:
                tokens.append(h)
        if name == "script-src" and "'unsafe-inline'" not in tokens and GA_INLINE_HASH not in tokens:
            tokens.append(GA_INLINE_HASH)
        parts[i] = " ".join(tokens)
    return "; ".join(parts)


def add_ga(html):
    """HTML に GA4 のタグを入れ、CSP を直す。すでに入っていれば CSP だけ確かめる(二重には入れない)。"""
    m = CSP_META.search(html)
    if m:
        fixed = csp_with_ga(m.group(2))
        if fixed != m.group(2):
            html = html[:m.start(2)] + fixed + html[m.end(2):]
    if GA_ID in html:
        return html
    m = CSP_META.search(html) or CHARSET_META.search(html) or HEAD_OPEN.search(html)
    if not m:
        raise ValueError("<head> が見つからないので、GA4 のタグを入れられません")
    # 改行は LF で入れる(git がコミット時に LF にそろえ、本番も LF で配る。GA_INLINE_HASH は LF の中身で計算)
    return html[:m.end()] + "\n" + GA_SNIPPET.rstrip("\n") + html[m.end():]


def public_html_files():
    """git が管理している公開 HTML(雛形などを除く)。"""
    out = subprocess.run(["git", "ls-files", "*.html"], capture_output=True, text=True, encoding="utf-8",
                         check=True).stdout.split("\n")
    return sorted(p for p in out if p and not p.startswith(EXCLUDE_PREFIXES))


def main():
    check = "--check" in sys.argv
    files = public_html_files()
    changed = missing = doubled = 0
    for p in files:
        with open(p, encoding="utf-8", newline="") as f:
            src = f.read()
        n = src.count(f"googletagmanager.com/gtag/js?id={GA_ID}")
        if n > 1:
            doubled += 1
        if check:
            missing += n == 0
            continue
        out = add_ga(src)
        if out != src:
            with open(p, "w", encoding="utf-8", newline="") as f:
                f.write(out)
            changed += 1
    if check:
        print(f"[ga] 公開 HTML {len(files)}ページ / タグが無い {missing} / 二重 {doubled}")
        return 1 if missing or doubled else 0
    print(f"[ga] 公開 HTML {len(files)}ページ / 書き換えた {changed} / 二重 {doubled}")
    return 1 if doubled else 0


if __name__ == "__main__":
    sys.exit(main())
