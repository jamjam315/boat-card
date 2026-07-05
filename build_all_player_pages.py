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
.hero{background:var(--surface); border:1px solid var(--line); border-radius:var(--radius); padding:22px 20px; text-align:center; margin-top:14px;}
.hero .pname{font-size:20px; font-weight:700;} .hero .pmeta{font-size:12.5px; color:var(--ink2); margin-top:3px;}
.hero .catch{font-size:21px; font-weight:800; color:var(--accent); margin-top:14px;}
.hero .catch-basis{font-size:11.5px; color:var(--muted); margin-top:8px; line-height:1.6;}
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
    <div class="pname">{fp['氏名']} <span style="font-weight:400;font-size:13px;color:var(--ink2);">{fp['級別']}</span></div>
    <div class="pmeta">{fp['年齢']}歳 ・ {fp['支部']}支部 ・ {fp['体重']}kg</div>
    <div class="catch">「{prof['catch']}」</div>
    <div class="catch-basis">{prof['catch_basis']}</div>
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
</body>
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
