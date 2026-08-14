# -*- coding: utf-8 -*-
"""
アプリアイコンを作る手動ツール。

作るもの:
  icon-192.png / icon-512.png     … サイト(PWA)用。purpose="any"。全面デザイン
  icon-maskable-512.png           … PWA/Androidのアダプティブ用。purpose="maskable"
  store-assets/icon/play-icon-512.png … Playストア掲載用(512x512・全面・角丸なし)
  store-assets/icon/preview-*.png … 円/角丸/スクワークルで抜いた確認用プレビュー

【重要】make_og_image.pyと同じ理由でCI(daily.yml/results.yml)には組み込まない。
アイコンはデザインが変わらない限り再生成不要なため、手元で1回実行して
生成物をコミットする運用にする
(Pillow・日本語フォントをGitHub Actions側に追加する必要を避けるため)。

実行にはPillowが必要(pip install Pillow)。日本語フォントはローカル環境の
ものを使うため、パスは環境に合わせて書き換えること(下記はWindowsの例)。

【マスクの話(ここがこのファイルの肝)】
Androidのアダプティブアイコンは、端末やランチャーによって円・角丸・スクワークル
など違う形に抜かれる。どの形で抜かれても必ず残るのは、中央の直径66.7%の円
(セーフゾーン)だけ。ここからはみ出したものは「欠けるかもしれない」。
サイトのブランドである6色のレーン帯は、下端いっぱいに引くと円で抜かれた時に
1号艇(白)と6号艇(緑)の端が確実に切れる。そのためマスク版は、帯を短くして
セーフゾーンの円の内側に完全に収める。収まっているかは目視ではなく
assert_inside_safe_zone() で1ピクセルずつ機械的に確認している。
"""
import math
import os

from PIL import Image, ImageDraw, ImageFont

FONT_BOLD = "C:/Windows/Fonts/YuGothB.ttc"
WATER = "#0f2a33"
INK = "#eaf3f0"
# 公式の枠色。サイトのトップバーの.lanesと同じ並び(1号艇=白 … 6号艇=緑)
LANE_COLORS = ["#ffffff", "#2b2b2b", "#d83a36", "#2f6fd0", "#f2c200", "#1f9e54"]
SITE_SIZES = [192, 512]

STORE_DIR = os.path.join("store-assets", "icon")

# アダプティブアイコンのセーフゾーン。108dp中72dpが必ず見える仕様なので 72/108。
SAFE_RATIO = 72 / 108


def ink_box(font, text):
    """文字の実際のインク範囲(余白を除いた矩形)を返す。
    textbboxはフォントのメトリクス由来の余白を含むことがあり、それを信じると
    アイコンの中で文字が微妙に上下にずれる。実際に描いて測るのが確実。"""
    pad = 40
    probe = Image.new("L", (font.size * 2 + pad * 2, font.size * 2 + pad * 2), 0)
    ImageDraw.Draw(probe).text((pad, pad), text, font=font, fill=255)
    return probe.getbbox()   # (x0, y0, x1, y1)


def draw_glyph(draw, font, text, cx, cy, fill):
    """文字のインク中心が (cx, cy) に来るように描く。返り値はインクの矩形。"""
    x0, y0, x1, y1 = ink_box(font, text)
    pad = 40
    w, h = x1 - x0, y1 - y0
    tx = cx - w / 2 - (x0 - pad)
    ty = cy - h / 2 - (y0 - pad)
    draw.text((tx, ty), text, font=font, fill=fill)
    return (cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2)


def lane_bar(draw, x0, y0, x1, y1, radius=None):
    """6色のレーン帯。radiusを渡すと両端を丸める(帯単体で図形として成立させる)。"""
    w = (x1 - x0) / len(LANE_COLORS)
    if radius is None:
        for i, c in enumerate(LANE_COLORS):
            draw.rectangle([x0 + i * w, y0, x0 + (i + 1) * w, y1], fill=c)
        return
    # 角丸は「帯の形のマスクを作って、6色の縞をその形で抜く」やり方で作る。
    # 端の1色だけを角丸にすると色の境目がずれるため。
    mask = Image.new("L", (round(x1 - x0), round(y1 - y0)), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, mask.width - 1, mask.height - 1],
                                           radius=radius, fill=255)
    stripes = Image.new("RGBA", mask.size)
    sd = ImageDraw.Draw(stripes)
    sw = mask.width / len(LANE_COLORS)
    for i, c in enumerate(LANE_COLORS):
        sd.rectangle([i * sw, 0, (i + 1) * sw, mask.height], fill=c)
    stripes.putalpha(mask)
    draw._image.paste(stripes, (round(x0), round(y0)), stripes)


def assert_inside_safe_zone(img, label):
    """背景色でないピクセルが、すべてセーフゾーンの円の内側にあることを確かめる。
    1ピクセルでも外に出ていたらその場で止める(気付かずに欠けたアイコンを
    ストアに出すのが、この一連の作業でいちばん取り返しがつかないため)。"""
    size = img.width
    bg = img.convert("RGB").getpixel((2, 2))
    cx = cy = size / 2
    r = size * SAFE_RATIO / 2
    px = img.convert("RGB").load()
    worst = 0.0
    for y in range(size):
        for x in range(size):
            if px[x, y] == bg:
                continue
            d = math.hypot(x + 0.5 - cx, y + 0.5 - cy)
            worst = max(worst, d)
    if worst > r:
        raise SystemExit(f"[abort] {label}: 中身がセーフゾーンから {worst - r:.1f}px はみ出しています "
                         f"(許容半径 {r:.1f}px / 実測 {worst:.1f}px)")
    print(f"       セーフゾーン確認 OK … 中身の最遠点 {worst:.1f}px / 許容 {r:.1f}px "
          f"(余裕 {r - worst:.1f}px)")


def make_site_icon(size):
    """サイト(PWA)用。これまでどおり下端いっぱいに帯を引く全面デザイン。"""
    img = Image.new("RGB", (size, size), color=WATER)
    draw = ImageDraw.Draw(img)
    stripe_h = max(2, round(size * 0.035))
    lane_bar(draw, 0, size - stripe_h, size, size)
    font = ImageFont.truetype(FONT_BOLD, round(size * 0.52))
    draw_glyph(draw, font, "艇", size / 2, (size - stripe_h) / 2, INK)
    fname = f"icon-{size}.png"
    img.save(fname, "PNG", optimize=True)
    print(f"[done] {fname} ({size}x{size}) サイト/PWA用")


def make_maskable(size=512, path="icon-maskable-512.png", label="マスク用"):
    """アダプティブ(maskable)用。「艇」と6色帯をセーフゾーンの円に収める。"""
    img = Image.new("RGB", (size, size), color=WATER)
    draw = ImageDraw.Draw(img)
    r = size * SAFE_RATIO / 2          # セーフゾーンの半径
    cx = cy = size / 2

    # 帯は円の下寄りに置く。円の内側に収まる最大の幅を三平方の定理で出し、
    # そこから少し余裕(0.86)を引いた幅にする。
    bar_h = round(size * 0.052)
    bar_bottom = cy + r * 0.72
    bar_top = bar_bottom - bar_h
    # 円からのはみ出しは「帯の下の角」で決まるので、下辺の高さで幅を決める
    half = math.sqrt(max(r * r - (bar_bottom - cy) ** 2, 0)) * 0.86
    lane_bar(draw, cx - half, bar_top, cx + half, bar_bottom, radius=bar_h / 2)

    # 「艇」は帯の上の空きに置く。円の上側に収まる大きさを探して決める。
    gap = size * 0.045
    box_bottom = bar_top - gap
    fs = round(size * 0.40)
    while fs > 10:
        font = ImageFont.truetype(FONT_BOLD, fs)
        x0, y0, x1, y1 = ink_box(font, "艇")
        gw, gh = x1 - x0, y1 - y0
        gcy = box_bottom - gh / 2
        # 文字の4隅がすべて円の内側に入るか
        corners = [(cx - gw / 2, gcy - gh / 2), (cx + gw / 2, gcy - gh / 2),
                   (cx - gw / 2, gcy + gh / 2), (cx + gw / 2, gcy + gh / 2)]
        if all(math.hypot(px - cx, py - cy) <= r for px, py in corners):
            break
        fs -= 2
    draw_glyph(draw, ImageFont.truetype(FONT_BOLD, fs), "艇", cx, gcy, INK)

    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    img.save(path, "PNG", optimize=True)
    print(f"[done] {path} ({size}x{size}) {label} / 「艇」{fs}px")
    assert_inside_safe_zone(img, path)
    return img


def make_store_icon(size=512):
    """Playストア掲載用。透過なし・角丸なしの全面画像。
    ただしストア側で角が丸められて表示されるので、中身は角に置かない
    (背景は全面なので「角丸なし・全面」の要件は満たしている)。"""
    img = Image.new("RGB", (size, size), color=WATER)
    draw = ImageDraw.Draw(img)
    bar_h = round(size * 0.055)
    half = size * 0.30
    bar_bottom = size * 0.795
    lane_bar(draw, size / 2 - half, bar_bottom - bar_h, size / 2 + half, bar_bottom,
             radius=bar_h / 2)
    font = ImageFont.truetype(FONT_BOLD, round(size * 0.46))
    draw_glyph(draw, font, "艇", size / 2, (bar_bottom - bar_h) / 2 + size * 0.035, INK)
    path = os.path.join(STORE_DIR, "play-icon-512.png")
    os.makedirs(STORE_DIR, exist_ok=True)
    img.save(path, "PNG", optimize=True)
    print(f"[done] {path} ({size}x{size}) ストア掲載用")
    return img


def mask_preview(src, kind, out_size=512):
    """円・角丸・スクワークルで抜いたプレビュー。
    抜いた外側は市松模様にして、「どこまでが残るか」が一目で分かるようにする。"""
    size = src.width
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    if kind == "circle":
        d.ellipse([0, 0, size - 1, size - 1], fill=255)
    elif kind == "rounded":
        d.rounded_rectangle([0, 0, size - 1, size - 1], radius=round(size * 0.22), fill=255)
    else:   # squircle(スーパー楕円 n=4)。iOS/一部Androidランチャーのあの形
        n, cx, r = 4, size / 2, size / 2
        px = mask.load()
        for y in range(size):
            for x in range(size):
                if (abs(x + 0.5 - cx) / r) ** n + (abs(y + 0.5 - cx) / r) ** n <= 1:
                    px[x, y] = 255

    # 市松の下地(抜けた部分がひと目で分かる)
    bg = Image.new("RGB", (size, size), "#ffffff")
    bd = ImageDraw.Draw(bg)
    cell = size // 16
    for gy in range(0, size, cell):
        for gx in range(0, size, cell):
            if (gx // cell + gy // cell) % 2:
                bd.rectangle([gx, gy, gx + cell, gy + cell], fill="#dcdcdc")
    out = bg.copy()
    out.paste(src.convert("RGB"), (0, 0), mask)

    # セーフゾーンの円を薄く重ねて、基準線が見えるようにする
    ov = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    r = size * SAFE_RATIO / 2
    ImageDraw.Draw(ov).ellipse([size / 2 - r, size / 2 - r, size / 2 + r, size / 2 + r],
                               outline=(255, 90, 90, 170), width=max(2, size // 200))
    out = Image.alpha_composite(out.convert("RGBA"), ov).convert("RGB")

    path = os.path.join(STORE_DIR, f"preview-{kind}.png")
    out.save(path, "PNG", optimize=True)
    print(f"[done] {path} ({kind}マスク・赤線=セーフゾーン)")


def main():
    for s in SITE_SIZES:
        make_site_icon(s)
    masked = make_maskable()
    make_store_icon()
    for kind in ("circle", "rounded", "squircle"):
        mask_preview(masked, kind)


if __name__ == "__main__":
    main()
