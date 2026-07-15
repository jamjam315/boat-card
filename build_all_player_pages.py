# -*- coding: utf-8 -*-
"""
選手図鑑・全選手ページ生成。
fan(コース傾向・属性・母数厚い公式集計) + K(決まり手・当地・今の調子、直近1年)を統合し、
選手ごとに静的HTMLを1枚(players/{登番}.html)生成する。

【今回の範囲】ページ生成のみ。トップページ・レースカードからのリンク、URL構造の変更はしない
(このスクリプトは既存サイトのどこからも参照されない、独立した出力)。
"""
import os, json, re, statistics, datetime
from xml.sax.saxutils import escape
from build_profiles_v5 import load_fan_master, load_k_stats, build_profile

OUT_DIR = "players"
TODAY_ISO = "2026-07-05"   # 生成基準日(直近30日の起点として使う)
KIMARITE_ORDER = ["逃げ", "まくり", "差し", "まくり差し", "抜き"]
LANE_COLORS = {1:"#ffffff",2:"#2b2b2b",3:"#d83a36",4:"#2f6fd0",5:"#f2c200",6:"#1f9e54"}

CSS = """
:root{
  --bg:#eef0ec; --surface:#ffffff; --ink:#13242a; --ink2:#4a5a61; --muted:#7c8a90;
  --line:#e2e5e0; --line2:#d3d8d2; --water:#0f2a33; --accent:#0e7c66; --accent-soft:#dff0ea;
  --fav:#c9922a;
  --radius:14px;
}
@media (prefers-color-scheme: dark){
  :root{ --bg:#10171a; --surface:#182226; --ink:#eef3f2; --ink2:#aebcc0; --muted:#7e8d92;
    --line:#243136; --line2:#2e3d43; --water:#0a1b20; --accent:#3bbf9e; --accent-soft:#16302a;
    --fav:#e0b054; }
}
*{box-sizing:border-box} html,body{margin:0}
body{background:var(--bg); color:var(--ink); font-family:"Hiragino Kaku Gothic ProN","Hiragino Sans","Noto Sans JP","Yu Gothic UI","Yu Gothic",system-ui,sans-serif; line-height:1.6;}
.wrap{max-width:680px; margin:0 auto; padding:0 14px 40px;}
.nums{font-variant-numeric:tabular-nums lining-nums;}
.topbar{background:var(--water); color:#eaf3f0; border-radius:0 0 var(--radius) var(--radius); padding:16px 18px;}
.topbar h1{font-size:16px; margin:0;} .topbar p{font-size:11.5px; margin:4px 0 0; color:#9fc3ba;}
.hero{background:var(--surface); border:1px solid var(--line); border-radius:var(--radius); margin-top:14px;
  display:flex; align-items:stretch;}
.hero-body{flex:1; min-width:0; padding:22px 20px; text-align:center;}
.hero .pname{font-size:20px; font-weight:700;} .hero .pmeta{font-size:12.5px; color:var(--ink2); margin-top:3px;}
.fav-btn{background:none; border:none; cursor:pointer; font-size:22px; line-height:1; padding:8px 10px;
  margin-left:2px; color:var(--muted); vertical-align:-6px; -webkit-tap-highlight-color:transparent;}
.fav-btn.active{color:var(--fav);}
.hero .catch{font-size:21px; font-weight:800; color:var(--accent); margin-top:14px;}
.hero .catch-basis{font-size:11.5px; color:var(--muted); margin-top:8px; line-height:1.6;}
.hero-nav{flex:0 0 56px; display:none; flex-direction:column; align-items:center; justify-content:center;
  gap:4px; text-decoration:none; color:var(--ink2); -webkit-tap-highlight-color:transparent;}
.hero-nav:active{background:var(--bg);}
.hero-nav.prev{border-radius:var(--radius) 0 0 var(--radius);}
.hero-nav.next{border-radius:0 var(--radius) var(--radius) 0;}
.hero-nav .arrow{font-size:22px; font-weight:700; color:var(--accent); line-height:1;}
.hero-nav .lane{width:19px; height:19px; border-radius:5px; font-size:10.5px; font-weight:700;
  display:flex; align-items:center; justify-content:center; border:1px solid rgba(125,125,125,.3);}
.hero-nav .nm{font-size:9.5px; color:var(--muted); max-width:50px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
@media (max-width:380px){
  .hero-nav{flex-basis:44px;}
  .hero-nav .nm{max-width:38px;}
  .hero-body{padding:20px 8px;}
}
.card{background:var(--surface); border:1px solid var(--line); border-radius:var(--radius); margin-top:14px; padding:16px 18px;}
.card-ttl{font-size:14px; font-weight:600; display:flex; align-items:baseline; gap:6px; margin-bottom:10px;}
.card-ttl .pin{width:8px; height:8px; border-radius:50%; background:var(--accent); display:inline-block;}
.card-sub{font-size:11px; color:var(--muted); font-weight:400; margin-left:auto;}
.toprates{display:flex; align-items:baseline; flex-wrap:wrap; column-gap:10px; font-size:14px;}
.toprates .tr-item{white-space:nowrap;}
@media (max-width:460px){
  .toprates{flex-direction:column; align-items:flex-start; gap:2px;}
  .toprates .tr-sep{display:none;}
}
.trow{display:grid; grid-template-columns:74px 1fr 44px 60px; align-items:center; gap:10px; padding:4px 0;}
.tcourse{display:flex; align-items:center; gap:6px; font-size:12.5px; color:var(--ink2);}
.tdot{width:10px; height:10px; border-radius:3px; border:1px solid rgba(125,125,125,.4); flex:0 0 auto;}
.tbar{height:8px; background:var(--bg); border-radius:4px; overflow:hidden;} .tbar i{display:block; height:100%; background:var(--accent);}
.tval{font-size:13px; font-weight:600; text-align:right;} .tn{font-size:11px; color:var(--muted); text-align:right;}
.krow{display:grid; grid-template-columns:74px 1fr 60px; align-items:center; gap:10px; padding:4px 0;}
.kname{font-size:12.5px; color:var(--ink2);}
.kbar{height:8px; background:var(--bg); border-radius:4px; overflow:hidden;} .kbar i{display:block; height:100%; background:var(--line2);}
.krow.ktop .kbar i{background:var(--accent);} .krow.ktop .kname{color:var(--ink); font-weight:600;}
.kval{font-size:13px; font-weight:600; text-align:right;}
.homebox{background:var(--accent-soft); border:1px solid var(--accent); border-radius:10px; padding:10px 14px; font-size:13px;}
.nohome{font-size:12.5px; color:var(--muted); font-style:italic;}
.kon{font-size:13px; color:var(--ink2);} .kon b{color:var(--ink); font-weight:600;}
.note{font-size:11.5px; color:var(--muted); margin-top:10px; padding-top:10px; border-top:1px dashed var(--line2); line-height:1.6;}
.tenji-tag{display:inline-block; font-size:13px; font-weight:700; color:var(--ink); background:var(--bg); border:1px solid var(--line2); border-radius:8px; padding:5px 12px;}
.foot{margin-top:20px; padding:14px 4px 0; border-top:1px solid var(--line); color:var(--muted); font-size:11.5px;}
.foot a{color:var(--accent); text-decoration:underline; text-decoration-color:var(--line2);}
"""

# レースカード(index.html)の選手名リンクが ?crew=登番:号艇:名前,... を付けて来た時だけ、
# ヒーロー欄に前/次選手への矢印を出す。crewが無い(直リンク・将来のSEO流入)場合は何もしない。
# 図鑑ページはこのJS以外に他ページのデータを一切読み込まない(自己完結)。
NAV_JS = """
<script>
(function(){
  var MY_TOBAN = "__MY_TOBAN__";
  var crew = new URLSearchParams(location.search).get("crew");
  if(!crew) return;
  var list = crew.split(",").map(function(s){
    var parts = s.split(":");
    return {t: parts[0], n: parts[1], name: parts.slice(2).join(":")};
  }).filter(function(x){ return x.t; });
  var idx = -1;
  for(var i=0;i<list.length;i++){ if(list[i].t === MY_TOBAN){ idx = i; break; } }
  if(idx === -1 || list.length < 2) return;
  var prev = list[(idx - 1 + list.length) % list.length];
  var next = list[(idx + 1) % list.length];
  var LANE = {"1":["#ffffff","#1a1a1a"],"2":["#2b2b2b","#ffffff"],"3":["#d83a36","#ffffff"],
    "4":["#2f6fd0","#ffffff"],"5":["#f2c200","#3a2e00"],"6":["#1f9e54","#ffffff"]};
  function fill(el, person, dir){
    if(!el) return;
    el.href = person.t + ".html?crew=" + encodeURIComponent(crew);
    el.style.display = "flex";
    var col = LANE[person.n] || ["#ccc","#333"];
    var lane = '<span class="lane" style="background:'+col[0]+';color:'+col[1]+'">'+person.n+'</span>';
    var name = '<span class="nm">'+person.name+'</span>';
    var arrow = dir === "prev" ? '<span class="arrow">‹</span>' : '<span class="arrow">›</span>';
    el.innerHTML = arrow+lane+name;
  }
  fill(document.getElementById("heroPrev"), prev, "prev");
  fill(document.getElementById("heroNext"), next, "next");
})();
</script>
"""

# お気に入り(★)の状態表示・トグル。favorites.js(共有ロジック、localStorage担当)を
# 読み込んで使うだけで、このページ自身はlocalStorageに直接触れない。
# TeiyomiFavoritesが無い(favorites.jsの読み込み失敗等)場合はボタンごと出さない
# (半端に押せるが効かないボタンを置かない)。
FAV_JS = """
<script src="/favorites.js"></script>
<script>
(function(){
  var btn = document.getElementById("favBtn");
  if(!btn || !window.TeiyomiFavorites) return;
  var toban = btn.getAttribute("data-toban");
  function paint(){
    var on = TeiyomiFavorites.has(toban);
    btn.textContent = on ? "★" : "☆";
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  }
  btn.addEventListener("click", function(){
    TeiyomiFavorites.toggle(toban);
    paint();
  });
  paint();
})();
</script>
"""


def meta_title(prof):
    fp = prof["profile"]
    if prof["best_diff"] is None:
        return f"{fp['氏名']}（{fp['支部']}・{fp['級別']}）の成績データ｜艇読み選手図鑑"
    return f"{fp['氏名']}の二つ名「{prof['catch']}」と成績｜艇読み選手図鑑"


def meta_description(prof):
    fp = prof["profile"]
    name, kyu, shibu, age = fp["氏名"], fp["級別"], fp["支部"], fp["年齢"]
    if prof["best_diff"] is None:
        return (f"{name}選手（{kyu}・{shibu}支部、{age}歳）の通算成績・進入コース傾向をデータで紹介。"
                f"まだ出走数が少なく成績は蓄積中ですが、今後のレースごとにこのページの数字も更新されます。"
                f"予想印は出さず、数字の推移をそのまま読める形でお届けします。")
    home = prof["home"]
    home_sentence = f"、当地{home['venue']}での勝率は{home['win']:.1f}%。" if home else "。"
    return (f"{name}選手（{kyu}・{shibu}支部、{age}歳）の通算成績・進入コース傾向・決まり手・当地成績をデータで紹介。"
            f"二つ名は「{prof['catch']}」{home_sentence}"
            f"予想印は出さず、数字で選手の個性を伝える艇読みの選手図鑑ページです。")


def scan_race_urls():
    """race/配下(日付/会場ローマ字/xR.html)を実際にスキャンしてURL一覧を作る。
    build_race_pages.pyの7日ローリングで管理されているフォルダなので、ここでは
    存在するものをそのまま数え上げるだけ(削除・生成は一切行わない)。"""
    urls = []
    if not os.path.isdir("race"):
        return urls
    for date_name in sorted(os.listdir("race")):
        date_path = os.path.join("race", date_name)
        if not os.path.isdir(date_path) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date_name):
            continue
        for venue_name in sorted(os.listdir(date_path)):
            venue_path = os.path.join(date_path, venue_name)
            if not os.path.isdir(venue_path):
                continue
            for fname in sorted(os.listdir(venue_path)):
                if fname.endswith(".html"):
                    urls.append(f"https://teiyomi.com/race/{date_name}/{venue_name}/{fname}")
    return urls


def build_sitemap(written):
    """トップ・ガイド・全図鑑ページ・(存在すれば)race/配下の現存レースページから
    sitemap.xmlを自動生成する。ページ数が増減しても、次回実行するたびに追従する。
    race/はbuild_race_pages.py側の7日ローリングで管理されているため、ここではスキャンして
    載せるだけ(このスクリプトの実行がレースページの生成・削除に影響することはない)。"""
    lastmod = datetime.date.today().isoformat()
    urls = ["https://teiyomi.com/", "https://teiyomi.com/guide.html", "https://teiyomi.com/privacy.html",
            "https://teiyomi.com/about.html", "https://teiyomi.com/players/"]
    urls += [f"https://teiyomi.com/players/{t}.html" for t in written]
    urls += scan_race_urls()
    lines = ['<?xml version="1.0" encoding="UTF-8"?>',
             '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for url in urls:
        lines.append(f"  <url><loc>{escape(url)}</loc><lastmod>{lastmod}</lastmod></url>")
    lines.append("</urlset>")
    with open("sitemap.xml", "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    return len(urls)


def kimarite_block(prof):
    tw = prof["kimarite_total_wins"]
    if tw < 3:
        return f'<div class="note">決まり手はまだ判定できるほど勝ちが少なめです（{tw}勝・蓄積中）。</div>'
    pct = prof["kimarite_pct"]
    top = max(KIMARITE_ORDER, key=lambda k: pct[k] or 0)
    rows = ""
    for k in KIMARITE_ORDER:
        v = pct[k] or 0
        cls = "krow ktop" if k == top else "krow"
        rows += f'<div class="{cls}"><span class="kname">{k}</span><span class="kbar"><i style="width:{v}%"></i></span><span class="kval nums">{v}%</span></div>'
    return rows + f'<div class="note">直近1年・勝ち{tw}件の内訳です。</div>'


def top_rates_block(prof):
    tr = prof["top_rates"]
    if tr["n"] == 0:
        return '<div style="font-size:11.5px;color:var(--muted);font-style:italic;">全国1着率・3着以内率：蓄積中</div>'
    thin = tr["n"] < 10
    style = ' style="opacity:.55"' if thin else ""
    ref = "（参考程度）" if thin else ""
    line = (f'<div class="toprates"{style}>'
            f'<span class="tr-item"><b>1着率 {tr["win1"]}%</b>（{tr["win1_n"]}走）</span>'
            f'<span class="tr-sep">　│　</span>'
            f'<span class="tr-item"><b>3着以内率 {tr["p3"]}%</b>（{tr["p3_n"]}走）{ref}</span>'
            f'</div>')
    note = ('<div style="font-size:11.5px;color:var(--muted);margin-top:6px;line-height:1.6;">'
            '1着率と3着以内率をあわせて見ると、勝ちきる力と上位に食い込む粘り強さの両方が読めます。</div>')
    return line + note


def course_block(prof):
    course = prof["course"]
    rows = ""
    thin_note = []
    for c in range(1, 7):
        d = course.get(c)
        color = LANE_COLORS[c]
        if not d or not d.get("n"):
            rows += f'<div class="trow"><span class="tcourse"><span class="tdot" style="background:{color}"></span>{c}コース</span><span class="tbar"><i style="width:0%"></i></span><span class="tval">—</span><span class="tn">0走</span></div>'
            continue
        thin = ' style="opacity:.5"' if d["n"] < 10 else ""
        if d["n"] < 10:
            thin_note.append(f"{c}コース")
        rows += f'<div class="trow"{thin}><span class="tcourse"><span class="tdot" style="background:{color}"></span>{c}コース</span><span class="tbar"><i style="width:{d["win"]}%"></i></span><span class="tval nums">{d["win"]}%</span><span class="tn nums">{d["n"]}走</span></div>'
    note = f'<div class="note">数字は各コースからの1着率（直近半年・公式集計）。{"、".join(thin_note)+"は母数が少なめのため参考程度に。" if thin_note else ""}</div>'
    return rows + note


TENJI_LABEL_TEXT = {"stable": "展示は安定型", "volatile": "展示は変動型"}


def tenji_block(prof):
    """展示タイムの安定度(会場差補正済み)。速さ・強さとは無関係の「ブレ方」の
    事実提示にとどめ、安定=良い/変動=悪いという価値判断に見えないよう、
    両ラベルを同じ見た目(色分けなし)で出す。30件未満/中間1/3の選手はカード自体を出さない。"""
    label = prof.get("tenji_label")
    if not label:
        return ""
    return f'''<section class="card">
    <div class="card-ttl"><span class="pin"></span>展示タイムの傾向</div>
    <div class="tenji-tag">{TENJI_LABEL_TEXT[label]}</div>
    <div class="note">展示タイムのブレの大きさ（安定度）を示すもので、速さの指標ではありません。本番の強さ・着順とは関係しません。</div>
  </section>'''


def home_block(prof):
    h = prof["home"]
    if not h:
        return '<div class="nohome">特に際立って強い会場は、まだ見つかっていません。</div>'
    return f'<div class="homebox">🏠 <b>{h["venue"]}</b>：{h["n"]}走・勝率{h["win"]:.1f}%（他会場{h["other_win"]:.1f}%より+{h["diff"]:.1f}pt）</div>'


def kon_block(prof):
    ks = prof["ks"]
    if not ks:
        return '<div class="kon">走行データが見当たりません。</div>'
    label = ks["which"]
    n = len(ks["r"])
    if n == 0:
        return f'<div class="kon">{label}の走行データが見当たりません。</div>'
    if n < 2:
        return f'<div class="kon">{label}データ少なめ（{n}走）</div>'
    flow = ks["r"][-3:]
    flow_str = "→".join(f"{c}着" if c <= 3 else "着外" for c in flow)
    # 進入は際立つ時だけ一言添える(「進入まちまち」=特徴なしは出さない)。
    # STの安定度はカードのSTバッジと二重表現かつほぼ常に「ばらつき」で情報にならないため出さない。
    avgc = sum(ks["c"]) / len(ks["c"])
    course_hint = ""
    if avgc <= 1.6: course_hint = " / 進入ほぼイン"
    elif avgc >= 4: course_hint = " / 進入は外めが多い"
    tail = f'<span style="color:var(--muted);font-style:italic;">（{label}{n}走）</span>' if n < 10 else ""
    return f'<div class="kon"><b>{label}</b> {flow_str}{course_hint} {tail}</div>'


def render_page(prof):
    fp = prof["profile"]
    title = meta_title(prof)
    description = meta_description(prof)
    url = f"https://teiyomi.com/players/{prof['touban']}.html"
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
<link rel="manifest" href="/manifest.json">
<link rel="apple-touch-icon" href="/icon-192.png">
<meta name="theme-color" content="#0f2a33">
<style>{CSS}</style>
</head>
<body>
<div class="wrap">
  <header class="topbar">
    <h1>艇読み — 選手図鑑</h1>
    <p>公式番組表・成績を、読める形に。</p>
  </header>
  <section class="hero">
    <a class="hero-nav prev" id="heroPrev" aria-label="前の選手"></a>
    <div class="hero-body">
      <div class="pname">{fp['氏名']} <span style="font-weight:400;font-size:13px;color:var(--ink2);">{fp['級別']}</span><button class="fav-btn" id="favBtn" data-toban="{prof['touban']}" aria-label="お気に入り登録・解除" aria-pressed="false">☆</button></div>
      <div class="pmeta">{fp['年齢']}歳 ・ {fp['支部']}支部 ・ {fp['体重']}kg</div>
      <div class="catch">「{prof['catch']}」</div>
      <div class="catch-basis">{prof['catch_basis']}</div>
    </div>
    <a class="hero-nav next" id="heroNext" aria-label="次の選手"></a>
  </section>
  <section class="card">
    <div class="card-ttl"><span class="pin"></span>通算の進入コース傾向<span class="card-sub">直近半年(公式集計)</span></div>
    {top_rates_block(prof)}
    {course_block(prof)}
  </section>
  <section class="card">
    <div class="card-ttl"><span class="pin"></span>勝った時の決まり手<span class="card-sub">直近1年</span></div>
    {kimarite_block(prof)}
  </section>
  <section class="card">
    <div class="card-ttl"><span class="pin"></span>当地(得意会場)</div>
    {home_block(prof)}
  </section>
  <section class="card">
    <div class="card-ttl"><span class="pin"></span>今の調子</div>
    {kon_block(prof)}
  </section>
  {tenji_block(prof)}
  <p class="foot"><b>予想印は出していません。</b>通算の進入コース傾向は直近半年の公式集計、決まり手・当地・今の調子は直近1年の結果データを集計しています。母数が少ない項目は薄く表示するか「蓄積中」と明記しています。<br>舟券の購入は20歳になってから。のめり込みに注意し、余裕資金の範囲で楽しみましょう。心配な方は、<a href="https://www.caa.go.jp/policies/policy/consumer_policy/caution/caution_012/" target="_blank" rel="noopener">消費者庁の案内ページ</a>（相談窓口の案内）をご確認ください。<br>個人情報の取り扱いについては<a href="/privacy.html">プライバシーポリシー</a>をご覧ください。<br><a href="/about.html">運営者情報</a></p>
</div>
{FAV_JS}{NAV_JS.replace("__MY_TOBAN__", prof['touban'])}</body>
</html>"""


def main():
    fan_master = load_fan_master()
    players_k, NAT_PCT, by_venue, by_player, tenji_labels = load_k_stats()
    both = sorted(set(fan_master) & set(players_k))

    os.makedirs(OUT_DIR, exist_ok=True)
    n_ok = 0
    n_err = 0
    written = []
    index_rows = []
    for t in both:
        try:
            fp = fan_master[t]; kp = players_k[t]
            prof = build_profile(t, fp, kp, NAT_PCT, by_venue, by_player,
                                  venue_today=None, day_today=None, today_iso=TODAY_ISO,
                                  tenji_label=tenji_labels.get(t))
            html = render_page(prof)
            with open(os.path.join(OUT_DIR, f"{t}.html"), "w", encoding="utf-8") as f:
                f.write(html)
            n_ok += 1
            written.append(t)
            # 選手一覧ページ用の軽量インデックス。ここで既に持っている値を積むだけ
            # (build_profiles_v5.py側の変更は不要)。平均STはfan側(半年公式集計・
            # 欠損なし)を使う。カナは名前順(五十音)ソートのためだけに持たせる。
            # 出走回数0の選手は平均STが実測ではなくダミーの0.0になっている
            # (win1がNoneになるのと同じ原因)ため、STも同様にNone扱いにする
            # (そうしないと「まだ走っていない選手」がST最速としてソート上位に来てしまう)。
            has_starts = fp.get("出走回数", 0) > 0
            index_rows.append({
                "t": t, "name": fp["氏名"], "kana": fp["カナ"], "k": fp["級別"], "br": fp["支部"],
                "age": fp["年齢"], "nw": fp["勝率"], "st": fp["平均ST"] if has_starts else None,
                "catch": prof["catch"], "win1": prof["top_rates"]["win1"],
                # 展示タイムの安定度(会場差補正済み、"stable"/"volatile"/無し)。
                # 速さ・強さの指標ではなく、あくまでブレ方の事実提示。ソート軸には使わない。
                "tj": prof["tenji_label"],
            })
        except Exception as e:
            n_err += 1
            print(f"[error] 登番{t}: {e}")

    # players/{登番}.html が実際に書けた登番の一覧を index.html 側へ渡す。
    # 生成できたページと完全に同じ集合(written)から作るので、このスクリプトを
    # 再実行するたびに players/ の中身と players_index.js が必ず一致する。
    with open("players_index.js", "w", encoding="utf-8") as f:
        f.write("window.PLAYER_PAGES = " + json.dumps(sorted(written)) + ";\n")

    # 選手一覧(検索・絞り込み・ソート)ページ用のインデックス。written(=players_index.js)と
    # 完全に同じ集合から作るので、両者は常に一致する。
    index_rows.sort(key=lambda r: r["t"])
    with open("players_list.js", "w", encoding="utf-8") as f:
        f.write("window.PLAYER_LIST = " + json.dumps(index_rows, ensure_ascii=False) + ";\n")

    n_urls = build_sitemap(sorted(written))

    print(f"[done] 生成完了: {n_ok}人 (エラー: {n_err}人) → {OUT_DIR}/ ディレクトリ、players_index.js、players_list.js、sitemap.xml({n_urls}URL)")

if __name__ == "__main__":
    main()
