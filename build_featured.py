# -*- coding: utf-8 -*-
"""
毎朝、今日出走する選手の中から「今日の注目選手」を1人選び、featured.js に書き出す。
fetch_update.py が作った当日のdata.jsと、選手図鑑と同じ fan+K のプロフィール(build_profiles_v5)を
組み合わせて選ぶ。daily.ymlでfetch_update.pyの直後に実行する前提。

選び方(優先順位):
  1) 今日、自分の「当地(得意会場)」で走る選手。複数いれば当地の際立ち(diff pt)が最大の人。
  2) 該当者がいなければ、二つ名の際立ちが最も強い人(「〜の主」＞「絶対的な/鉄板の」＞…)。
  3) 同点はその日の日付をシードにした固定ハッシュ順で1人に決める(1日の中では常に同じ人になる)。

リンク切れを作らないため、players_index.js(実際にplayers/{登番}.htmlがある登番の一覧)に
載っている選手だけを候補にする。
"""
import json, re, hashlib
from build_profiles_v5 import load_fan_master, load_k_stats, build_profile, MIN_DIFF

DATA_JS = "data.js"
PLAYERS_INDEX_JS = "players_index.js"
OUT = "featured.js"


def load_json_assignment(path):
    with open(path, encoding="utf-8") as f:
        s = f.read()
    m = re.search(r"=\s*([\[{].*[\]}])\s*;?\s*$", s, re.S)
    return json.loads(m.group(1))


def today_races_by_player(data):
    """登番 -> {"venue":会場名, "races":[レース番号,...]} (今日出走する選手ぶんだけ)"""
    out = {}
    for v in data["venues"]:
        for r in v["races"]:
            for b in r["boats"]:
                t = b["t"]
                if t not in out:
                    out[t] = {"venue": v["name"], "races": []}
                out[t]["races"].append(r["no"])
    return out


def date_iso_from_label(label):
    m = re.match(r"(\d+)年(\d+)月(\d+)日", label)
    y, mo, d = m.groups()
    return f"{int(y):04d}-{int(mo):02d}-{int(d):02d}"


def tie_seed(date_iso, toban):
    return hashlib.sha256(f"{date_iso}:{toban}".encode()).hexdigest()


def highlight_rank(prof):
    """際立ちの強さを比較可能なタプルで返す(大きいほど際立つ)。「〜の主」>決まり手系>堅実>蓄積中。"""
    if prof.get("home_master"):
        return (3, prof["home"]["diff"])
    bd = prof.get("best_diff")
    if bd is None:
        return (-1, 0)
    if bd < MIN_DIFF:
        return (0, bd)
    return (1, bd)


def main():
    data = load_json_assignment(DATA_JS)
    date_iso = date_iso_from_label(data["date"])
    today = today_races_by_player(data)

    has_page = set(load_json_assignment(PLAYERS_INDEX_JS))
    candidates_t = [t for t in today if t in has_page]
    if not candidates_t:
        print("[skip] 今日出走する選手の中にページ持ちが0人。featured.jsは更新しない。")
        return

    fan_master = load_fan_master()
    # tenji_labels(展示タイムの安定度)はトップの注目選手枠では使わないが、受け取らないと
    # 「戻り値の数が合わない」で落ちる。実際これに気づかず45日間失敗し続けた
    # (2026-07-13〜08-26)ので、使わなくても必ず受けること。
    players_k, NAT_PCT, by_venue, by_player, tenji_labels = load_k_stats()

    profiles = {}
    for t in candidates_t:
        fp = fan_master.get(t)
        kp = players_k.get(t)
        if not fp or not kp:
            continue
        profiles[t] = build_profile(t, fp, kp, NAT_PCT, by_venue, by_player)
    if not profiles:
        print("[skip] プロフィールを作れる選手が0人。featured.jsは更新しない。")
        return

    # 優先1: 今日、自分の当地で走る選手
    home_today = [t for t, p in profiles.items()
                  if p["home"] and p["home"]["venue"] == today[t]["venue"]]
    if home_today:
        chosen_t = sorted(home_today, key=lambda t: (-profiles[t]["home"]["diff"], tie_seed(date_iso, t)))[0]
        reason_kind = "home"
    else:
        # 優先2: 二つ名の際立ちが最も強い選手
        chosen_t = sorted(profiles, key=lambda t: (highlight_rank(profiles[t]), tie_seed(date_iso, t)), reverse=True)[0]
        reason_kind = "kimarite"

    prof = profiles[chosen_t]
    fp = prof["profile"]
    races = sorted(set(today[chosen_t]["races"]))

    featured = {
        "date": date_iso,
        "toban": chosen_t,
        "name": fp["氏名"],
        "k": fp["級別"],
        "age": fp.get("年齢"),
        "br": fp.get("支部"),
        "catch": prof["catch"],
        "basis": prof["catch_basis"],
        "venue": today[chosen_t]["venue"],
        "races": races,
        "reason": reason_kind,
    }
    with open(OUT, "w", encoding="utf-8") as f:
        f.write("window.FEATURED = " + json.dumps(featured, ensure_ascii=False) + ";\n")
    print(f"[done] 今日の注目選手: {fp['氏名']}({chosen_t}) @ {featured['venue']} / 理由:{reason_kind} → {OUT}")


if __name__ == "__main__":
    # 想定外のエラーでこのスクリプトが落ちても、daily.ymlの本丸であるdata.js更新の
    # コミット・pushまで止めたくないので、ここで受け止めて正常終了する
    # (featured.jsは更新されず、前日ぶんが残るだけで済む)。
    try:
        main()
    except Exception as e:
        print(f"[warn] 注目選手の選出に失敗、featured.jsは更新しない: {e}")
