# -*- coding: utf-8 -*-
"""
ホーム画面追加(PWAインストール)用のアプリアイコンを作る手動ツール。

【重要】make_og_image.pyと同じ理由でCI(daily.yml/results.yml)には組み込まない。
アイコンはデザインが変わらない限り再生成不要なため、手元で1回実行して
icon-192.png/icon-512.pngをコミットする運用にする
(Pillow・日本語フォントをGitHub Actions側に追加する必要を避けるため)。

実行にはPillowが必要(pip install Pillow)。日本語フォントはローカル環境の
ものを使うため、パスは環境に合わせて書き換えること(下記はWindowsの例)。
"""
from PIL import Image, ImageDraw, ImageFont

FONT_BOLD = "C:/Windows/Fonts/YuGothB.ttc"
WATER = "#0f2a33"
INK = "#eaf3f0"
LANE_COLORS = ["#ffffff", "#2b2b2b", "#d83a36", "#2f6fd0", "#f2c200", "#1f9e54"]
SIZES = [192, 512]


def make_icon(size):
    img = Image.new("RGB", (size, size), color=WATER)
    draw = ImageDraw.Draw(img)

    # 下端に6色のレーン帯(トップバーの.lanesと同じ配色)を細く入れ、サイトのブランドと揃える
    stripe_h = max(2, round(size * 0.035))
    stripe_w = size / len(LANE_COLORS)
    for i, c in enumerate(LANE_COLORS):
        x0 = i * stripe_w
        draw.rectangle([x0, size - stripe_h, x0 + stripe_w, size], fill=c)

    # 中央に「艇」を白抜き(アイコンは極小表示されるため、2文字以上の文字は避ける)
    font = ImageFont.truetype(FONT_BOLD, round(size * 0.52))
    text = "艇"
    bbox = draw.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    tx = (size - tw) / 2 - bbox[0]
    ty = (size - stripe_h - th) / 2 - bbox[1]
    draw.text((tx, ty), text, font=font, fill=INK)

    fname = f"icon-{size}.png"
    img.save(fname, "PNG", optimize=True)
    print(f"[done] {fname} ({size}x{size})")


def main():
    for s in SIZES:
        make_icon(s)


if __name__ == "__main__":
    main()
