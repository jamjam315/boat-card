# -*- coding: utf-8 -*-
"""
AI講評に渡す「進入を動かす選手」の素材を maezuke.json に書き出す。

  python build_maezuke.py

【前づけとは何を数えているのか】
枠(艇番)より内側のコースから進入したレースを数える。「艇番≠進入コース」で
数えてはいけない。それだと**他人の前づけで外へ押し出されたレースまで
「進入が動く選手」として数えてしまう**。意味が正反対のものが混ざる。

step0(2026-09-03)の実測では、艇番≠進入で数えると中央11.3%になり、選手の
6割が「進入が動く」ことになった。内訳を分けると、自分から内へ動いたのは
中央3.4%、外へ押し出されたのが中央6.5%だった。ここで数えるのは前者だけ。

【なぜ直近1年なのか】
10年通算で数えると、前づけ率の高い上位は引退した選手で埋まる。step0-bの
実測では、通算で該当した51人のうち29人が直近1年に1走もしていなかった
(上位10人は全員が出走なし)。逆に、通算では20%未満なのに直近1年では該当する
選手が10人いた。**前づけは年々変わる走り方で、通算で固定すると
「いない人を語り、いる人を見落とす」。**

窓は build_profiles_v5.py と同じ「最新日から365日」。二つ名の集計と同じ
期間にそろえておくと、日々の再生成で自動的に追随する。

【載せる線引き】
直近1年で100走以上、かつ前づけ率20%以上(実測32人・全体の2.0%)。
それ以外は載せない。載せなければ、AIは書きようがない。
"""
import datetime
import io
import json
from collections import Counter

import results_store

OUT = "maezuke.json"
WINDOW_DAYS = 365
MIN_RUNS = 100          # 1年の出走数は中央203走なので、100走は「通年走った人」の線
MIN_RATE = 0.20         # 20%以上。step0-bで32人(2.0%)


def main():
    rows = list(results_store.iter_records())
    latest = datetime.date.fromisoformat(max(r["date"] for r in rows))
    cutoff = (latest - datetime.timedelta(days=WINDOW_DAYS)).isoformat()

    runs = Counter()
    inner = Counter()
    for r in rows:
        if r["date"] < cutoff:
            continue
        for x in r["結果"]:
            course = x.get("進")
            lane = x.get("艇")
            if course is None or not (1 <= course <= 6) or not isinstance(lane, int):
                continue
            toban = x["登番"]
            runs[toban] += 1
            if course < lane:          # 枠より内から進入した = 自分から動いた
                inner[toban] += 1

    players = {}
    for toban, n in runs.items():
        if n < MIN_RUNS:
            continue
        rate = inner[toban] / n
        if rate < MIN_RATE:
            continue
        # 率・前づけ本数・出走数。名前は入れない(AIへ渡す経路に選手名を
        # 載せないため。突き合わせは登番で足りる)。
        players[toban] = [round(rate * 1000) / 10, inner[toban], n]

    doc = {
        "note": "直近1年で、枠より内側から進入した割合が高い選手。"
                "値は[前づけ率(%), 前づけ本数, 出走数]。押し出されは含まない。",
        "from": cutoff,
        "to": latest.isoformat(),
        "min_runs": MIN_RUNS,
        "min_rate": round(MIN_RATE * 100),
        "players": players,
    }
    with io.open(OUT, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")
    size = len(io.open(OUT, encoding="utf-8").read().encode("utf-8"))
    print(f"[done] {OUT}: {len(players)}人 / {cutoff}〜{latest} / {size:,}バイト")
    # 0人や極端に多い日は、集計か窓の指定が壊れている。気づけるようにしておく。
    if not 5 <= len(players) <= 120:
        print(f"::warning::前づけの該当者が{len(players)}人でした。"
              "実測では32人前後です。集計を確認してください")


if __name__ == "__main__":
    main()
