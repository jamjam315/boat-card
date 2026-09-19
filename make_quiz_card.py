# -*- coding: utf-8 -*-
"""
今日の一問(quiz.html)専用の og:image(cards/quiz.png・1200x630)を作る手動ツール(⑥b)。

  python make_quiz_card.py

【CIには組み込まない】build_share_cards.py・make_og_image.py と同じ運用。手元で実行して生成物を
コミットする。フォントは手元の Windows の Yu Gothic で固定(生成は1台に固定・字形を変えないため)。

【絵柄】固定の看板。選手名・会場名・日付は入れない(毎日変わる出題の中身は載せない)。
  ・艇番の6色の小さなボート(真上から見た図形・再生 quiz-replay.js と同じ形を艇首が上になるよう回した
    オリジナル)が、横一列でスタートラインに並ぶ
  ・「今日の一問」+「過去の実レースで、読みの練習。」+ 下の帯(6色のレーンバー・艇読み・teiyomi.com)
画像ファイル・ロゴ画像・キャラクターは使わない(すべてここで描く)。
様式は検証カード(build_share_cards.py)のダーク固定をそのまま使う(背景・横縞・下の帯)。

実行にはPillowが必要(pip install Pillow)。
"""
import os

from PIL import Image, ImageDraw, ImageFont

from build_share_cards import (FONT_B, FONT_R, H, INK, MARGIN, SUB, W,
                               base_card, brand_band)

OUT = os.path.join("cards", "quiz.png")

# 艇の色(地・数字・縁取り)。再生(quiz.js の LANES・quiz-replay.js の boatSvg)と同じ。
# 白と黒だけ細い縁取り(黒は暗い地に沈まないよう明るい縁)。
BOATS = [
    ("#ffffff", "#1a1a1a", "#5a5a5a"),
    ("#2b2b2b", "#ffffff", "#b5b5b5"),
    ("#d83a36", "#ffffff", None),
    ("#2f6fd0", "#ffffff", None),
    ("#f2c200", "#3a2e00", None),
    ("#1f9e54", "#ffffff", None),
]

SS = 4                 # 艇は4倍で描いて縮める(Pillow の多角形は縁がギザギザになるため)
BOAT_S = 4.4           # 再生の艇(長さ34・幅18の座標)を何倍にするか → 長さ約150px・幅約79px
GAP = 40               # 艇と艇のすきま
ROW_TOP = 300          # 艇の列の上端(艇首の少し上にスタートラインを引く)


def quad(p0, p1, p2, n=16):
    """2次ベジェの点列(p0 は含めない)。"""
    out = []
    for i in range(1, n + 1):
        t = i / n
        x = (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0]
        y = (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1]
        out.append((x, y))
    return out


def hull_outline():
    """再生の艇(quiz-replay.js boatSvg: M3 2.5 H21 Q30.5 2.5 33 9 Q30.5 15.5 21 15.5 H3 Z)の輪郭。
    (長さ方向 L, 幅方向 T) の点列。L は船尾0→艇首33、T は -6.5〜+6.5。"""
    pts = [(3, -6.5), (21, -6.5)]
    pts += quad((21, -6.5), (30.5, -6.5), (33, 0))
    pts += quad((33, 0), (30.5, 6.5), (21, 6.5))
    pts += [(3, 6.5)]
    return pts


def draw_boats(card):
    n = len(BOATS)
    bw = 18 * BOAT_S                  # 艇の幅(横)
    bl = 34 * BOAT_S                  # 艇の長さ(縦)
    total = n * bw + (n - 1) * GAP
    x0 = (W - total) / 2
    line_y = ROW_TOP                  # スタートライン(艇首のすぐ上)
    top = line_y + 14                 # 艇首の先端

    # 艇を描く層(4倍)。横は全幅、縦は艇の範囲だけ
    lw, lh = W * SS, int((bl + 40) * SS)
    layer = Image.new("RGBA", (lw, lh), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    num_font = ImageFont.truetype(FONT_B, int(48 * SS))
    outline = hull_outline()
    for i, (fill, ink, stroke) in enumerate(BOATS):
        cx = (x0 + i * (bw + GAP) + bw / 2) * SS
        bow_y = 8 * SS                                    # 層の中の艇首の位置
        stern_y = bow_y + 33 * BOAT_S * SS

        def to_px(L, T):
            # 艇首が上: L が大きいほど上へ
            return (cx + T * BOAT_S * SS, stern_y - L * BOAT_S * SS)

        # 船尾のモーター(小さな影)
        m0 = to_px(3.5, -2.5)
        m1 = to_px(0.5, 2.5)
        d.rounded_rectangle([m0[0], m0[1], m1[0], m1[1]], radius=1.2 * BOAT_S * SS, fill="#6b6b6b")
        pts = [to_px(L, T) for (L, T) in outline]
        d.polygon(pts, fill=fill)
        if stroke:
            d.line(pts + [pts[0]], fill=stroke, width=int(1.1 * BOAT_S * SS), joint="curve")
        # 艇番(艇体の後ろ寄り)
        label = str(i + 1)
        lx, ly = to_px(14, 0)
        bb = d.textbbox((0, 0), label, font=num_font)
        d.text((lx - (bb[2] + bb[0]) / 2, ly - (bb[3] + bb[1]) / 2), label, font=num_font, fill=ink)

    small = layer.resize((W, lh // SS), Image.LANCZOS)
    card.alpha_composite(small, (0, top - 8))

    # スタートライン(破線)と、その名前
    d1 = ImageDraw.Draw(card)
    lx0, lx1 = x0 - 40, x0 + total + 40
    x = lx0
    while x < lx1:
        d1.line([(x, line_y), (min(x + 14, lx1), line_y)], fill=SUB, width=3)
        x += 24
    f = ImageFont.truetype(FONT_R, 22)
    d1.text((lx1 + 14, line_y - 14), "スタート", font=f, fill=SUB)


def make():
    img, d = base_card()
    card = img.convert("RGBA")
    d = ImageDraw.Draw(card)
    d.text((MARGIN, 72), "今日の一問", font=ImageFont.truetype(FONT_B, 96), fill=INK)
    d.text((MARGIN, 192), "過去の実レースで、読みの練習。", font=ImageFont.truetype(FONT_R, 40), fill=SUB)
    draw_boats(card)
    out = card.convert("RGB")
    brand_band(ImageDraw.Draw(out))
    return out


def main():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    img = make()
    img.save(OUT, "PNG", optimize=True)
    size = os.path.getsize(OUT)
    # 100KB を超えたら、色数を減らして作り直す(暗い地と6色なので、256色でも見た目はほぼ変わらない)
    if size > 100 * 1024:
        img.quantize(colors=256, method=Image.Quantize.MEDIANCUT).save(OUT, "PNG", optimize=True)
        size = os.path.getsize(OUT)
    print(f"[quiz-card] {OUT} {W}x{H} {size / 1024:.1f}KB")


if __name__ == "__main__":
    main()
