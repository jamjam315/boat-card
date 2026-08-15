# -*- coding: utf-8 -*-
"""
シェアカード(SNSに貼ったときに出る1枚画像)を作る手動ツール。

作るもの:
  cards/players/{登番}.png … 二つ名を持つ選手のカード(1200x630)
  cards/titles.png          … 二つ名殿堂そのもののカード

【CIには組み込まない】make_og_image.py と同じ運用。手元で実行して生成物を
コミットする。理由は2つ:
  1. Pillowと日本語フォントをGitHub Actions側に用意する必要が出る
  2. PNGはgitのdelta圧縮がほぼ効かない。毎晩作り直すと、変わったぶんが
     そのまま履歴に積み上がる(実測: 143枚で約9MB。毎晩やれば年3GB超)。
     二つ名は「殿堂」なので、指標が0.1pt動いた瞬間に描き直す必要はない。
顔ぶれが動いたときに手で実行し、あわせて build_all_player_pages.py も
流し直すこと(選手ページのog:imageがカードの有無で分岐するため)。

実行にはPillowが必要(pip install Pillow)。

【フォントについて】
手元のWindowsのYu Gothicで固定している(make_og_image.py・make_app_icons.py と同じ)。
CIのUbuntuにはNoto Sans CJKしか無く、字形が変わる。途中で生成環境を変えると
同じ選手のカードが別物に見えるので、生成はこのスクリプトを実行する1台に固定する。

【絵文字は使わない】
カラー絵文字はフォント(seguiemj / Noto Color Emoji)に依存し、環境で見た目が変わる。
「頂」は金の枠と金の文字で表しているので、記号に頼らなくても区別がつく。
"""
import io
import json
import os

from PIL import Image, ImageDraw, ImageFont

FONT_B = "C:/Windows/Fonts/YuGothB.ttc"
FONT_R = "C:/Windows/Fonts/YuGothR.ttc"

TITLES_JSON = os.path.join("players", "career", "titles.json")
OUT_DIR = os.path.join("cards", "players")
OUT_TITLES = os.path.join("cards", "titles.png")

W, H = 1200, 630          # Xのsummary_large_imageの比率。これならトリミングされない
MARGIN = 70
MAX_PILLS = 3             # カードに出す称号の数。これを超えたぶんは「ほか◯個」

# theme.css のダーク「夜の水面」から。カードはダーク固定
# (同じ選手のカードが人によって違う色で流れると、ブランドとして弱くなるため)。
BG = "#0a1114"
STRIPE = "#0d161a"        # 背景のうっすらした横縞(サイトのヘッダーと同じ趣向)
INK = "#eaf3f0"
SUB = "#9fc3ba"
ACCENT = "#2fb894"
ACCENT_SOFT = "#102a25"
GOLD = "#e0b054"
GOLD_SOFT = "#2b2214"
LINE = "#1d3a42"
LANE_COLORS = ["#ffffff", "#2b2b2b", "#d83a36", "#2f6fd0", "#f2c200", "#1f9e54"]


def fit(path, text, max_w, start, floor=14):
    """max_wに収まる最大の文字サイズを返す。名前の長さが人によって違うので、
    固定サイズにすると必ずどこかではみ出す。"""
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
    """下部の帯: 6色のレーンバー + ロゴ + URL。2種のカードで共通の見た目にする。
    ここがブランドを覚えてもらうための装置なので、位置と大きさは変えない。"""
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


def metric_text(t):
    """称号ごとに単位が違うので、サイトの表示と同じ読み方に揃える。
      守護神 … 当地1着率そのもの(絶対値)
      音速   … 平均ST(小さいほど速い)
      それ以外 … 対全国・対本人の差(pt)"""
    base = t["title"].replace("・頂", "")
    if t.get("kind") == "guardian":
        return f"{base}　1着率 {t['metric'] * 100:.1f}%・{t['n']:,}走"
    if base == "音速の申し子":
        return f"{base}　平均ST {t['metric']:.3f}・{t['n']:,}走"
    return f"{base}　+{t['metric'] * 100:.1f}pt・{t['n']:,}走"


def load_holders():
    """登番 -> {name, class, titles[]} を作る。titles は「頂が先、次に順位順」。"""
    doc = json.load(io.open(TITLES_JSON, encoding="utf-8"))
    by = {}

    def add(h, kind=None):
        rec = by.setdefault(h["toban"], {"name": h["name"], "class": h["class"], "titles": []})
        item = dict(h)
        if kind:
            item["kind"] = kind
        rec["titles"].append(item)

    for sec in doc["titles"]:
        for h in sec["holders"]:
            add(h)
    for key, kind in (("guardians", "guardian"), ("children", "child")):
        for g in doc.get(key, []):
            if g["holder"]:
                add(g["holder"], kind)

    for rec in by.values():
        # 頂を先頭に、あとは順位が上のものから。同点は称号名で固定して、
        # 実行のたびに並びが変わらないようにする。
        rec["titles"].sort(key=lambda t: (not t["is_top"], t["rank"], t["title"]))
    return by, doc


def player_card(rec):
    img, d = base_card()

    d.text((MARGIN, 58), "二つ名", font=ImageFont.truetype(FONT_R, 26), fill=SUB)

    name = rec["name"] or "―"
    nf = fit(FONT_B, name, 620, 92)
    d.text((MARGIN, 96), name, font=nf, fill=INK)
    cf = ImageFont.truetype(FONT_R, 34)
    d.text((MARGIN + text_w(nf, name) + 22, 96 + nf.size - 44), rec["class"] or "―",
           font=cf, fill=SUB)

    shown = rec["titles"][:MAX_PILLS]
    rest = len(rec["titles"]) - len(shown)

    # 称号のピル(左)と、その根拠の数値(右)。同じ高さで左右に並べて、
    # どの数字がどの称号のものか目で追えるようにする。
    #
    # 称号の数は1〜3人それぞれで、保持者143人のうち110人は1個だけ。
    # 上詰めにすると1個の人のカードが下半分まるごと空いて未完成に見えるので、
    # 名前と注記のあいだの帯にブロックごと縦中央で置く。
    PILL_H, PILL_GAP = 64, 14
    AREA_TOP, AREA_BOTTOM = 196, 470
    block_h = len(shown) * PILL_H + (len(shown) - 1) * PILL_GAP + (34 if rest > 0 else 0)
    y = AREA_TOP + (AREA_BOTTOM - AREA_TOP - block_h) // 2

    mf = ImageFont.truetype(FONT_R, 25)
    for t in shown:
        top = t["is_top"]
        col, bg = (GOLD, GOLD_SOFT) if top else (ACCENT, ACCENT_SOFT)
        tf = fit(FONT_B, t["title"], 560, 46)
        pw = text_w(tf, t["title"]) + 46
        d.rounded_rectangle([MARGIN, y, MARGIN + pw, y + PILL_H], radius=PILL_H // 2,
                            fill=bg, outline=col, width=2)
        d.text((MARGIN + 23, y + 8), t["title"], font=tf, fill=col)

        line = metric_text(t)
        f = mf if text_w(mf, line) <= 470 else fit(FONT_R, line, 470, 25, 17)
        d.text((W - MARGIN - text_w(f, line), y + (PILL_H - f.size) // 2 - 2),
               line, font=f, fill=SUB)
        y += PILL_H + PILL_GAP

    if rest > 0:
        d.text((MARGIN + 4, y - PILL_GAP + 6), f"ほか{rest}個",
               font=ImageFont.truetype(FONT_R, 26), fill=SUB)

    d.text((MARGIN, 492), "過去10年・55万レースの機械的集計から自動で付与",
           font=ImageFont.truetype(FONT_R, 23), fill="#6f8a84")

    brand_band(d)
    return img


def titles_card(doc):
    """殿堂そのものを共有したときの1枚。"""
    img, d = base_card()
    d.text((MARGIN, 92), "二つ名殿堂", font=ImageFont.truetype(FONT_B, 96), fill=INK)
    d.text((MARGIN, 214), "条件別成績から生まれた称号と、その保持者たち",
           font=ImageFont.truetype(FONT_R, 34), fill=SUB)

    n_titles = len(doc["titles"]) + 2      # 14称号 + 守護神 + 申し子
    holders = set()
    for sec in doc["titles"]:
        for h in sec["holders"]:
            holders.add(h["toban"])
    for key in ("guardians", "children"):
        for g in doc.get(key, []):
            if g["holder"]:
                holders.add(g["holder"]["toban"])

    x = MARGIN
    for label, value in (("称号", f"{n_titles}"), ("保持者", f"{len(holders)}人"),
                         ("集計", "55万レース")):
        d.text((x, 300), label, font=ImageFont.truetype(FONT_R, 25), fill=SUB)
        vf = ImageFont.truetype(FONT_B, 72)
        d.text((x, 334), value, font=vf, fill=ACCENT)
        x += max(text_w(vf, value) + 70, 220)

    d.text((MARGIN, H - 152), "名乗れるのは現役選手の上位10名だけ（会場の称号は各場1人）",
           font=ImageFont.truetype(FONT_R, 23), fill="#6f8a84")
    brand_band(d)
    return img


def main():
    by, doc = load_holders()
    os.makedirs(OUT_DIR, exist_ok=True)

    written = total = 0
    for toban in sorted(by):
        path = os.path.join(OUT_DIR, f"{toban}.png")
        player_card(by[toban]).save(path, "PNG", optimize=True)
        written += 1
        total += os.path.getsize(path)

    titles_card(doc).save(OUT_TITLES, "PNG", optimize=True)
    total += os.path.getsize(OUT_TITLES)

    # 名簿から外れた選手のカードが残っていると、選手ページ側が
    # 「カードあり」と判断して古い称号のまま共有されてしまう。ここで消す。
    stale = [f for f in os.listdir(OUT_DIR)
             if f.endswith(".png") and f[:-4] not in by]
    for f in stale:
        os.remove(os.path.join(OUT_DIR, f))

    print(f"[done] {OUT_DIR}/ 生成: {written}枚 / {OUT_TITLES} 1枚 "
          f"/ 合計 {total / 1024 / 1024:.1f} MB / 平均 {total // (written + 1):,} bytes")
    if stale:
        print(f"       保持者でなくなった {len(stale)}枚を削除: {', '.join(sorted(stale)[:8])}")
    print("       ※ 選手ページのog:imageはカードの有無で分岐するので、"
          "このあと build_all_player_pages.py も流し直すこと")


if __name__ == "__main__":
    main()
