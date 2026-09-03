# -*- coding: utf-8 -*-
"""
AI講評に渡す「展開連鎖」の素材を renren.json に書き出す。

  python build_renren.py

【何を出すのか】
「1着コース × 決まり手」が決まったとき、2着はどのコースが多いか。
たとえば「3コースがまくり差しで勝った」レースでは、2着は1コースが61%。
この形はレースの決着そのものなので、答案の講評で「実際こうなったとき、
2着はこう来やすい」という事実として使える。

【なぜ全国だけなのか(会場別を採らない理由)】
step0の調査(2026-09-03)で、会場別に切る価値を実測した。会場×1着コース×
決まり手のセルは652あり、n>=300は45%しか残らない。そこまで母数を削って
得られる違いは、全国分布とのズレが中央3.5pt、最頻の2着コースは98%が全国と
同じだった。**母数を1/24にする代償に見合わない。**

そこで全国のn>=1000のセル(22)だけを正とし、会場別は「全国と本当に違う
セル」だけを例外表として持つ。ズレの尺度はTVD(2つの分布の差の合計の半分)で、
8pt以上を例外とする。江戸川・平和島・鳴門の3コースまくり差しのように、
2着1コースが全国61%に対し49%まで落ちるセルがここに入る。

【n<1000を載せない理由】
載せないセルは「例が少ないため言えません」とAIに書かせるための空白でもある。
中途半端な母数の数字を渡すと、AIはそれを根拠として扱ってしまう。渡さなければ
書きようがない。
"""
import io
import json
import statistics
from collections import Counter, defaultdict

import results_store

OUT = "renren.json"

# 全国セルの採用下限。step0で n>=1000 は29セル中22セル(75.9%)。
MIN_N = 1000
# 会場別を例外として載せる下限(母数)と、載せるほど違うかの尺度(TVD・pt)。
MIN_N_VENUE = 300
MIN_TVD = 8.0
# 1セルにつき出す2着コースの数。
TOP = 3


def collect():
    """(1着コース, 決まり手) と (会場, 1着コース, 決まり手) の2着コース分布を数える。"""
    nat = defaultdict(Counter)
    ven = defaultdict(Counter)
    n_race = 0
    for r in results_store.iter_records():
        kimarite = r.get("決まり手")
        if not kimarite:
            continue
        first = second = None
        for x in r["結果"]:
            if x.get("着") == 1:
                first = x.get("進")
            elif x.get("着") == 2:
                second = x.get("進")
        if not first or not second:
            continue
        n_race += 1
        nat[(first, kimarite)][second] += 1
        ven[(r["会場"], first, kimarite)][second] += 1
    return nat, ven, n_race


def top_rows(counter, n):
    """2着コースの上位を [コース, %(小数1桁), 本数] の形にして返す。"""
    rows = []
    for course, k in counter.most_common(TOP):
        rows.append([course, round(k / n * 1000) / 10, k])
    return rows


def tvd(a, an, b, bn):
    """2つの分布の隔たり。0なら同じ、100なら全く重ならない(pt)。"""
    keys = set(a) | set(b)
    return sum(abs(a[k] / an - b[k] / bn) for k in keys) / 2 * 100


def main():
    nat, ven, n_race = collect()

    cells = []
    for (course, kimarite), c in sorted(nat.items()):
        n = sum(c.values())
        if n < MIN_N:
            continue
        cells.append({"c": course, "k": kimarite, "n": n, "top": top_rows(c, n)})

    # 例外表。全国に採用されているセルについてだけ、会場別が本当に違うかを見る。
    have = {(x["c"], x["k"]) for x in cells}
    ex = []
    for (venue, course, kimarite), c in sorted(ven.items()):
        if (course, kimarite) not in have:
            continue
        n = sum(c.values())
        if n < MIN_N_VENUE:
            continue
        nc = nat[(course, kimarite)]
        d = tvd(c, n, nc, sum(nc.values()))
        if d < MIN_TVD:
            continue
        ex.append({"v": venue, "c": course, "k": kimarite, "n": n,
                   "tvd": round(d * 10) / 10, "top": top_rows(c, n)})

    doc = {
        "note": "1着コース×決まり手が決まったとき、2着に来やすい進入コース。"
                "topは[コース, %, 本数]。nはそのセルの母数(レース数)。",
        "min_n": MIN_N,
        "races": n_race,
        "cells": cells,
        "venue_exceptions": ex,
    }
    # generated_at は入れない。中身が同じなら毎日バイト単位で同じものが出て、
    # 変化が無い日はコミットが立たない(payoutsと同じ作法)。
    with io.open(OUT, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")
    size = len(io.open(OUT, encoding="utf-8").read().encode("utf-8"))
    print(f"[done] {OUT}: 全国{len(cells)}セル / 例外{len(ex)}件 / "
          f"{n_race:,}レースから / {size:,}バイト")
    if len(cells) < 15:
        print(f"::warning::展開連鎖のセルが{len(cells)}件しかありません。"
              "データの取り出しに失敗している可能性があります")


if __name__ == "__main__":
    main()
