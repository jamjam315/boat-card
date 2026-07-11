# -*- coding: utf-8 -*-
"""
サイト共通のog:image(og-image.png)を作る手動ツール。

【重要】このスクリプトはCI(daily.yml/results.yml)には組み込まない。
og:imageは全ページ共通の1枚(案A)で、レースごとに毎回生成する必要が
ないため、手元で1回実行してog-image.pngをコミットする運用にする
(Pillow・日本語フォントをGitHub Actions側に追加する必要を避けるため)。

実行にはPillowが必要(pip install Pillow)。日本語フォントはローカル環境の
ものを使うため、パスは環境に合わせて書き換えること(下記はWindowsの例)。
デザインを直す時だけ、このスクリプトを手元で再実行してog-image.pngを
上書き→コミットする。
"""
from PIL import Image, ImageDraw, ImageFont

FONT_BOLD = "C:/Windows/Fonts/YuGothB.ttc"
FONT_REG = "C:/Windows/Fonts/msgothic.ttc"
OUT = "og-image.png"

W, H = 1200, 630
WATER = "#0f2a33"
ACCENT = "#3bbf9e"
SUB = "#9fc3ba"
INK = "#eaf3f0"
LANE_COLORS = ["#ffffff", "#2b2b2b", "#d83a36", "#2f6fd0", "#f2c200", "#1f9e54"]

TITLE = "艇読み"
TAGLINE = "予想印は出さない。自分で読むための道具。"
URL_TEXT = "teiyomi.com"


def main():
    img = Image.new("RGB", (W, H), color=WATER)
    draw = ImageDraw.Draw(img)

    title_font = ImageFont.truetype(FONT_BOLD, 140)
    tag_font = ImageFont.truetype(FONT_REG, 42)
    url_font = ImageFont.truetype(FONT_REG, 28)

    title_bbox = draw.textbbox((0, 0), TITLE, font=title_font)
    tag_bbox = draw.textbbox((0, 0), TAGLINE, font=tag_font)
    url_bbox = draw.textbbox((0, 0), URL_TEXT, font=url_font)
    title_h = title_bbox[3] - title_bbox[1]
    tag_h = tag_bbox[3] - tag_bbox[1]
    url_h = url_bbox[3] - url_bbox[1]

    gap1, gap2 = 34, 26
    block_h = title_h + gap1 + tag_h + gap2 + url_h
    top = (H - block_h) // 2 + 28  # 視覚的な重心を合わせるための微調整

    left_x = 100
    lane_w, lane_gap = 30, 5
    lane_bar_h = (title_h - 5 * lane_gap) / 6
    lane_top = top - title_bbox[1]
    for i, c in enumerate(LANE_COLORS):
        y0 = lane_top + i * (lane_bar_h + lane_gap)
        draw.rounded_rectangle([left_x, y0, left_x + lane_w, y0 + lane_bar_h], radius=4, fill=c)

    title_x = left_x + lane_w + 34
    draw.text((title_x, top - title_bbox[1]), TITLE, font=title_font, fill=INK)

    tag_y = top + title_h + gap1
    draw.text((left_x, tag_y - tag_bbox[1]), TAGLINE, font=tag_font, fill=SUB)

    url_y = tag_y + tag_h + gap2
    draw.text((left_x, url_y - url_bbox[1]), URL_TEXT, font=url_font, fill=ACCENT)

    img.save(OUT, "PNG", optimize=True)
    print(f"[done] {OUT} を生成しました ({W}x{H})")


if __name__ == "__main__":
    main()
