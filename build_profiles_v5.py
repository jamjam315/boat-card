# -*- coding: utf-8 -*-
"""
選手図鑑・本実装v5: fan(全選手・母数厚い公式集計)とK(直近1年・自前蓄積)を統合する。
- 進入コース傾向・基本属性 → fan(コース別1〜6着回数、勝率等)を優先して使う。
- 決まり手・当地(会場別) → fanには無いため、引き続きK(results/{年}.jsonl)から算出。
  期間は「データの最新日から365日前まで」(load_k_stats のコメント参照)。
- 今節/直近の流れ → 既存のfetch_update.py(player_flow)ロジックをそのまま流用。
"""
import json, os, statistics, datetime
from collections import Counter, defaultdict
import results_store

# リポジトリのチェックアウト先がどこでも(ローカルWindows・GitHub ActionsのUbuntu等)
# fan2604.jsonをこのファイルと同じディレクトリから読めるようにする。
# results/{年}.jsonlはresults_store経由(こちらも同じ考え方でモジュール基準の絶対パス)。
CLONE = os.path.dirname(os.path.abspath(__file__))

MIN_WIN_N = 3
MIN_DIFF = 10
NAT_ST = 0.161
ST_FAST_DIFF = -0.025
YOUNG_AGE = 24
VETERAN_AGE = 55
MIN_VENUE_N = 10
MIN_OTHER_N = 5
VENUE_DIFF_MIN = 20
VENUE_MASTER_WIN = 50
VENUE_MASTER_DIFF = 45
MIN_TENJI_N = 30  # 展示タイムの安定度を出すのに必要な最低サンプル数(会場補正後の残差の件数)
KIMARITE_ORDER = ["逃げ", "まくり", "差し", "まくり差し", "抜き"]

BASE_NOUN = {
    ("逃げ","イン"): "イン逃げ屋", ("逃げ","センター"): "逃げ切り屋", ("逃げ","アウト"): "アウト粘りの逃げ屋", ("逃げ","自在"): "逃げ切り屋",
    ("まくり","イン"): "イン穴あけ屋", ("まくり","センター"): "まくり十八番", ("まくり","アウト"): "一発まくり屋", ("まくり","自在"): "まくり自在の遣い手",
    ("差し","イン"): "イン粘りの差し屋", ("差し","センター"): "差し屋", ("差し","アウト"): "外差しの名手", ("差し","自在"): "差し自在の遣い手",
    ("まくり差し","イン"): "イン差し込み屋", ("まくり差し","センター"): "差し込み屋", ("まくり差し","アウト"): "外から差し切る職人", ("まくり差し","自在"): "差し込み自在の遣い手",
    ("抜き","イン"): "イン強襲の抜き屋", ("抜き","センター"): "隙を突く抜き屋", ("抜き","アウト"): "外抜きの一撃", ("抜き","自在"): "抜き自在の遣い手",
}


def load_fan_master():
    fan = json.load(open(f"{CLONE}/fan2604.json", encoding="utf-8"))
    return {p["登番"]: p for p in fan}


def compute_tenji_labels(venue_tenji, player_venue_tenji):
    """展示タイム(K)から、会場差を補正した選手ごとの安定度(ばらつき)を3段階の
    型ラベルに変換する。

    平均(速さ)は出さない：調査の結果、会場ごとの平均展示タイムの差(蒲郡6.71秒〜
    徳山6.96秒)が選手間の実質差よりずっと大きく、会場差を補正してもなお
    「選手内のブレ」が「選手間の差」の約3倍あり(stdev比較で0.088 vs 0.028)、
    単純な平均は会場差・ノイズに埋もれて誤解を招くため扱わない。

    安定度(ばらつきの少なさ)は出す：各展示タイムからその会場の全選手平均を
    引いた残差を選手ごとに集め、その標準偏差を「会場差を除いた選手固有の
    ブレ」として使う。この値は選手間で意味のある差がある(調査でp10〜p90が
    約1.5倍の開き)。

    閾値は毎回の実データの分布(下位/上位1/3、tertile)から動的に算出する。
    進入傾向のときのように固定の閾値を一度決めてしまうと、後で実態と
    合わなくなる(大半が該当しない/しすぎる)恐れがあるため、都度の分布から
    決め直すことでその失敗を避ける。中間の1/3は「特に際立たない」として
    ラベルを付けない(断定・過剰な情報を避ける、当地初と同じ考え方)。

    30件未満(MIN_TENJI_N)の選手は判定不能として扱う(何も返さない)。
    速さ・強さの指標ではなく、あくまで展示タイムのブレ方についての
    事実提示にとどめる。
    """
    venue_mean = {v: statistics.mean(vals) for v, vals in venue_tenji.items() if vals}
    player_sd = {}
    for touban, vv in player_venue_tenji.items():
        resids = [val - venue_mean[venue] for venue, vals in vv.items() for val in vals]
        if len(resids) >= MIN_TENJI_N:
            player_sd[touban] = statistics.stdev(resids)
    if not player_sd:
        return {}
    vals_sorted = sorted(player_sd.values())
    n = len(vals_sorted)
    lo_cut = vals_sorted[n // 3]
    hi_cut = vals_sorted[(2 * n) // 3]
    labels = {}
    for touban, sd in player_sd.items():
        if sd <= lo_cut:
            labels[touban] = "stable"
        elif sd >= hi_cut:
            labels[touban] = "volatile"
        # 中間(lo_cut < sd < hi_cut)はラベル無し
    return labels


def load_k_stats():
    """results/{年}.jsonl(K。2026-07-19に単一のresults.jsonlから年別に分割)から、
    選手ごとの決まり手・会場別成績・進入コース1着分布、
    および展示タイムの安定度(会場差補正済み)を集計する。

    【直近1年に絞る理由(2026-08-27)】
    build_stats.py / build_backtest.py / build_player_st.py と同じ経緯。2026-07-20〜24の
    過去データ拡張でresultsが約1年分から約10年分に増えたが、この3本が同日に入れた
    「直近1年」絞りに、このファイルだけ追随していなかった。結果、選手ページは
    「直近1年・勝ち◯件の内訳です」と名乗りながら10年分を集計していた。
    期間の定義・実装は3本と同一の「データの最新日から365日前まで」に揃える。"""
    rows = results_store.load_all_records()
    latest = datetime.date.fromisoformat(max(r["date"] for r in rows))
    cutoff = (latest - datetime.timedelta(days=365)).isoformat()
    nat_kimarite = Counter()
    players = defaultdict(lambda: {"kwin": Counter(), "sts": [], "venue": defaultdict(lambda: {"n":0,"w1":0})})
    by_venue = defaultdict(list)   # (登番,会場) -> [(date,race_no,進,ST,着), ...]  (今節用)
    by_player = defaultdict(list)  # 登番 -> [(date,会場,race_no,進,ST,着), ...]     (直近用)
    venue_tenji = defaultdict(list)                       # 会場 -> [展,...]  (会場平均を出すため全選手ぶん)
    player_venue_tenji = defaultdict(lambda: defaultdict(list))  # 登番 -> 会場 -> [展,...]
    for r in rows:
        if r["date"] < cutoff:
            continue
        for x in r["結果"]:
            p = players[x["登番"]]
            v = p["venue"][r["会場"]]
            v["n"] += 1
            if x.get("ST") is not None:
                p["sts"].append(x["ST"])
            tenji = x.get("展")
            if tenji is not None:
                venue_tenji[r["会場"]].append(tenji)
                player_venue_tenji[x["登番"]][r["会場"]].append(tenji)
            by_venue[(x["登番"], r["会場"])].append((r["date"], r["レース番号"], x["進"], x.get("ST"), x["着"]))
            by_player[x["登番"]].append((r["date"], r["会場"], r["レース番号"], x["進"], x.get("ST"), x["着"]))
            if x["着"] == 1:
                v["w1"] += 1
                if r.get("決まり手"):
                    p["kwin"][r["決まり手"]] += 1
                    nat_kimarite[r["決まり手"]] += 1
    for k in by_venue: by_venue[k].sort()
    for k in by_player: by_player[k].sort()
    nat_total = sum(nat_kimarite.values())
    NAT_PCT = {k: nat_kimarite.get(k, 0) / nat_total * 100 for k in KIMARITE_ORDER}
    tenji_labels = compute_tenji_labels(venue_tenji, player_venue_tenji)
    return players, NAT_PCT, by_venue, by_player, tenji_labels


def home_venue(p_k):
    venues = p_k["venue"]
    total_n = sum(v["n"] for v in venues.values())
    total_w1 = sum(v["w1"] for v in venues.values())
    if total_n < 20:
        return None
    best = None
    for vname, s in venues.items():
        if s["n"] < MIN_VENUE_N: continue
        other_n = total_n - s["n"]; other_w1 = total_w1 - s["w1"]
        if other_n < MIN_OTHER_N: continue
        win = s["w1"] / s["n"] * 100
        other_win = other_w1 / other_n * 100
        diff = win - other_win
        if diff < VENUE_DIFF_MIN: continue
        if best is None or diff > best["diff"]:
            best = {"venue": vname, "n": s["n"], "win": win, "other_win": other_win, "diff": diff}
    return best


def top_rates_from_fan(fan_p):
    """コース別のchaku配列(1〜3着の内訳)を6コース分合計し、fan(直近半年)基準の
    1着率・3着以内率を算出する。分母はコース別nの合計ではなくトップレベルの出走回数を使う
    (コース別n合計は事故欠場等で稀に本来より少なく、出走回数の方が正確なため)。"""
    n = fan_p.get("出走回数", 0)
    if not n:
        return {"n": 0, "win1_n": 0, "win1": None, "p3_n": 0, "p3": None}
    c0 = c1 = c2 = 0
    for d in fan_p["コース別"].values():
        chaku = d.get("chaku")
        if not chaku: continue
        c0 += chaku[0]; c1 += chaku[1]; c2 += chaku[2]
    p3_n = c0 + c1 + c2
    return {"n": n, "win1_n": c0, "win1": round(c0 / n * 100, 1), "p3_n": p3_n, "p3": round(p3_n / n * 100, 1)}


def course_tag_from_fan(course_data):
    """fanのコース別1着回数から「1着を取った時の進入コース」の分布を再現し、自在さを判定する。"""
    win_courses = []
    for c_str, d in course_data.items():
        chaku = d.get("chaku")
        if chaku:
            win_courses += [int(c_str)] * chaku[0]
    if not win_courses:
        return "イン", None, 0
    avg_c = statistics.mean(win_courses)
    sd_c = statistics.pstdev(win_courses) if len(win_courses) > 1 else 0
    if sd_c >= 1.5:
        return "自在", avg_c, sd_c
    if avg_c <= 1.8: return "イン", avg_c, sd_c
    if avg_c <= 3.5: return "センター", avg_c, sd_c
    return "アウト", avg_c, sd_c


def kon_setsu_flow(by_venue, by_player, touban, venue, day, today_iso):
    which = "今節"
    rows = []
    if day:
        import datetime
        today_d = datetime.date.fromisoformat(today_iso)
        first_day = (today_d - datetime.timedelta(days=day - 1)).isoformat()
        rows = [rec for rec in by_venue.get((touban, venue), []) if first_day <= rec[0] < today_iso]
    if len(rows) < 2:
        which = "直近"
        import datetime
        today_d = datetime.date.fromisoformat(today_iso)
        start = (today_d - datetime.timedelta(days=30)).isoformat()
        rows = [rec[0:1] + rec[2:] for rec in by_player.get(touban, []) if start <= rec[0] < today_iso]
    return {"which": which, "c": [r[2] for r in rows], "s": [r[3] for r in rows], "r": [r[4] for r in rows]}


def build_profile(touban, fan_p, k_p, NAT_PCT, by_venue, by_player, venue_today=None, day_today=None, today_iso=None, tenji_label=None):
    """fan(属性・コース傾向) + K(決まり手・当地・今節/直近) を統合した選手プロフィールを作る。"""
    total_wins = sum(k_p["kwin"].values()) if k_p else 0
    kimarite_pct = {k: round(k_p["kwin"].get(k,0)/total_wins*100,1) if total_wins else None for k in KIMARITE_ORDER} if k_p else {k:None for k in KIMARITE_ORDER}
    kimarite_diff = {k: (kimarite_pct[k] - NAT_PCT[k]) if kimarite_pct[k] is not None else None for k in KIMARITE_ORDER}
    avg_st = statistics.mean(k_p["sts"]) if k_p and k_p["sts"] else None
    st_diff = (avg_st - NAT_ST) if avg_st is not None else None
    age = fan_p.get("年齢")
    home = home_venue(k_p) if k_p else None

    catch = None
    basis_parts = []
    if total_wins < MIN_WIN_N:
        catch = f"まだ色が見えません（勝ち{total_wins}件・蓄積中）"
    else:
        ctag, avg_c, sd_c = course_tag_from_fan(fan_p["コース別"])
        valid_diffs = {k: v for k, v in kimarite_diff.items() if v is not None}
        best_k = max(valid_diffs, key=valid_diffs.get)
        best_diff = valid_diffs[best_k]
        base = BASE_NOUN.get((best_k, ctag), f"{ctag}×{best_k}タイプ") if best_diff >= MIN_DIFF else "堅実タイプ"

        if home:
            if home["win"] >= VENUE_MASTER_WIN and home["diff"] >= VENUE_MASTER_DIFF:
                venue_form = f"{home['venue']}の主"
                why = f"{home['venue']}で圧倒的な強さを見せているため"
            elif best_diff < MIN_DIFF:
                # 決まり手に際立った個性が無い場合は、決まり手名詞を組み込まず地名だけで表現する
                venue_form = f"{home['venue']}巧者"
                why = f"{home['venue']}で際立って好成績のため"
            else:
                venue_form = f"{home['venue']}の{base}"
                why = f"{home['venue']}で際立って好成績、かつ「{best_k}」が持ち味のため"
            age_tag = ("若き" if age and age <= YOUNG_AGE else "ベテランの" if age and age >= VETERAN_AGE else None)
            catch = (age_tag or "") + venue_form
            # 詳しい数字は下部の「当地」欄に集約する。ここでは「なぜこの二つ名か」だけ短く伝える。
            basis_parts.append(f"{why}（詳しくは下の「当地」欄）")
            if age_tag: basis_parts.append(f"{age}歳")
        elif best_diff < MIN_DIFF:
            catch = "堅実タイプ（勝ちパターンは平均的）"
            basis_parts.append(f"決まり手の傾向が全国平均に近い（{best_k}{kimarite_pct[best_k]}% / 全国{NAT_PCT[best_k]:.1f}%）")
        else:
            prefix = "絶対的な" if best_diff >= 40 else ("鉄板の" if best_diff >= 25 else None)
            st_tag = "電光石火の" if (avg_st is not None and len(k_p["sts"]) >= 10 and st_diff <= ST_FAST_DIFF) else None
            age_tag = ("若き" if age and age <= YOUNG_AGE else "ベテランの" if age and age >= VETERAN_AGE else None)
            mods = []
            if st_tag: mods.append(st_tag)
            elif prefix: mods.append(prefix)
            if age_tag: mods.append(age_tag)
            catch = "".join(mods[:2]) + base
            basis_parts.append(f"{best_k}での1着が{kimarite_pct[best_k]}%（全国平均{NAT_PCT[best_k]:.1f}%より+{best_diff:.1f}pt）")
            if st_tag: basis_parts.append(f"平均ST{avg_st:.3f}（全国平均{NAT_ST}より{st_diff:+.3f}）")
            if age_tag: basis_parts.append(f"{age}歳")

    # 進入コース傾向(fanベース、表示用)
    course_out = {}
    for c_str, d in fan_p["コース別"].items():
        n = d.get("n"); chaku = d.get("chaku")
        if n and chaku:
            course_out[int(c_str)] = {"n": n, "win": round(chaku[0]/n*100,1), "p2": round(sum(chaku[:2])/n*100,1)}

    # venue_today/day_todayが無い(今日出走しない選手)場合も、today_isoさえあれば
    # kon_setsu_flow内部で「今節無し→直近」に自動フォールバックする。
    ks = None
    if today_iso:
        ks = kon_setsu_flow(by_venue, by_player, touban, venue_today, day_today, today_iso)

    return {
        "touban": touban, "profile": fan_p, "catch": catch, "catch_basis": "。".join(basis_parts),
        "course": course_out, "kimarite_pct": kimarite_pct, "kimarite_total_wins": total_wins,
        "home": home, "ks": ks, "top_rates": top_rates_from_fan(fan_p), "tenji_label": tenji_label,
        # 二つ名の「際立ちの強さ」を他選手と比較するための値(トップページの注目選手選びで使う)。
        # best_diffは決まり手が全国平均よりどれだけ際立つか(pt)。total_wins<MIN_WIN_Nの時はNone(蓄積中)。
        "best_diff": best_diff if total_wins >= MIN_WIN_N else None,
        "home_master": bool(home and home["win"] >= VENUE_MASTER_WIN and home["diff"] >= VENUE_MASTER_DIFF),
    }
