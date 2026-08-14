# -*- coding: utf-8 -*-
"""
Google Playのストア掲載素材(フィーチャーグラフィックとスクリーンショット)を作る手動ツール。

作るもの:
  store-assets/feature/feature-graphic-1024x500.png
  store-assets/screenshots/{light,dark}/NN-*.png            … 素撮り 1080x2400
  store-assets/screenshots/{light,dark}/captioned/NN-*.png  … 上部に説明帯を足した版

【CIには組み込まない】make_app_icons.py と同じ運用。ストア素材は審査のたびに
作り直すものではないので、手元で実行して生成物をコミットする。
Playwright(ヘッドレスChromium)と日本語フォントが要るため、CIに入れると
毎晩のワークフローが重くなるだけで得がない。

準備:
  pip install playwright pillow
  python -m playwright install chromium

撮影は本番URL(https://teiyomi.com)から行う。ログインが要る画面(マイページ等)は
撮らない — 審査用の画像に個人のアカウント情報が写り込むのを避けるため。

テーマは theme.js と同じ仕組みで切り替える:
  localStorage の teiyomi_theme に "light"/"dark" を入れてから読み込ませる。
端末設定(prefers-color-scheme)も同じ側に寄せておき、取りこぼしを防ぐ。
"""
import os
import time

from PIL import Image, ImageDraw, ImageFont

BASE = "https://teiyomi.com"
OUT_ROOT = "store-assets"
FEATURE_DIR = os.path.join(OUT_ROOT, "feature")
SHOT_DIR = os.path.join(OUT_ROOT, "screenshots")

FONT_BOLD = "C:/Windows/Fonts/YuGothB.ttc"
FONT_REG = "C:/Windows/Fonts/YuGothR.ttc"

LANE_COLORS = ["#ffffff", "#2b2b2b", "#d83a36", "#2f6fd0", "#f2c200", "#1f9e54"]

# theme.css のトークンから。帯は両テーマとも濃紺(--water)にして、
# ライト/ダークどちらの並びでも同じブランドの帯に見えるようにする。
TOKENS = {
    "light": {"water": "#0f2a33", "on_water": "#eaf3f0", "on_water_sub": "#9fc3ba"},
    "dark":  {"water": "#0a1114", "on_water": "#eaf3f0", "on_water_sub": "#9fc3ba"},
}

# 1080x2400(Playの推奨)。CSS 360x800 を3倍で撮る=実機の見え方に一致する。
SHOT_W, SHOT_H = 1080, 2400
DSF = 3
CSS_W = SHOT_W // DSF          # 360
CAPTION_H = 240                # 帯の高さ(実ピクセル)。CSS換算80px

# 撮る画面。captionは帯に載せる一文。
PAGES = [
    {"slug": "01-top", "url": f"{BASE}/", "caption": "毎朝、今日のレースがわかる"},
    # ↑トップの「開発中のお知らせ」は一度閉じると出なくなる作りなので、
    #   閉じた状態(=常連の見え方)で撮る。詳細は init_script の DEVNOTICE を参照
    # 殿堂は冒頭の説明文が長い。名簿が写らないと何のページか伝わらないので、
    # 1つ目の称号カードが画面の頭に来るところまで送ってから撮る。
    {"slug": "02-titles", "url": f"{BASE}/titles.html", "caption": "55万レースが生んだ、16の称号",
     "scroll": ("#hall", 24)},
    {"slug": "03-kyusoku", "url": f"{BASE}/kyusoku.html", "caption": "B級選手の昇級レースを毎日追う"},
    {"slug": "04-backtest", "url": f"{BASE}/backtest-custom.html?toban=4218",
     "caption": "自分の条件で、過去10年を検証", "action": "backtest"},
    {"slug": "05-player", "url": f"{BASE}/players/3721.html",
     "caption": "選手の知られざる強みに、名前がつく"},
]


# ---------------------------------------------------------------- 共通の描画

def fit_font(path, text, max_w, start, min_size=12):
    """max_wに収まる最大の文字サイズを返す。文言を変えても勝手に収まるようにする
    (固定サイズにすると、後で一文字増やしたときに黙ってはみ出す)。"""
    size = start
    while size > min_size:
        f = ImageFont.truetype(path, size)
        if f.getbbox(text)[2] - f.getbbox(text)[0] <= max_w:
            return f
        size -= 2
    return ImageFont.truetype(path, min_size)


def draw_centered(draw, text, font, cx, cy, fill):
    x0, y0, x1, y1 = draw.textbbox((0, 0), text, font=font)
    draw.text((cx - (x1 - x0) / 2 - x0, cy - (y1 - y0) / 2 - y0), text, font=font, fill=fill)


def water_texture(draw, w, h, step, color):
    """サイトのヘッダー(.topbar::after)と同じ、細い横線の水面テクスチャ。"""
    for y in range(0, h, step):
        draw.line([(0, y), (w, y)], fill=color, width=1)


def lane_bar(img, x0, y0, w, h, radius=None):
    mask = Image.new("L", (round(w), round(h)), 255)
    if radius:
        mask = Image.new("L", (round(w), round(h)), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, mask.width - 1, mask.height - 1],
                                               radius=radius, fill=255)
    stripes = Image.new("RGBA", mask.size)
    d = ImageDraw.Draw(stripes)
    sw = mask.width / len(LANE_COLORS)
    for i, c in enumerate(LANE_COLORS):
        d.rectangle([i * sw, 0, (i + 1) * sw, mask.height], fill=c)
    stripes.putalpha(mask)
    img.paste(stripes, (round(x0), round(y0)), stripes)


# ------------------------------------------------- フィーチャーグラフィック

def make_feature():
    """1024x500。ストアの一覧で最初に目に入る一枚。
    Playは面によって左右を切ることがあるので、文字は中央寄りに置く。"""
    W, H = 1024, 500
    img = Image.new("RGB", (W, H), TOKENS["light"]["water"])
    d = ImageDraw.Draw(img)
    water_texture(d, W, H, 18, "#14333d")

    ink = TOKENS["light"]["on_water"]
    sub = TOKENS["light"]["on_water_sub"]

    MARGIN = 76
    DIV_X = 430              # 左(ロゴ)と右(コピー)の境目
    RIGHT_X = DIV_X + 62
    RIGHT_W = W - MARGIN - RIGHT_X
    MID = (H - 96) / 2 + 18  # 下の一行ぶんを除いた見た目の中心(+18は目の錯覚ぶんの補正)

    # 左: ロゴ「艇読み」+ レーン帯 + ドメイン
    logo = fit_font(FONT_BOLD, "艇読み", DIV_X - MARGIN - 48, 104)
    lw = logo.getbbox("艇読み")[2] - logo.getbbox("艇読み")[0]
    lx = MARGIN + 24
    draw_centered(d, "艇読み", logo, lx + lw / 2, MID - 30, ink)
    lane_bar(img, lx, MID + 34, lw, 16, radius=8)
    dom = ImageFont.truetype(FONT_REG, 24)
    draw_centered(d, "teiyomi.com", dom, lx + lw / 2, MID + 82, sub)

    d.line([(DIV_X, MID - 120), (DIV_X, MID + 120)], fill="#1d4450", width=2)

    # 右: キャッチと、その補足
    catch = "データで、レースを読む。"
    cf = fit_font(FONT_BOLD, catch, RIGHT_W, 56)
    d.text((RIGHT_X, MID - 62), catch, font=cf, fill=ink)
    sub1 = "予想印は出しません。"
    sub2 = "数字と、その検証だけを置きます。"
    sf = fit_font(FONT_REG, sub2, RIGHT_W, 27)
    d.text((RIGHT_X, MID + 12), sub1, font=sf, fill=sub)
    d.text((RIGHT_X, MID + 50), sub2, font=sf, fill=sub)

    # 下: 中身の裏づけ
    foot = "過去10年・55万レースの公式データ ／ 会場のクセ・選手の二つ名・バックテスト"
    ff = fit_font(FONT_REG, foot, W - MARGIN * 2, 24)
    draw_centered(d, foot, ff, W / 2, H - 52, sub)

    os.makedirs(FEATURE_DIR, exist_ok=True)
    path = os.path.join(FEATURE_DIR, "feature-graphic-1024x500.png")
    img.save(path, "PNG", optimize=True)
    print(f"[done] {path} (1024x500)")


# ------------------------------------------------------ スクリーンショット

def caption_band(theme, text):
    """スクリーンショットの上に足す説明帯。"""
    t = TOKENS[theme]
    band = Image.new("RGB", (SHOT_W, CAPTION_H), t["water"])
    d = ImageDraw.Draw(band)
    water_texture(d, SHOT_W, CAPTION_H, 54,
                  "#14333d" if theme == "light" else "#101c21")
    f = fit_font(FONT_BOLD, text, SHOT_W - 120, 62)
    draw_centered(d, text, f, SHOT_W / 2, CAPTION_H / 2 - 16, t["on_water"])
    lane_bar(band, SHOT_W / 2 - 90, CAPTION_H - 52, 180, 10, radius=5)
    # 帯とページの境目。サイトのヘッダーも同じ濃紺なので、線を1本入れないと
    # 2つの濃紺が地続きに見えて、どこからがアプリの画面か分からなくなる。
    d.rectangle([0, CAPTION_H - 6, SHOT_W, CAPTION_H], fill=t["on_water_sub"])
    return band


def compose_caption(shot_path, out_path, theme, text):
    """帯(240px) + 本文(2160px) = 1080x2400。本文側を切らずに縮めるのではなく、
    最初から本文を2160pxで撮っておき、上に帯を足す。"""
    body = Image.open(shot_path).convert("RGB")
    out = Image.new("RGB", (SHOT_W, SHOT_H))
    out.paste(caption_band(theme, text), (0, 0))
    out.paste(body, (0, CAPTION_H))
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    out.save(out_path, "PNG", optimize=True)


def run_backtest(page):
    """④用。お試し選手で検証を1回実行し、結果が出た状態にする。"""
    page.wait_for_selector("#playerPicked", state="visible", timeout=30000)
    for sel, label in (("#periodRow", "過去1年"), ("#betRow", "単勝")):
        page.click(f'{sel} >> text="{label}"')
    page.wait_for_selector("#runBtn:not([disabled])", timeout=30000)
    page.click("#runBtn")
    # 集計はブラウザ側で走るので、数字が入るまで待つ(「―」のままだと未完了)
    page.wait_for_selector("#resultArea", state="visible", timeout=180000)
    page.wait_for_function(
        "() => { const e = document.querySelector('#rReturn');"
        " return e && e.textContent.trim() !== '―'; }", timeout=180000)
    # 「条件を決めて → 検証する → 結果が出る」が1枚で伝わる位置に寄せる。
    # 検証ボタンを画面の上から1/4あたりに置くと、上に条件欄・下に結果の4枚が入り、
    # その下のプレミアム案内は画面の外に出る。
    page.evaluate("() => { const r = document.querySelector('#runBtn')"
                  ".getBoundingClientRect(); window.scrollBy(0, r.top - 260); }")
    page.wait_for_timeout(1500)


def shoot(pw, theme, height, out_dir):
    """1テーマぶん撮る。heightは撮る高さ(実ピクセル)。"""
    t0 = time.time()
    browser = pw.chromium.launch()
    ctx = browser.new_context(
        viewport={"width": CSS_W, "height": height // DSF},
        device_scale_factor=DSF,
        color_scheme=theme,
        locale="ja-JP",
        user_agent=("Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36"),
    )
    # theme.js は localStorage の保存値を端末設定より優先する。両方揃えておく。
    # あわせてトップの「開発中のお知らせ」を閉じた状態にする。あれは一度×を押せば
    # 二度と出ないもので、初回訪問だけの表示。ストアの画像は日常の見え方を写す。
    ctx.add_init_script(
        f'try{{localStorage.setItem("teiyomi_theme","{theme}");'
        f'localStorage.setItem("teiyomi_devnotice_dismissed_v1","1");}}catch(e){{}}')
    out = []
    for p in PAGES:
        page = ctx.new_page()
        page.goto(p["url"], wait_until="networkidle", timeout=90000)
        if p.get("action") == "backtest":
            run_backtest(page)
        if p.get("scroll"):
            sel, top = p["scroll"]
            page.wait_for_selector(sel, timeout=30000)
            page.evaluate("([s, t]) => { const r = document.querySelector(s)"
                          ".getBoundingClientRect(); window.scrollBy(0, r.top - t); }",
                          [sel, top])
        page.wait_for_timeout(1500)
        os.makedirs(out_dir, exist_ok=True)
        path = os.path.join(out_dir, f"{p['slug']}.png")
        page.screenshot(path=path)
        page.close()
        out.append((p, path))
    ctx.close()
    browser.close()
    print(f"[done] {out_dir} {len(out)}枚 ({time.time() - t0:.0f}秒)")
    return out


def make_screenshots():
    from playwright.sync_api import sync_playwright
    tmp = os.path.join(OUT_ROOT, "_body")   # 帯つきの本文だけを置く作業用
    with sync_playwright() as pw:
        for theme in ("light", "dark"):
            # 素撮り: そのまま1080x2400
            shoot(pw, theme, SHOT_H, os.path.join(SHOT_DIR, theme))
            # 帯つき: 本文を2160pxで撮り、上に240pxの帯を足して2400にする
            for p, path in shoot(pw, theme, SHOT_H - CAPTION_H, os.path.join(tmp, theme)):
                out = os.path.join(SHOT_DIR, theme, "captioned", f"{p['slug']}.png")
                compose_caption(path, out, theme, p["caption"])
                print(f"       {theme}/captioned/{p['slug']}.png")
    # 作業用は残さない(ストア素材のディレクトリに中間物を置かない)
    for theme in ("light", "dark"):
        d = os.path.join(tmp, theme)
        for f in os.listdir(d) if os.path.isdir(d) else []:
            os.remove(os.path.join(d, f))
        if os.path.isdir(d):
            os.rmdir(d)
    if os.path.isdir(tmp):
        os.rmdir(tmp)


def main():
    make_feature()
    make_screenshots()


if __name__ == "__main__":
    main()
