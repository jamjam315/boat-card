# -*- coding: utf-8 -*-
"""
選手図鑑・全選手ページ生成。
fan(コース傾向・属性・母数厚い公式集計) + K(決まり手・当地・今の調子、直近1年)を統合し、
選手ごとに静的HTMLを1枚(players/{登番}.html)生成する。

【今回の範囲】ページ生成のみ。トップページ・レースカードからのリンク、URL構造の変更はしない
(このスクリプトは既存サイトのどこからも参照されない、独立した出力)。
"""
import os, json, statistics
from build_profiles_v5 import load_fan_master, load_k_stats, build_profile

OUT_DIR = "players"
TODAY_ISO = "2026-07-05"   # 生成基準日(直近30日の起点として使う)
KIMARITE_ORDER = ["逃げ", "まくり", "差し", "まくり差し", "抜き"]
LANE_COLORS = {1:"#ffffff",2:"#2b2b2b",3:"#d83a36",4:"#2f6fd0",5:"#f2c200",6:"#1f9e54"}

CSS = """
:root{
  --bg:#eef0ec; --surface:#ffffff; --ink:#13242a; --ink2:#4a5a61; --muted:#7c8a90;
  --line:#e2e5e0; --line2:#d3d8d2; --water:#0f2a33; --accent:#0e7c66; --accent-soft:#dff0ea;
  --radius:14px;
}
@media (prefers-color-scheme: dark){
  :root{ --bg:#10171a; --surface:#182226; --ink:#eef3f2; --ink2:#aebcc0; --muted:#7e8d92;
    --line:#243136; --line2:#2e3d43; --water:#0a1b20; --accent:#3bbf9e; --accent-soft:#16302a; }
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
.foot{margin-top:20px; padding:14px 4px 0; border-top:1px solid var(--line); color:var(--muted); font-size:11.5px;}
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
    el.innerHTML = dir === "prev" ? (arrow+lane+name) : (lane+name+arrow);
  }
  fill(document.getElementById("heroPrev"), prev, "prev");
  fill(document.getElementById("heroNext"), next, "next");

  var startX = null;
  document.addEventListener("touchstart", function(e){ startX = e.touches[0].clientX; }, {passive:true});
  document.addEventListener("touchend", function(e){
    if(startX === null) return;
    var dx = e.changedTouches[0].clientX - startX;
    startX = null;
    if(Math.abs(dx) < 60) return;
    var target = dx < 0 ? document.getElementById("heroNext") : document.getElementById("heroPrev");
    if(target && target.getAttribute("href")) window.location.href = target.getAttribute("href");
  }, {passive:true});
})();
</script>
"""


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
    avgc = sum(ks["c"]) / len(ks["c"])
    course_hint = "進入ほぼイン" if avgc <= 1.6 else ("進入は外めが多い" if avgc >= 4 else "進入まちまち")
    sts = [s for s in ks["s"] if s is not None]
    st_hint = ""
    if len(sts) >= 2:
        avg_s = sum(sts) / len(sts)
        sd = (sum((s - avg_s) ** 2 for s in sts) / len(sts)) ** 0.5
        st_hint = " / ST安定" if sd <= 0.02 else " / STにばらつき"
    tail = f'<span style="color:var(--muted);font-style:italic;">（{label}{n}走）</span>' if n < 10 else ""
    return f'<div class="kon"><b>{label}</b> {flow_str} / {course_hint}{st_hint} {tail}</div>'


def render_page(prof):
    fp = prof["profile"]
    return f"""<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{fp['氏名']} — 艇読み 選手図鑑</title>
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
      <div class="pname">{fp['氏名']} <span style="font-weight:400;font-size:13px;color:var(--ink2);">{fp['級別']}</span></div>
      <div class="pmeta">{fp['年齢']}歳 ・ {fp['支部']}支部 ・ {fp['体重']}kg</div>
      <div class="catch">「{prof['catch']}」</div>
      <div class="catch-basis">{prof['catch_basis']}</div>
    </div>
    <a class="hero-nav next" id="heroNext" aria-label="次の選手"></a>
  </section>
  <section class="card">
    <div class="card-ttl"><span class="pin"></span>通算の進入コース傾向<span class="card-sub">直近半年(公式集計)</span></div>
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
  <p class="foot"><b>予想印は出していません。</b>通算の進入コース傾向は直近半年の公式集計、決まり手・当地・今の調子は直近1年の結果データを集計しています。母数が少ない項目は薄く表示するか「蓄積中」と明記しています。</p>
</div>
{NAV_JS.replace("__MY_TOBAN__", prof['touban'])}</body>
</html>"""


def main():
    fan_master = load_fan_master()
    players_k, NAT_PCT, by_venue, by_player = load_k_stats()
    both = sorted(set(fan_master) & set(players_k))

    os.makedirs(OUT_DIR, exist_ok=True)
    n_ok = 0
    n_err = 0
    written = []
    for t in both:
        try:
            fp = fan_master[t]; kp = players_k[t]
            prof = build_profile(t, fp, kp, NAT_PCT, by_venue, by_player,
                                  venue_today=None, day_today=None, today_iso=TODAY_ISO)
            html = render_page(prof)
            with open(os.path.join(OUT_DIR, f"{t}.html"), "w", encoding="utf-8") as f:
                f.write(html)
            n_ok += 1
            written.append(t)
        except Exception as e:
            n_err += 1
            print(f"[error] 登番{t}: {e}")

    # players/{登番}.html が実際に書けた登番の一覧を index.html 側へ渡す。
    # 生成できたページと完全に同じ集合(written)から作るので、このスクリプトを
    # 再実行するたびに players/ の中身と players_index.js が必ず一致する。
    with open("players_index.js", "w", encoding="utf-8") as f:
        f.write("window.PLAYER_PAGES = " + json.dumps(sorted(written)) + ";\n")

    print(f"[done] 生成完了: {n_ok}人 (エラー: {n_err}人) → {OUT_DIR}/ ディレクトリ、players_index.js")

if __name__ == "__main__":
    main()
