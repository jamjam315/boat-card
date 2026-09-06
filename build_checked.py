# -*- coding: utf-8 -*-
"""
定番の検証結果カード(1200x630)と、その着地ページ /checked/*.html を作る手動ツール。

作るもの:
  cards/checked/{slug}.png … Xに貼ったときに出る1枚画像
  checked/{slug}.html      … 着地ページ(og:imageが上のカードを指す)
  checked/index.html       … 12本の一覧

【数字はここで集計しない】
元データは checked_data.json。中の数字は backtest-custom.html を ?preset= で
開いて画面が出した値をそのまま写したもの。ここで集計し直すと、ページのJSと
この画像とで実装が2つになり、片方だけ直したときに数字が食い違う。
食い違えば「運営が盛った」ように見える。だから写すだけにする。

【数字を更新する手順】
  1. python -m http.server 8765 でローカルに立てる
  2. checked_data.json の各 preset を ?preset= に付けて開く
  3. 画面の 対象レース数・的中率・回収率・総賭け金・総払戻・点数 を写す
  4. measured_on を実行日にする
  5. このスクリプトを実行する

【CIには組み込まない】
build_share_cards.py と同じ運用。PillowとCJKフォントをCIに用意する必要が
あるうえ、PNGはgitのdelta圧縮が効かない。生成環境を変えると字形が変わるので、
実行するのは1台に固定する(フォントは手元のWindowsのYu Gothic)。

実行にはPillowが必要(pip install Pillow)。
"""
import datetime
import json
import os

from PIL import Image, ImageDraw, ImageFont

# 見た目は build_share_cards.py に揃える。2種のカードが別物に見えないように、
# 定数はあちらからそのまま持ってきている(片方だけ変えないこと)。
FONT_B = "C:/Windows/Fonts/YuGothB.ttc"
FONT_R = "C:/Windows/Fonts/YuGothR.ttc"

DATA = "checked_data.json"
CARD_DIR = os.path.join("cards", "checked")
PAGE_DIR = "checked"
SITE = "https://teiyomi.com"

W, H = 1200, 630
MARGIN = 70

BG = "#0a1114"
STRIPE = "#0d161a"
INK = "#eaf3f0"
SUB = "#9fc3ba"
ACCENT = "#2fb894"
LINE = "#1d3a42"
LANE_COLORS = ["#ffffff", "#2b2b2b", "#d83a36", "#2f6fd0", "#f2c200", "#1f9e54"]


def fit(path, text, max_w, start, floor=14):
    size = start
    while size > floor:
        f = ImageFont.truetype(path, size)
        if f.getbbox(text)[2] - f.getbbox(text)[0] <= max_w:
            return f
        size -= 2
    return ImageFont.truetype(path, floor)


def text_w(font, text):
    b = font.getbbox(text)
    return b[2] - b[0]


def base_card():
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    for y in range(0, H, 18):
        d.line([(0, y), (W, y)], fill=STRIPE, width=1)
    return img, d


def brand_band(d):
    """下部の帯。build_share_cards.py と同じ位置・同じ大きさにする。
    ここがブランドを覚えてもらう装置なので、カードの種類で変えない。"""
    y = H - 92
    d.line([(MARGIN, y), (W - MARGIN, y)], fill=LINE, width=2)
    bw, gap, bh = 12, 4, 30
    for i, c in enumerate(LANE_COLORS):
        x = MARGIN + i * (bw + gap)
        d.rectangle([x, y + 30, x + bw, y + 30 + bh], fill=c)
    logo = ImageFont.truetype(FONT_B, 34)
    d.text((MARGIN + 6 * (bw + gap) + 14, y + 28), "艇読み", font=logo, fill=INK)
    url = ImageFont.truetype(FONT_R, 26)
    d.text((W - MARGIN - text_w(url, "teiyomi.com"), y + 34), "teiyomi.com", font=url, fill=ACCENT)


def render_card(it, measured_on):
    """1枚。上から 見出し / 条件 / 回収率(大) / 的中率と母数 / 集計日 / フック / 帯。

    回収率をいちばん大きく出すのは、この企画がそこを見せるためのもので、
    かつ「100%未満」が並ぶことがそのまま盛っていない証拠になるため。
    母数と集計日は必ず入れる(数字だけ切り取られても、条件が追える)。"""
    img, d = base_card()

    d.text((MARGIN, 52), "検証結果", font=ImageFont.truetype(FONT_R, 26), fill=SUB)

    cf = fit(FONT_R, it["cond"], W - MARGIN * 2, 34)
    d.text((MARGIN, 92), it["cond"], font=cf, fill=INK)

    # 回収率。数字と単位で大きさを変えて、数字そのものを主役にする。
    nf = ImageFont.truetype(FONT_B, 150)
    lf = ImageFont.truetype(FONT_R, 30)
    d.text((MARGIN, 150), "回収率", font=lf, fill=SUB)
    d.text((MARGIN, 182), it["ret"], font=nf, fill=ACCENT)

    # 的中率と母数。回収率の右に、控えめに置く。
    x2 = MARGIN + text_w(nf, it["ret"]) + 56
    sf = ImageFont.truetype(FONT_R, 27)
    bf = ImageFont.truetype(FONT_B, 42)
    d.text((x2, 196), "的中率", font=sf, fill=SUB)
    d.text((x2, 226), it["hit"], font=bf, fill=INK)
    d.text((x2, 288), "対象レース数", font=sf, fill=SUB)
    d.text((x2, 318), it["races"], font=bf, fill=INK)

    d.text((MARGIN, 356), f"{measured_on}時点・{it['points']}", font=sf, fill=SUB)

    hf = fit(FONT_B, it["hook"], W - MARGIN * 2, 38)
    d.text((MARGIN, 412), it["hook"], font=hf, fill=INK)

    brand_band(d)
    return img


# ---------------------------------------------------------------- 着地ページ

HEAD = """<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'">
<title>{title}</title>
<meta name="description" content="{desc}">
<link rel="canonical" href="{url}">
<meta property="og:type" content="article">
<meta property="og:url" content="{url}">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{desc}">
<meta property="og:image" content="{card}">
<meta name="twitter:card" content="summary_large_image">
<link rel="stylesheet" href="/theme.css">
<style>
body{{margin:0; background:var(--bg); color:var(--ink); font-family:system-ui,-apple-system,"Hiragino Sans","Yu Gothic",sans-serif; line-height:1.75;}}
.wrap{{max-width:680px; margin:0 auto; padding:22px 18px 60px;}}
.crumb{{font-size:12px; color:var(--muted);}}
.crumb a{{color:var(--muted);}}
h1{{font-size:22px; line-height:1.5; margin:14px 0 4px;}}
.cond{{font-size:13px; color:var(--muted); margin-bottom:18px;}}
.nums{{display:grid; grid-template-columns:1fr 1fr; gap:1px; background:var(--line);
 border:1px solid var(--line); border-radius:var(--radius); overflow:hidden;}}
.nums div{{background:var(--surface); padding:14px 16px;}}
.nums .k{{font-size:11.5px; color:var(--muted);}}
.nums .v{{font-size:24px; font-weight:800; margin-top:2px;}}
.nums .v.hi{{color:var(--accent);}}
.nums .wide{{grid-column:1 / -1;}}
.nums .wide .v{{font-size:16px; font-weight:600;}}
p.body{{font-size:14.5px; margin:18px 0;}}
.go{{display:block; text-align:center; text-decoration:none; font-weight:700; font-size:15.5px;
 background:var(--accent); color:var(--on-accent,#fff); padding:15px; border-radius:var(--radius); margin:22px 0 10px;}}
.go small{{display:block; font-weight:400; font-size:11.5px; opacity:.85; margin-top:3px;}}
.also{{font-size:13px; color:var(--muted); margin:14px 0;}}
.note{{font-size:11.5px; color:var(--muted); margin-top:26px; padding-top:14px; border-top:1px solid var(--line);}}
.more{{font-size:13px; margin-top:20px;}}
</style>
</head>
<body>
<div class="wrap">
"""

FOOT = """</div>
</body>
</html>
"""

DISCLAIMER = ("実測の機械的な集計です。買い方の推奨ではありません。"
              "数字は集計日時点のもので、データは毎日増えています。")


def esc(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;"))


def preset_url(it):
    import urllib.parse
    q = urllib.parse.quote(json.dumps(it["preset"], ensure_ascii=False, separators=(",", ":")))
    return "/backtest-custom.html?preset=" + q


def render_page(it, by_key, measured_on):
    url = f"{SITE}/{PAGE_DIR}/{it['slug']}.html"
    card = f"{SITE}/cards/checked/{it['slug']}.png"
    desc = (f"{it['cond']}を買い続けた場合の回収率は{it['ret']}、的中率は{it['hit']}。"
            f"{it['races']}レースの機械的な集計です（{measured_on}時点）。")
    html = HEAD.format(title=esc(f"{it['cond']}の検証結果｜艇読み"),
                       desc=esc(desc), url=url, card=card)
    html += '<p class="crumb"><a href="/">艇読み</a> ／ <a href="/checked/">検証結果</a></p>\n'
    html += f"<h1>{esc(it['hook'])}</h1>\n"
    html += f'<p class="cond">{esc(it["cond"])}</p>\n'

    html += ('<div class="nums">'
             f'<div><div class="k">回収率</div><div class="v hi">{esc(it["ret"])}</div></div>'
             f'<div><div class="k">的中率</div><div class="v">{esc(it["hit"])}</div></div>'
             f'<div><div class="k">対象レース数</div><div class="v">{esc(it["races"])}</div></div>'
             f'<div><div class="k">1レースあたり</div><div class="v">{esc(it["points"])}</div></div>'
             f'<div class="wide"><div class="k">総賭け金 ／ 総払戻</div>'
             f'<div class="v">{esc(it["stake"])} ／ {esc(it["payout"])}</div></div>'
             f'<div class="wide"><div class="k">期間 ／ 集計日</div>'
             f'<div class="v">過去10年 ／ {esc(measured_on)}時点</div></div>'
             '</div>\n')

    html += f'<p class="body">{esc(it["body"])}</p>\n'
    html += (f'<a class="go" href="{esc(preset_url(it))}">この条件を自分で回す'
             '<small>同じ条件でバックテストが開きます</small></a>\n')

    if it.get("also"):
        o = by_key[it["also"]]
        html += (f'<p class="also">あわせて見る：'
                 f'<a href="/{PAGE_DIR}/{o["slug"]}.html">{esc(o["cond"])}（回収率{esc(o["ret"])}）</a></p>\n')

    html += f'<p class="more"><a href="/{PAGE_DIR}/">ほかの検証結果を見る</a></p>\n'
    html += f'<p class="note">{esc(DISCLAIMER)}</p>\n'
    return html + FOOT


def render_index(items, measured_on):
    url = f"{SITE}/{PAGE_DIR}/"
    desc = f"1号艇の単勝を10年買い続けたら？ 条件を指定した検証の結果を{len(items)}本。すべて実測の機械的な集計です（{measured_on}時点）。"
    html = HEAD.format(title=esc("検証結果｜艇読み"), desc=esc(desc), url=url,
                       card=f"{SITE}/og-image.png")
    html += '<p class="crumb"><a href="/">艇読み</a> ／ 検証結果</p>\n'
    html += "<h1>買い続けたら、どうなるか。</h1>\n"
    html += (f'<p class="cond">条件を決めて過去10年ぶんを集計した結果です（{esc(measured_on)}時点）。'
             "どれも同じ条件を自分で回せます。</p>\n")
    for it in items:
        html += (f'<a class="go" style="background:var(--surface);color:var(--ink);'
                 f'border:1px solid var(--line);text-align:left;" '
                 f'href="/{PAGE_DIR}/{it["slug"]}.html">{esc(it["cond"])}'
                 f'<small>回収率 {esc(it["ret"])} ／ 的中率 {esc(it["hit"])} ／ {esc(it["races"])}レース</small></a>\n')
    html += f'<p class="note">{esc(DISCLAIMER)}</p>\n'
    return html + FOOT


# ---------------------------------------------------------------- sitemap

def update_sitemap(items):
    """既存の sitemap.xml に /checked/ を足す。作り直さない。

    sitemap.xml は build_all_player_pages.py と build_race_pages.py が
    それぞれ全体を書き出しており、そちらの固定URL一覧にも同じものを足してある。
    ここで足すだけだと、次にあちらが走ったときに消える。"""
    path = "sitemap.xml"
    if not os.path.exists(path):
        print("[checked] sitemap.xml が無いので触りません。")
        return 0
    with open(path, encoding="utf-8") as f:
        xml = f.read()
    today = datetime.date.today().isoformat()
    add = [f"{SITE}/{PAGE_DIR}/"] + [f"{SITE}/{PAGE_DIR}/{it['slug']}.html" for it in items]
    add = [u for u in add if f"<loc>{u}</loc>" not in xml]
    if not add:
        print("[checked] sitemap.xml は既に最新です。")
        return 0
    block = "".join(
        f"  <url><loc>{u}</loc><lastmod>{today}</lastmod></url>\n" for u in add)
    xml = xml.replace("</urlset>", block + "</urlset>")
    with open(path, "w", encoding="utf-8") as f:
        f.write(xml)
    print(f"[checked] sitemap.xml に {len(add)}件 足しました。")
    return len(add)


# ---------------------------------------------------------------- X投稿文

def post_text(it, measured_on):
    """投稿はしない。文面を目で確かめるために出すだけ。

    条件の文字列は末尾に「・過去10年」を含んでいる。型のほうにも
    「を過去10年買い続けたら」があるので、ここでは落とす
    (そのまま差し込むと「過去10年を過去10年買い続けたら」になる)。"""
    cond = it["cond"]
    tail = "・過去10年"
    if cond.endswith(tail):
        cond = cond[:-len(tail)]
    return (f"{cond}を過去10年買い続けたら、回収率{it['ret']}でした。\n"
            f"{it['races']}レースの機械的な集計です（{measured_on}時点）。\n"
            f"同じ条件を自分で回せます↓\n"
            f"#艇読み\n"
            f"{SITE}/{PAGE_DIR}/{it['slug']}.html")


def main():
    with open(DATA, encoding="utf-8") as f:
        doc = json.load(f)
    items = doc["items"]
    measured_on = doc["measured_on"]
    by_key = {it["key"]: it for it in items}

    os.makedirs(CARD_DIR, exist_ok=True)
    os.makedirs(PAGE_DIR, exist_ok=True)

    for it in items:
        img = render_card(it, measured_on)
        img.save(os.path.join(CARD_DIR, f"{it['slug']}.png"), optimize=True)
        with open(os.path.join(PAGE_DIR, f"{it['slug']}.html"), "w", encoding="utf-8") as f:
            f.write(render_page(it, by_key, measured_on))
        print(f"[checked] {it['key']} {it['slug']} 回収率{it['ret']} / {it['races']}レース")

    with open(os.path.join(PAGE_DIR, "index.html"), "w", encoding="utf-8") as f:
        f.write(render_index(items, measured_on))

    n = update_sitemap(items)
    print(f"\n[done] カード{len(items)}枚 / ページ{len(items) + 1}枚 / sitemap +{n}\n")

    print("---- X投稿文（投稿はしません。目で確かめる用）----")
    for it in items:
        print(f"\n[{it['key']}]")
        print(post_text(it, measured_on))


if __name__ == "__main__":
    main()
