# -*- coding: utf-8 -*-
"""
レース単位の固有URL。

data.js(今日の出走表)を、index.htmlで1レースを選んだ時に表示される内容
(renderCard + trendPanel)と同等の内容で、
  /race/{YYYY-MM-DD}/{会場ローマ字}/{R}R.html
として静的ページに書き出す。

今日ぶんの生成に続けて、7日ローリング(直近7日より古いrace/配下の日付フォルダを削除)と、
sitemap.xmlの再生成(トップ・ガイド・players_index.jsの選手・race/配下の現存ページ)を行う。
og:image生成・トップページのリンク文言の変更は別ファイル(index.html)側の作業。
既存のplayers/・index.html・guide.html自体はこのスクリプトからは変更しない(読み取りのみ)。
"""
import datetime
import json
import os
import re
import shutil
from xml.sax.saxutils import escape

SITE = "https://teiyomi.com"
OUT_DIR = "race"
RETENTION_DAYS = 7  # 今日を含めて直近何日分のレースページを残すか
CSS_PATH = "race.css"

# 会場コード(01〜24、parse_program.pyのJCD対応表)を元にしたローマ字表記(ヘボン式・長音省略)。
# 一度決めたら固定。
VENUE_ROMAJI = {
    "桐生": "kiryu", "戸田": "toda", "江戸川": "edogawa", "平和島": "heiwajima", "多摩川": "tamagawa",
    "浜名湖": "hamanako", "蒲郡": "gamagori", "常滑": "tokoname", "津": "tsu", "三国": "mikuni",
    "びわこ": "biwako", "住之江": "suminoe", "尼崎": "amagasaki", "鳴門": "naruto", "丸亀": "marugame",
    "児島": "kojima", "宮島": "miyajima", "徳山": "tokuyama", "下関": "shimonoseki", "若松": "wakamatsu",
    "芦屋": "ashiya", "福岡": "fukuoka", "唐津": "karatsu", "大村": "omura",
}

LANES = {
    1: ("#ffffff", "#1a1a1a"), 2: ("#2b2b2b", "#ffffff"), 3: ("#d83a36", "#ffffff"),
    4: ("#2f6fd0", "#ffffff"), 5: ("#f2c200", "#3a2e00"), 6: ("#1f9e54", "#ffffff"),
}
WEMO = {"晴": "☀️", "曇": "☁️", "雨": "☔"}
KIMARITE_ORDER = ["逃げ", "まくり", "差し", "まくり差し", "抜き"]
KIMARITE_DEFS = {
    "逃げ": "先頭のまま押し切って勝つ", "差し": "内側から前の艇をかわす",
    "まくり": "外から回り込んでまとめてかわす", "まくり差し": "まくりと差しを組み合わせた形",
    "抜き": "直線などで単独の艇を追い抜く",
}


def load_js(path, varname):
    content = open(path, encoding="utf-8").read()
    prefix = f"window.{varname} = "
    body = content[len(prefix):].strip()
    if body.endswith(";"):
        body = body[:-1]
    return json.loads(body)


def build_race_css():
    """index.htmlの<style>をそのまま流用し、レースページ専用の小さな追加ルールだけ足す。
    index.html自体は一切変更しない(読み取るだけ)。"""
    content = open("index.html", encoding="utf-8").read()
    start = content.find("<style>") + len("<style>")
    end = content.find("</style>")
    css = content[start:end]
    extra = (
        '\n.back{margin:0 4px 14px; font-size:13px;}\n'
        '.back a{color:var(--accent); text-decoration:underline;}\n'
        # レースページのタイトル(会場+レース番号)は可変長かつ「1R」等を途中で
        # 改行させたくないため、.brand h1に明示的にnowrapを足す(index.html本体は
        # 「艇読み」固定の短い文字列のため元々nowrapが無くても困らないが、
        # レースページ側だけの安全策としてここに追加する)。
        '.topbar .brand h1{white-space:nowrap;}\n'
    )
    with open(CSS_PATH, "w", encoding="utf-8") as f:
        f.write(css + extra)


def num(x, d):
    return "—" if x is None else f"{x:.{d}f}"


def lw_display(lw, lwn):
    if lw is None:
        return '<div class="v">—</div>'
    if lw == 0:
        if not lwn:
            return '<div class="v lwthin">当地初</div>'
        if lwn < 10:
            return '<div class="v lwthin">0.00</div>'
    return f'<div class="v">{lw:.2f}</div>'


def player_name(name, toban, player_pages, crew):
    if toban and toban in player_pages:
        q = f"?crew={crew}" if crew else ""
        return f'<a href="/players/{toban}.html{q}" target="_blank" rel="noopener">{name}</a>'
    return name


def motor_prev_line(motors, venue_name, mno, player_pages):
    if mno is None:
        return ""
    rec = motors.get(f"{venue_name}:{mno}")
    if rec is None:
        return ""
    if not rec:
        return '<div class="mprev thin">前回：データなし（新機の可能性）</div>'
    if rec["touban"] in player_pages:
        name_html = f'<a href="/players/{rec["touban"]}.html" target="_blank" rel="noopener">{rec["name"]}</a>'
    else:
        name_html = rec["name"]
    k = f'{rec["k"]} ' if rec.get("k") else ""
    return f'<div class="mprev">前回：{k}{name_html}</div>'


def f_badge(f):
    if not f:
        return ""
    return (f'<span class="fbadge" title="F＝フライング(スタート事故)。直近半年でF{f}回。'
            f'持っていると次のスタートを警戒し慎重になりやすい">F{f}</span>')


def st_class_label(st):
    if st <= 0.140:
        return "st-a", "攻"
    if st >= 0.185:
        return "st-c", "慎重"
    return "st-n", "標準"


def st_tag(players, toban):
    p = players.get("players", {}).get(toban)
    if not p or not p.get("n") or p["n"] < players.get("min", 8):
        return ""
    cls, label = st_class_label(p["st"])
    return (f'<span class="st-tag {cls} term" title="ST＝スタートタイミング。0に近いほどスタートが上手い">'
            f'ST {p["st"]:.2f}<span class="stl">{label}</span></span>')


def p3_line(players, toban):
    t = "全国3着以内率＝全国のレースで1〜3着に入った割合"
    p = players.get("players", {}).get(toban)
    if not p or not p.get("p3n"):
        return f'<div class="mprev thin term" title="{t}">全国3着内：蓄積中</div>'
    if p["p3n"] < 20:
        return f'<div class="mprev thin term" title="{t}">全国3着内 {p["p3"]}%（{p["p3n"]}走）</div>'
    return f'<div class="mprev term" title="{t}">全国3着内 {p["p3"]}%</div>'


def course_hint(ks):
    """今節/直近の実進入コース履歴(ks.c)の平均から、際立つ傾向があれば一言だけ返す。
    内寄り側の閾値は分布調査(2026-07-13)を踏まえ1.6→2.0に変更済み。
    外め側(4.0)は健全な頻度で機能しているため現状維持。"""
    if not ks or not ks.get("r") or len(ks["r"]) < 2:
        return None
    avg_c = sum(ks["c"]) / len(ks["c"])
    if avg_c <= 2.0:
        return "進入ほぼイン"
    if avg_c >= 4:
        return "進入は外めが多い"
    return None


def kon_setsu_line(ks):
    label = (ks and ks.get("which")) or "今節"
    if not ks or not ks.get("r"):
        return f'<div class="kon thin">{label}の走行データが見当たりません</div>'
    n = len(ks["r"])
    if n < 2:
        return f'<div class="kon thin">{label}データ少なめ（{n}走）</div>'
    flow = "→".join(f"{c}着" if c <= 3 else "着外" for c in ks["r"][-3:])
    tail = f'<span class="thin">（{label}{n}走）</span>' if n < 4 else ""
    kon_title = "今節＝今の開催中の成績" if label == "今節" else "直近＝過去1か月・全会場の成績(今節の走行数が少ない時に表示)"
    hint = course_hint(ks)
    hint_html = f" / {hint}" if hint else ""
    return f'<div class="kon"><b class="term" title="{kon_title}">{label}</b> {flow}{hint_html} {tail}</div>'


def weather_block(stats, venue_name):
    wx = stats.get("venues_wx", {}).get(venue_name)
    if not wx:
        return ""
    MIN = 20
    order = ["晴", "曇", "雨"]
    cells = ""
    solid = []
    for w in order:
        d = wx.get(w, {}).get("1")
        if d:
            thin = " wthin" if d["n"] < MIN else ""
            cells += (f'<div class="wcell{thin}" data-w="{w}">'
                      f'<div class="wemo">{WEMO[w]} {w}</div>'
                      f'<div class="wwin nums">{d["win"]}%</div>'
                      f'<div class="wn nums">{d["n"]}走</div></div>')
            if d["n"] >= MIN:
                solid.append({"w": w, "win": d["win"], "n": d["n"]})
        else:
            cells += (f'<div class="wcell wthin"><div class="wemo">{WEMO[w]} {w}</div>'
                      f'<div class="wwin">—</div><div class="wn">少</div></div>')
    rain = next((b for b in solid if b["w"] == "雨"), None)
    base = next((b for b in solid if b["w"] == "晴"), None) or next((b for b in solid if b["w"] == "曇"), None)
    if rain and base:
        d = round((rain["win"] - base["win"]) * 10) / 10
        if d <= -8:
            hint = (f'<b>☔ 雨の{venue_name}はインが崩れやすい。</b>1コース{rain["win"]}%'
                    f'（{WEMO[base["w"]]}{base["w"]}は{base["win"]}%）。荒れ（外の差し・まくり）が出やすい狙い目。')
        elif d >= 8:
            hint = (f'<b>☔ 雨の{venue_name}はむしろインが堅い。</b>1コース{rain["win"]}%'
                    f'（{WEMO[base["w"]]}{base["w"]}は{base["win"]}%）。人の逆を行ける場面。')
        else:
            hint = f'☔ 雨でもインの強さはあまり変わらない（1コース{rain["win"]}% / {WEMO[base["w"]]}{base["w"]}{base["win"]}%）。'
    elif len(solid) >= 2:
        hi = max(solid, key=lambda b: b["win"])
        lo = min(solid, key=lambda b: b["win"])
        if hi["win"] - lo["win"] >= 8:
            hint = (f'<b>{WEMO[lo["w"]]}{lo["w"]}はインが落ちやすく（1コース{lo["win"]}%）、'
                    f'{WEMO[hi["w"]]}{hi["w"]}は堅い（{hi["win"]}%）。</b>天候で狙い方を変えられる場。')
        else:
            hint = "天候によるインの強さの差は今のところ小さめ。"
    else:
        hint = "天候別はまだデータが少なめ。毎晩たまって、この会場の「雨のクセ」が見えてきます。"
    if solid:
        best = max(solid, key=lambda b: b["win"])["w"]
        cells = cells.replace(f'<div class="wcell" data-w="{best}">', f'<div class="wcell wtop" data-w="{best}">')
    return (f'<div class="wsec"><div class="wsec-head">🌦️ 天候でこう変わる <span>1コースの1着率</span></div>'
            f'<div class="wgrid">{cells}</div><div class="whint">{hint}</div>'
            f'<div class="wnote">直近{stats["days"]}日の集計。本数が少ない天候（薄い表示）は参考程度に。'
            f'日々たまって精度が上がります。</div></div>')


def kimarite_block_venue(stats, venue_name):
    k = stats.get("venues_kimarite", {}).get(venue_name)
    nat = stats.get("kimarite_overall")
    if not k or not nat:
        return ""
    MIN = 20
    thin = " kthin" if k["n"] < MIN else ""
    top = max(KIMARITE_ORDER, key=lambda name: k[name])
    rows = "".join(
        f'<div class="krow{thin}{" ktop" if name == top else ""}">'
        f'<span class="kname term" title="{name}＝{KIMARITE_DEFS[name]}">{name}</span>'
        f'<span class="kbar"><i style="width:{k[name]}%"></i></span>'
        f'<span class="kval nums">{k[name]}%</span></div>'
        for name in KIMARITE_ORDER
    )
    if k["n"] < MIN:
        hint = f'決まり手はまだデータが少なめ（{k["n"]}レース）。毎晩たまって、この会場の「決まり方」が見えてきます。'
        note = '<div class="wnote">本数が少ないため参考程度に。</div>'
    else:
        diff = round((k["逃げ"] - nat["逃げ"]) * 10) / 10
        makuri = round((k["まくり"] + k["まくり差し"]) * 10) / 10
        if diff >= 8:
            hint = f'<b>逃げが決まりやすい、堅い場。</b>逃げ決着{k["逃げ"]}%（全国平均{nat["逃げ"]}%）。イン逃げの信頼度が高い。'
        elif diff <= -8:
            hint = (f'<b>荒れやすい場。</b>逃げ決着は{k["逃げ"]}%にとどまり（全国平均{nat["逃げ"]}%）、'
                    f'まくり系（まくり＋まくり差し）が{makuri}%と多め。')
        else:
            hint = f'決まり手の傾向はほぼ全国平均どおり（逃げ{k["逃げ"]}% / 全国{nat["逃げ"]}%）。'
        note = ""
    return (f'<div class="wsec"><div class="wsec-head">🎯 決まり手のクセ <span>直近{stats["days"]}日 {k["n"]}レース</span></div>'
            f'{rows}<div class="whint">{hint}</div>{note}</div>')


def trend_panel(stats, venue_name):
    if not stats or venue_name not in stats.get("venues", {}):
        return ('<div class="trend"><div class="trend-head">'
                '<span class="trend-ttl"><span class="pin"></span>この会場のクセ</span></div>'
                '<div class="tna">傾向データは集計中です（毎晩たまっていきます）。</div></div>')
    vs = stats["venues"][venue_name]
    nat = stats["overall"]
    MIN_N = 20
    rows = ""
    any_thin = False
    for c in range(1, 7):
        x = vs.get(str(c))
        if not x:
            continue
        thin = x["n"] < MIN_N
        if thin:
            any_thin = True
        bg = LANES[c][0]
        rows += (f'<div class="trow{" tthin" if thin else ""}">'
                 f'<span class="tcourse"><span class="tdot" style="background:{bg}"></span>{c}コース</span>'
                 f'<span class="tbar"><i class="p3" style="width:{x["p3"]}%"></i>'
                 f'<i class="win" style="width:{x["win"]}%"></i></span>'
                 f'<span class="tval-wrap"><span class="tval nums">{x["win"]}%</span>'
                 f'<span class="tval-sub nums">3着内{x["p3"]}%</span></span></div>')
    v1 = vs["1"]["win"]; n1 = nat["1"]["win"]; v1p3 = vs["1"]["p3"]; n1p3 = nat["1"]["p3"]
    thin1 = vs["1"]["n"] < MIN_N
    if v1 >= n1 + 3:
        hint = f'1コースの1着率が全国平均({n1}%)より高め。インが信頼されやすい場。'
    elif v1 <= n1 - 3:
        hint = f'1コースの1着率が全国平均({n1}%)より低め。波乱（外の差し・まくり）が起きやすい場。'
    else:
        hint = f'1コースの強さはほぼ全国平均({n1}%)どおり。'
    ref = "（本数少なめ・参考程度）" if thin1 else f"（全国平均{n1p3}%）"
    hint += f' 1コースの3着以内率は{v1p3}%{ref}。'
    tna_html = '<div class="tna">本数が少ないコース(20走未満)は薄く表示・参考程度に。</div>' if any_thin else ""
    return (f'<div class="trend"><div class="trend-head">'
            f'<span class="trend-ttl"><span class="pin"></span>この会場のクセ</span>'
            f'<span class="trend-sub"><span class="term" title="進入コース＝スタート時に何コース(1〜6)に入ったか。'
            f'内側(1コース)ほど有利とされる">進入コース</span>別 1着率・3着以内率 ・ 過去{stats["days"]}日 '
            f'{vs["1"]["n"]}レース</span></div>'
            f'<div class="tlegend"><span><b class="win"></b>1着率</span>'
            f'<span><b class="p3"></b>3着以内率（1〜3着に入った割合）</span></div>'
            f'{rows}<div class="thint">{hint}</div>{tna_html}'
            f'{weather_block(stats, venue_name)}{kimarite_block_venue(stats, venue_name)}</div>')


def compare_table(race, players):
    """6艇を横に並べて比べる一覧(艇番/選手名/ST/F持ちの4列のみ)。
    進入傾向は列にせず、際立つ艇がいる時だけ下の注記に回す(頻度調査の結果、
    列にすると大半のレースで空欄だらけになるため)。将来、展示タイム・オッズ・
    進入予定を列として足すことを見込み、固定ピクセル幅に頼らないtable構造にしてある。"""
    rows = ""
    notes = []
    for b in race["boats"]:
        L = LANES[b["n"]]
        p = players.get("players", {}).get(b.get("t"))
        if p and p.get("n") and p["n"] >= players.get("min", 8):
            _, label = st_class_label(p["st"])
            st_html = f'{p["st"]:.2f}<span class="cmp-stl">{label}</span>'
        else:
            st_html = '<span class="cmp-na">—</span>'
        f_html = f'<span class="cmp-f">F{b["f"]}</span>' if b.get("f") else ""
        rows += (f'<tr><td><span class="cmp-lane" style="background:{L[0]};color:{L[1]}">{b["n"]}</span></td>'
                  f'<td class="cmp-nm">{b["name"]}</td>'
                  f'<td class="nums">{st_html}</td>'
                  f'<td>{f_html}</td></tr>')
        hint = course_hint(b.get("ks"))
        if hint:
            verb = "直近は内寄りの進入が続きます" if hint == "進入ほぼイン" else "直近は外めからの進入が続きます"
            notes.append(f'※{b["n"]}号艇 {b["name"]}選手は、{verb}。')

    note_html = ""
    if notes:
        note_html = ('<div class="cmp-note">' + "<br>".join(notes) +
                     '<br>進入傾向は直近の実績に基づく傾向です。実際の進入は締切後に確定します。</div>')

    return (f'<div class="cmp"><div class="cmp-ttl">比べる一覧</div>'
            f'<table class="cmp-table"><thead><tr><th>艇</th><th>選手</th><th>ST</th><th>F</th></tr></thead>'
            f'<tbody>{rows}</tbody></table>{note_html}</div>')


def render_boat(b, venue_name, motors, players, player_pages, crew):
    L = LANES[b["n"]]
    mo = 0 if b.get("mo") is None else round(b["mo"] * 10) / 10
    name_html = player_name(b["name"], b.get("t"), player_pages, crew)
    return f"""<div class="boat">
      <div class="badge" style="background:{L[0]};color:{L[1]}">{b['n']}</div>
      <div>
        <div class="bname">{name_html}<span class="bk term" title="級別＝選手のランク。強い順にA1＞A2＞B1＞B2">{b['k']}</span>{f_badge(b.get('f'))}</div>
        <div class="bmeta">{b['age']}歳 ・ {b['br']} ・ {b['wt']}kg{st_tag(players, b.get('t'))}</div>
        {kon_setsu_line(b.get('ks'))}
      </div>
      <div class="stats nums">
        <div class="stat nw"><div class="l term" title="全国勝率＝全国での成績を点数化した競艇独自の指数(％ではありません)">全国勝率</div><div class="v">{num(b.get('nw'), 2)}</div></div>
        <div class="stat lw"><div class="l term" title="当地勝率＝この会場だけに絞った、全国勝率と同じ仕組みの指数">当地勝率</div>{lw_display(b.get('lw'), b.get('lwn'))}{p3_line(players, b.get('t'))}</div>
        <div class="stat mo"><div class="l term" title="モーター2連率＝このモーターが過去に2着以内に入った割合">モーター2率</div><div class="v">{mo}%</div>
          <div class="bar"><i style="width:{mo}%"></i></div>
          {motor_prev_line(motors, venue_name, b.get('mno'), player_pages)}</div>
      </div>
    </div>"""


def render_race_card(venue_name, race, motors, players, player_pages):
    crew = ",".join(f"{b['t']}:{b['n']}:{b['name']}" for b in race["boats"] if b.get("t") in player_pages)
    cmp_html = compare_table(race, players)
    rows = "".join(render_boat(b, venue_name, motors, players, player_pages, crew) for b in race["boats"])
    return (f'<div class="card"><div class="card-head">'
            f'<div class="ttl">{venue_name} <span>{race["no"]}R</span></div>'
            f'<div class="dl nums term" title="締切＝このレースの投票締切時刻">締切 {race.get("dl") or "—"}</div>'
            f'</div>{cmp_html}{rows}</div>')


def render_race_page(date_iso, date_jp, venue_name, venue_romaji, race, motors, players, player_pages, stats):
    title = f"{venue_name}{race['no']}R {date_jp}の出走表・データ｜艇読み"
    description = (f"{date_jp}・{venue_name}{race['no']}Rの出走表。出走選手の全国勝率・当地勝率・モーター2連率・"
                    f"スタートタイミングなど公式データをそのまま掲載し、会場の天候・決まり手のクセもあわせて確認できます。"
                    f"予想印は出さず、数字と傾向から自分で判断するための艇読みのレースページです。")
    url = f"{SITE}/race/{date_iso}/{venue_romaji}/{race['no']}R.html"
    card_html = render_race_card(venue_name, race, motors, players, player_pages)
    trend_html = trend_panel(stats, venue_name)
    return f"""<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{title}</title>
<meta name="description" content="{description}">
<link rel="canonical" href="{url}">
<meta property="og:type" content="article">
<meta property="og:url" content="{url}">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{description}">
<meta property="og:image" content="https://teiyomi.com/og-image.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="https://teiyomi.com/og-image.png">
<link rel="stylesheet" href="/race.css">
</head>
<body>
<div class="wrap">
  <header class="topbar">
    <div class="brand">
      <div class="lanes" aria-hidden="true">
        <i style="background:#fff"></i><i style="background:#2b2b2b"></i><i style="background:#d83a36"></i>
        <i style="background:#2f6fd0"></i><i style="background:#f2c200"></i><i style="background:#1f9e54"></i>
      </div>
      <div><h1>{venue_name} {race['no']}R</h1><p>艇読み — 出走表</p></div>
    </div>
    <div class="datepill nums">{date_jp}</div>
  </header>
  <p class="back"><a href="/index.html">← トップ（今日の出走表）に戻る</a></p>
  {card_html}
  {trend_html}
  <p class="foot"><b>予想印（◎○▲）は出していません。</b>出典：<a href="https://www.boatrace.jp/" target="_blank" rel="noopener">BOAT RACE公式サイト</a>の番組表・競走成績を整形して表示。<br>舟券の購入は20歳になってから。のめり込みに注意し、余裕資金の範囲で楽しみましょう。心配な方は、<a href="https://www.caa.go.jp/policies/policy/consumer_policy/caution/caution_012/" target="_blank" rel="noopener">消費者庁の案内ページ</a>（相談窓口の案内）をご確認ください。<br>個人情報の取り扱いについては<a href="/privacy.html">プライバシーポリシー</a>をご覧ください。<br><a href="/about.html">運営者情報</a></p>
</div>
</body>
</html>"""


def cleanup_old_race_pages(today_iso):
    """race/配下で、直近RETENTION_DAYS日(今日含む)より古い日付フォルダを削除する。

    安全策：
    - race/配下の直接の子フォルダのみを削除候補にする(それより深い階層やplayers/等には触れない)。
    - フォルダ名が厳密にYYYY-MM-DD形式に一致するものだけを対象にする(想定外の名前は無視して残す)。
    - 削除直前に、対象パスの正規化結果が本当に"race"配下であることを再検証してから削除する。
    """
    if not os.path.isdir(OUT_DIR):
        return []
    cutoff = datetime.date.fromisoformat(today_iso) - datetime.timedelta(days=RETENTION_DAYS - 1)
    removed = []
    race_root = os.path.normpath(OUT_DIR)
    for name in sorted(os.listdir(OUT_DIR)):
        path = os.path.join(OUT_DIR, name)
        if not os.path.isdir(path):
            continue
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", name):
            continue  # 日付フォルダ以外は削除候補にしない
        try:
            folder_date = datetime.date.fromisoformat(name)
        except ValueError:
            continue
        if folder_date >= cutoff:
            continue  # 保持期間内
        norm = os.path.normpath(path)
        if not (norm == race_root or norm.startswith(race_root + os.sep)):
            raise RuntimeError(f"safety check failed, refusing to delete outside {race_root}: {path}")
        shutil.rmtree(path)
        removed.append(name)
    return removed


def refresh_sitemap():
    """トップ・ガイド・players_index.jsの選手・race/配下の現存ページ(ローリング後)から
    sitemap.xmlを再生成する。ローリングで消えたページはここで自動的にsitemapからも消える。"""
    lastmod = datetime.date.today().isoformat()
    urls = ["https://teiyomi.com/", "https://teiyomi.com/guide.html", "https://teiyomi.com/privacy.html", "https://teiyomi.com/about.html"]
    try:
        player_pages = load_js("players_index.js", "PLAYER_PAGES")
        urls += [f"https://teiyomi.com/players/{t}.html" for t in player_pages]
    except FileNotFoundError:
        pass
    if os.path.isdir(OUT_DIR):
        for date_name in sorted(os.listdir(OUT_DIR)):
            date_path = os.path.join(OUT_DIR, date_name)
            if not os.path.isdir(date_path) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date_name):
                continue
            for venue_name in sorted(os.listdir(date_path)):
                venue_path = os.path.join(date_path, venue_name)
                if not os.path.isdir(venue_path):
                    continue
                for fname in sorted(os.listdir(venue_path)):
                    if fname.endswith(".html"):
                        urls.append(f"https://teiyomi.com/race/{date_name}/{venue_name}/{fname}")
    lines = ['<?xml version="1.0" encoding="UTF-8"?>',
             '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for url in urls:
        lines.append(f"  <url><loc>{escape(url)}</loc><lastmod>{lastmod}</lastmod></url>")
    lines.append("</urlset>")
    with open("sitemap.xml", "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    return len(urls)


def main():
    data = load_js("data.js", "DATA")
    players = load_js("players.js", "PLAYERS")
    motors = load_js("motors.js", "MOTORS")
    stats = load_js("stats.js", "STATS")
    player_pages = set(load_js("players_index.js", "PLAYER_PAGES"))

    build_race_css()

    date_jp = data["date"]
    m = re.match(r"(\d+)年(\d+)月(\d+)日", date_jp)
    date_iso = f"{int(m.group(1)):04d}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"

    n_pages = 0
    n_skipped_venue = 0
    for v in data["venues"]:
        vname = v["name"]
        romaji = VENUE_ROMAJI.get(vname)
        if not romaji:
            print(f"[warn] 会場ローマ字表に無い会場: {vname}")
            n_skipped_venue += 1
            continue
        out_dir = os.path.join(OUT_DIR, date_iso, romaji)
        os.makedirs(out_dir, exist_ok=True)
        for race in v["races"]:
            html = render_race_page(date_iso, date_jp, vname, romaji, race, motors, players, player_pages, stats)
            path = os.path.join(out_dir, f"{race['no']}R.html")
            with open(path, "w", encoding="utf-8") as f:
                f.write(html)
            n_pages += 1

    removed = cleanup_old_race_pages(date_iso)
    n_urls = refresh_sitemap()

    print(f"[done] {n_pages}ページ生成（{date_iso}分、会場スキップ{n_skipped_venue}件）→ {OUT_DIR}/{date_iso}/、{CSS_PATH}")
    print(f"[done] ローリング削除: {len(removed)}日分（{', '.join(removed) if removed else 'なし'}）")
    print(f"[done] sitemap.xml再生成: {n_urls}URL")


if __name__ == "__main__":
    # build_featured.py/build_motors.pyと同じ考え方：想定外のエラーで daily.yml の
    # 本丸であるdata.js更新のコミット・pushまで止めたくないので、ここで受け止めて正常終了する
    # (race/・sitemap.xmlは更新されず、前日分が残るだけで済む)。
    try:
        main()
    except Exception as e:
        print(f"[warn] レースページ生成に失敗、race/・sitemap.xmlは更新しない: {e}")
