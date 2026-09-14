# -*- coding: utf-8 -*-
"""
殿堂の称号の週次投稿を、過去の週で再現して文面を確かめる。投稿も書き込みもしない。

  python scripts/x_title_replay.py [--weeks 8]

【なぜ別スクリプトか】
本番の x_title_watch.py は titles.json を読むだけで軽い。過去の週を作るには
全期間のレースを流し直して称号を計算する必要があり、重い依存
(build_player_career の集計)を持ち込む。本番に混ぜないために分けた。

判定と文面は x_title_watch の decide() をそのまま呼ぶので、ここで出た文面は
本番で出る文面と同じものになる(再現用に別の文面を書かない)。

【再現の仕方】
称号の集計は全期間の累積で日付の絞りが無い。Tally は足すだけなので、
レコードを時系列で流しながら各週の時点で compute_titles() を呼ぶ。

【本番との違い】
  - 選手名・級別は今の fan2604.json から引く(その週の級別ではない)
  - 対象(現役)は今の選手ページのある登番。当時の現役とはわずかにずれうる
  - 日付は各週の時点(本番は投稿した日)
"""
import argparse
import collections
import datetime
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, REPO)
sys.stdout.reconfigure(encoding="utf-8")

import results_store
import build_player_career as C
import x_title_watch as W


def load_people():
    with open(os.path.join(REPO, "fan2604.json"), encoding="utf-8") as f:
        fan = json.load(f)
    return {p["登番"]: (p["氏名"], p.get("級別")) for p in fan}


def to_snapshot(rosters, guardians, children, people):
    """compute_titles() の返り値を、W.snapshot() と同じ形にする。"""
    def h(c, rank):
        name, klass = people.get(c["toban"], (c["toban"], None))
        return {"toban": str(c["toban"]), "name": name, "class": klass,
                "metric": c["metric"], "n": c["n"], "rank": rank}
    ranked = {t: [h(c, i + 1) for i, c in enumerate(r)] for t, r in rosters.items()}
    venue = {}
    for src, suffix in ((guardians, "の守護神"), (children, "の申し子")):
        for v, c in src.items():
            venue[v + suffix] = h(c, 1) if c else None
    return {"ranked": ranked, "venue": venue}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--weeks", type=int, default=8)
    a = ap.parse_args()

    people = load_people()
    active = C.active_tobans()
    desc = (W.load_json(W.DESC_PATH, {}) or {}).get("desc", {})

    # 最終日を先に知る(1回流すだけで9秒ほど)。
    last = None
    for r in results_store.iter_records():
        last = r["date"]
    d0 = datetime.date.fromisoformat(last)
    points = [(d0 - datetime.timedelta(days=7 * i)).isoformat() for i in range(a.weeks, -1, -1)]
    print(f"再現する週: {points[0]} 〜 {points[-1]}（{len(points) - 1}週ぶん）\n")

    ways = collections.defaultdict(C.Tally)
    national = C.Tally()
    snaps = []
    i = 0
    for r in results_store.iter_records():
        while i < len(points) and r["date"] > points[i]:
            ro, gu, ch, _ = C.compute_titles(ways, national, active)
            snaps.append((points[i], to_snapshot(ro, gu, ch, people)))
            i += 1
        for b in r["結果"]:
            ways[b["登番"]].add(r, b)
            national.add(r, b)
    while i < len(points):
        ro, gu, ch, _ = C.compute_titles(ways, national, active)
        snaps.append((points[i], to_snapshot(ro, gu, ch, people)))
        i += 1

    counts = collections.Counter()
    # 状態は本番と同じく週ごとに引き継ぐ(トップ10の記憶を効かせるため)。
    state = W.state_of(snaps[0][1], None, snaps[0][0])
    for k in range(1, len(snaps)):
        date_iso, cur = snaps[k]
        kind, text, reply = W.decide(state, cur, date_iso, desc)
        state = W.state_of(cur, state, date_iso)
        counts[kind or "none"] += 1
        print("=" * 60)
        print(f"■ {date_iso} の週  →  {kind or '投稿しない'}")
        print("=" * 60)
        if not kind:
            print(text + "\n")
            continue
        print(text)
        print(f"  （本文 {W.x_post.weighted_len(text)}/{W.x_post.MAX_WEIGHTED}）")
        print("  ── リプ ──")
        print("  " + reply)
        print()

    print("■ 内訳:", dict(counts))


if __name__ == "__main__":
    main()
