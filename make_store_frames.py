# -*- coding: utf-8 -*-
"""
ストア掲載用の「フレーム入り」スクリーンショットを作る手動ツール。

Claude Designが作った枠(store-assets/screenshots/store/store_NN_*.png)には、
少し傾いた端末の画面部分がプレースホルダとして空けてある。そこに本番サイトの
実スクリーンショットをはめ込む。

作るもの:
  store-assets/store-final/NN-*.png        合成済み 1080x2400
  store-assets/store-final/9x16/NN-*.png   同上を9:16に収めた版(左右に地の色を足す)
  store-assets/store-final/thumb/NN-*.png  幅320pxの縮小版(ストア一覧での見え方確認用)

準備:
  pip install playwright pillow opencv-python numpy
  python -m playwright install chromium

【はめ込みの考え方】
プレースホルダの位置は目分量で決めない。枠のPNGから
「暗くて青緑に寄っていない大きな塊」を色で拾い、その最小外接矩形を求める。
角が丸いので、貼り付けのマスクには矩形ではなく拾った塊そのものを使う
(そうしないと角が四角く飛び出す)。全8枚が同じテンプレでも、1枚ずつ測って
1枚ずつ貼る。手で座標を書き写すと、枠を作り直したときに黙ってずれるため。

【撮影サイズ】
プレースホルダの縦横比は9:20のスマホとは少し違う。実機どおりの見た目のまま
歪ませずに入れるため、撮影時のビューポートをプレースホルダの比率に合わせる
(CSS幅390pxに固定し、端末解像度倍率のほうで縦横比を合わせる)。
"""
import os

import cv2
import numpy as np
from PIL import Image

FRAME_DIR = os.path.join("store-assets", "screenshots", "store")
OUT_DIR = os.path.join("store-assets", "store-final")
BASE = "https://teiyomi.com"

CSS_W = 390          # 撮影時のCSS幅。今どきのスマホの実寸に合わせる
OUT_W, OUT_H = 1080, 2400
THUMB_W = 320

# 枠のファイル名 -> 何を撮るか
SHOTS = [
    {"frame": "store_01_top.png", "slug": "01-top", "url": f"{BASE}/"},
    {"frame": "store_02_backtest.png", "slug": "02-backtest",
     "url": f"{BASE}/backtest-custom.html?toban=4218", "action": "backtest"},
    {"frame": "store_03_period.png", "slug": "03-period",
     "url": f"{BASE}/backtest-custom.html?toban=4218", "action": "period"},
    {"frame": "store_04_names.png", "slug": "04-names",
     "url": f"{BASE}/titles.html", "scroll": ("#hall", 16)},
    {"frame": "store_05_guardian.png", "slug": "05-guardian",
     "url": f"{BASE}/titles.html", "scroll": ("#hall > section:nth-last-child(2)", 16)},
    {"frame": "store_06_promotion.png", "slug": "06-promotion",
     "url": f"{BASE}/kyusoku.html", "scroll": ("#leadBox", 16)},
    {"frame": "store_07_racer.png", "slug": "07-racer", "url": f"{BASE}/players/4320.html"},
    {"frame": "store_08_notify.png", "slug": "08-notify",
     "url": f"{BASE}/titles.html", "action": "bell"},
]


# ------------------------------------------------ プレースホルダを測る

def rough_mask(frame_path):
    """色でプレースホルダらしき塊を拾う。ふちはギザつくので、あくまで下ごしらえ。
    地は濃紺(緑成分が赤成分よりだいぶ大きい)、影は緑、プレースホルダだけが暗い無彩色。
    ただし地との差は小さい(プレースホルダ g-r=12 / 地 g-r=17)ので、この時点の
    輪郭をそのまま貼り付けマスクに使ってはいけない。"""
    bgr = cv2.imread(frame_path)
    b, g, r = (bgr[:, :, i].astype(int) for i in range(3))
    m = (((g - r) < 15) & (r < 70) & (r > 5)).astype(np.uint8) * 255
    # プレースホルダ内の説明文字(top screen 等)で穴が空くので埋める
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((25, 25), np.uint8))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m, 8)
    i = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    return ((lab == i).astype(np.uint8)) * 255


def rounded_mask(w, h, radius, ss=4):
    """角丸長方形のマスク。4倍で描いてから縮めて、ふちを滑らかにする。"""
    big = np.zeros((h * ss, w * ss), np.uint8)
    cv2.rectangle(big, (0, radius * ss), (w * ss - 1, h * ss - 1 - radius * ss), 255, -1)
    cv2.rectangle(big, (radius * ss, 0), (w * ss - 1 - radius * ss, h * ss - 1), 255, -1)
    for cx, cy in ((radius, radius), (w - 1 - radius, radius),
                   (radius, h - 1 - radius), (w - 1 - radius, h - 1 - radius)):
        cv2.circle(big, (cx * ss, cy * ss), radius * ss, 255, -1)
    return cv2.resize(big, (w, h), interpolation=cv2.INTER_AREA)


def find_slot(frame_path):
    """端末の画面プレースホルダを測り、貼り付け先の四隅ときれいなマスクを返す。

    色で拾っただけの輪郭は、地との色差が小さいうえに斜めストライプの模様が
    のっているせいでふちがギザつく。そのまま貼ると端末の右辺に櫛状のノイズが出る。
    そこで、いったん傾きを戻した平面で「行ごとの端の中央値」という頑健な値から
    本当の長方形を割り出し、そこに角丸長方形を描き直したものをマスクにする。

    返り値: (四隅[4,2](左上→右上→右下→左下), マスク(uint8), 幅, 高さ, 角丸半径)
    """
    rough = rough_mask(frame_path)
    cs, _ = cv2.findContours(rough, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    q0 = order_corners(cv2.boxPoints(cv2.minAreaRect(max(cs, key=cv2.contourArea))))
    w0, h0 = (round(v) for v in slot_size(q0))
    flat_q = np.array([[0, 0], [w0 - 1, 0], [w0 - 1, h0 - 1], [0, h0 - 1]], np.float32)
    flat = cv2.warpPerspective(rough, cv2.getPerspectiveTransform(q0, flat_q),
                               (w0, h0)) > 127

    def edges(arr2d, n):
        first = np.array([np.argmax(a) if a.any() else -1 for a in arr2d])
        last = np.array([n - 1 - np.argmax(a[::-1]) if a.any() else -1 for a in arr2d])
        ok = first >= 0
        return int(np.median(first[ok])), int(np.median(last[ok]))

    left, right = edges(flat, w0)                 # 行ごとの左右端の中央値
    top, bottom = edges(flat.T, h0)               # 列ごとの上下端の中央値
    w, h = right - left + 1, bottom - top + 1
    # 角丸の半径は面積から逆算する: 欠ける面積 = (4-π)r^2
    lost = max(w * h - int(flat[top:bottom + 1, left:right + 1].sum()), 0)
    radius = int(round(np.sqrt(lost / (4 - np.pi)))) if lost else 0
    radius = max(0, min(radius, min(w, h) // 2))

    # 平面で決めた長方形を、元の傾いた座標系に戻す
    inv = cv2.getPerspectiveTransform(flat_q, q0)
    rect = np.array([[[left, top], [right, top], [right, bottom], [left, bottom]]], np.float32)
    corners = cv2.perspectiveTransform(rect, inv)[0]
    src = np.array([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]], np.float32)
    frame_h, frame_w = rough.shape[:2]
    mask = cv2.warpPerspective(rounded_mask(w, h, radius),
                               cv2.getPerspectiveTransform(src, corners),
                               (frame_w, frame_h), flags=cv2.INTER_LINEAR)
    return corners.astype(np.float32), mask, (w, h), radius


def order_corners(box):
    """四隅を 左上・右上・右下・左下 の順に並べ替える。"""
    box = np.array(box, dtype=np.float32)
    s, d = box.sum(1), np.diff(box, axis=1).ravel()
    return np.array([box[np.argmin(s)], box[np.argmin(d)],
                     box[np.argmax(s)], box[np.argmax(d)]], dtype=np.float32)


def slot_size(corners):
    """傾きを戻したときの画面の実寸(幅・高さ)。"""
    tl, tr, br, bl = corners
    w = (np.linalg.norm(tr - tl) + np.linalg.norm(br - bl)) / 2
    h = (np.linalg.norm(bl - tl) + np.linalg.norm(br - tr)) / 2
    return w, h


# ------------------------------------------------------------ 撮影

def run_backtest(page):
    page.wait_for_selector("#playerPicked", state="visible", timeout=30000)
    for sel, label in (("#periodRow", "過去1年"), ("#betRow", "単勝")):
        page.click(f'{sel} >> text="{label}"')
    page.wait_for_selector("#runBtn:not([disabled])", timeout=30000)
    page.click("#runBtn")
    page.wait_for_selector("#resultArea", state="visible", timeout=180000)
    page.wait_for_function("() => { const e = document.querySelector('#rReturn');"
                           " return e && e.textContent.trim() !== '―'; }", timeout=180000)
    page.evaluate("() => { const r = document.querySelector('#runBtn')"
                  ".getBoundingClientRect(); window.scrollBy(0, r.top - 90); }")


def set_period(page):
    """カスタム期間(年月〜年月)を指定した状態にする。"""
    page.wait_for_selector("#cpFromY", timeout=30000)
    # 月は2桁ゼロ埋め("01"〜"12")で、しかも年を変えると選べる月が作り直される。
    # 年→月の順に、1つずつ間を置いて選ぶこと。
    for sel, val in (("#cpFromY", "2024"), ("#cpFromM", "01"),
                     ("#cpToY", "2026"), ("#cpToM", "08")):
        page.select_option(sel, value=val)
        page.wait_for_timeout(400)
    page.evaluate("() => { const r = document.querySelector('#stepPeriod')"
                  ".getBoundingClientRect(); window.scrollBy(0, r.top - 12); }")


def open_bell(page):
    """殿堂の🔔を押して、登録の確認ダイアログが出た状態にする。
    絞り込み通知はプレミアム限定のため、未ログインだと案内が出て確認が見られない。
    ここでは会員判定だけを差し替えて、有料会員が見る本来の画面を出す
    (中の文言・選手名・会場はすべて実データと実コードから出ている。
     保存は押さないので、通知条件は1件も作られない)。"""
    # 会場の称号(いちばん下の「〇〇の守護神」)の🔔を押す。会場つきの条件になるので、
    # 「〇〇選手が〇〇で走る日に通知します」という、この機能がいちばん伝わる文面が出る。
    sel = "#hall > section:last-child .bell-btn"
    page.wait_for_selector(sel, timeout=30000)
    page.eval_on_selector(sel, "e => e.scrollIntoView({block:'center'})")
    page.click(sel)
    page.wait_for_selector(".bell-pop .bell-save", timeout=30000)
    page.wait_for_timeout(600)


def shoot_all(shot_w, shot_h):
    """全カットを撮る。返り値: slug -> PIL.Image"""
    from playwright.sync_api import sync_playwright
    dsf = shot_w / CSS_W
    css_h = round(shot_h / dsf)
    out = {}
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        ctx = browser.new_context(
            viewport={"width": CSS_W, "height": css_h},
            device_scale_factor=dsf,
            color_scheme="light",
            locale="ja-JP",
            user_agent=("Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 "
                        "(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36"),
        )
        # テーマは端末設定に頼らず、トグルの保存値でライトを明示する。
        # トップの「開発中のお知らせ」は一度閉じれば出ない初回だけの表示なので閉じておく。
        ctx.add_init_script(
            'try{localStorage.setItem("teiyomi_theme","light");'
            'localStorage.setItem("teiyomi_devnotice_dismissed_v1","1");}catch(e){}')
        # 🔔の確認画面を出すための会員判定の差し替え(08だけで使う)
        ctx.add_init_script(
            'window.__teiyomiProPreview = function(){'
            ' window.TeiyomiMembership = {load:function(){'
            '   return Promise.resolve({active:true, plan:"pro"});}};};')
        for s in SHOTS:
            page = ctx.new_page()
            if s.get("action") == "bell":
                page.add_init_script("window.addEventListener('DOMContentLoaded',"
                                     "function(){ if(window.__teiyomiProPreview)"
                                     " window.__teiyomiProPreview(); });")
            page.goto(s["url"], wait_until="networkidle", timeout=90000)
            if s.get("action") == "backtest":
                run_backtest(page)
            elif s.get("action") == "period":
                set_period(page)
            elif s.get("action") == "bell":
                page.evaluate("() => window.__teiyomiProPreview && window.__teiyomiProPreview()")
                open_bell(page)
            if s.get("scroll"):
                sel, top = s["scroll"]
                page.wait_for_selector(sel, timeout=30000)
                page.evaluate("([s,t]) => { const r = document.querySelector(s)"
                              ".getBoundingClientRect(); window.scrollBy(0, r.top - t); }",
                              [sel, top])
            page.wait_for_timeout(1500)
            buf = page.screenshot()
            page.close()
            im = Image.open(__import__("io").BytesIO(buf)).convert("RGB")
            if im.size != (shot_w, shot_h):
                im = im.resize((shot_w, shot_h), Image.LANCZOS)
            out[s["slug"]] = im
            print(f"       撮影 {s['slug']} ({im.width}x{im.height})")
        ctx.close()
        browser.close()
    return out


# ------------------------------------------------------------ 合成

def compose(frame_path, shot, corners, mask):
    """枠のプレースホルダに実スクショを傾けて貼る。"""
    frame = cv2.imread(frame_path)
    h, w = frame.shape[:2]
    src = cv2.cvtColor(np.array(shot), cv2.COLOR_RGB2BGR)
    sh, sw = src.shape[:2]
    quad = np.array([[0, 0], [sw - 1, 0], [sw - 1, sh - 1], [0, sh - 1]], dtype=np.float32)
    M = cv2.getPerspectiveTransform(quad, corners)
    warped = cv2.warpPerspective(src, M, (w, h), flags=cv2.INTER_LANCZOS4,
                                 borderMode=cv2.BORDER_REPLICATE)
    # マスクは角丸を4倍で描いてから縮めた滑らかなものなので、ここでぼかす必要はない
    a = (mask.astype(np.float32) / 255.0)[:, :, None]
    return (warped * a + frame * (1 - a)).astype(np.uint8)


def save_outputs(bgr, slug):
    im = Image.fromarray(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
    main = im.resize((OUT_W, OUT_H), Image.LANCZOS)
    os.makedirs(OUT_DIR, exist_ok=True)
    p = os.path.join(OUT_DIR, f"{slug}.png")
    main.save(p, "PNG", optimize=True)

    # 9:16に収めた版。枠のデザインは切らず、左右に地の色を足して比率だけ合わせる。
    d = os.path.join(OUT_DIR, "9x16")
    os.makedirs(d, exist_ok=True)
    w916 = round(OUT_H * 9 / 16)
    pad = Image.new("RGB", (w916, OUT_H), main.getpixel((2, OUT_H // 2)))
    pad.paste(main, ((w916 - OUT_W) // 2, 0))
    pad.save(os.path.join(d, f"{slug}.png"), "PNG", optimize=True)

    # ストア一覧のサムネくらいまで縮めた版(文字が読めるかの確認用)
    d = os.path.join(OUT_DIR, "thumb")
    os.makedirs(d, exist_ok=True)
    th = main.resize((THUMB_W, round(OUT_H * THUMB_W / OUT_W)), Image.LANCZOS)
    th.save(os.path.join(d, f"{slug}.png"), "PNG", optimize=True)
    return p


def edge_profile(frame_path, rows):
    """指定した行で、プレースホルダの左端と右端のx座標を返す。
    テンプレが同じかどうかを、輪郭ではなく生のピクセルで確かめるために使う。"""
    bgr = cv2.imread(frame_path)
    out = []
    for y in rows:
        row = bgr[y]
        xs = [x for x in range(bgr.shape[1])
              if int(row[x][1]) - int(row[x][2]) < 15 and 5 < row[x][2] < 70]
        out.append((min(xs), max(xs)) if xs else (None, None))
    return out


def measure_all():
    """基準となるプレースホルダを1枚から測り、他の7枚が同じテンプレか確かめる。

    全枠が同じテンプレなら、貼り込み先も1つに揃えるべき。1枚ずつ輪郭検出の
    結果を使うと、プレースホルダ内の説明文字の違いで数pxぶれ、ストアの
    横スワイプで端末の大きさがわずかに伸び縮みして見えてしまう。
    """
    ref_path = os.path.join(FRAME_DIR, SHOTS[0]["frame"])
    corners, mask, (w, h), radius = find_slot(ref_path)
    tl, tr, br, bl = corners
    print(f"  基準 {SHOTS[0]['frame']}")
    print(f"    四隅 TL({tl[0]:.0f},{tl[1]:.0f}) TR({tr[0]:.0f},{tr[1]:.0f}) "
          f"BR({br[0]:.0f},{br[1]:.0f}) BL({bl[0]:.0f},{bl[1]:.0f})")
    print(f"    実寸 {w}x{h} / 角丸 r={radius} / 傾き "
          f"{np.degrees(np.arctan2(tr[1]-tl[1], tr[0]-tl[0])):+.2f}° / 比率 1:{h/w:.3f}")

    rows = [2000, 2600, 3200, 3800, 4300]
    ref = edge_profile(ref_path, rows)
    for s in SHOTS[1:]:
        fp = os.path.join(FRAME_DIR, s["frame"])
        got = edge_profile(fp, rows)
        diff = max(abs(a - c) + abs(b - d) for (a, b), (c, d) in zip(ref, got))
        if diff > 3:
            raise SystemExit(f"[abort] {s['frame']} のプレースホルダが基準と違います "
                             f"(最大ズレ {diff}px)。枠が同一テンプレでないので、"
                             f"1枚ずつ測る作りに直すこと")
    print(f"  他の{len(SHOTS)-1}枚も同じテンプレ(左右端のズレ 0px)")

    shot_w, shot_h = round(w), round(h)
    print(f"  撮影サイズ {shot_w}x{shot_h} / CSS {CSS_W}px 換算の倍率 {shot_w/CSS_W:.3f}")
    slots = {s["slug"]: (os.path.join(FRAME_DIR, s["frame"]), corners, mask) for s in SHOTS}
    return slots, shot_w, shot_h


def main():
    print("[measure] プレースホルダの実測")
    slots, shot_w, shot_h = measure_all()
    print("[shoot] 本番サイトを撮影(ライト固定)")
    shots = shoot_all(shot_w, shot_h)
    print("[compose] 合成")
    for s in SHOTS:
        fp, corners, mask = slots[s["slug"]]
        out = compose(fp, shots[s["slug"]], corners, mask)
        print(f"       {save_outputs(out, s['slug'])}")


if __name__ == "__main__":
    main()
