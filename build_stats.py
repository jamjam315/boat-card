# -*- coding: utf-8 -*-
"""
貯めた results.jsonl から「コース別の傾向」を計算して stats.js を書き出す。
- 全国まとめ（overall）と、会場ごと（venues）の、進入コース別 1着率・2連対率・3連対率・平均ST。
- 会場×天候（晴/曇/雨）ごとの 進入コース別1着率（venues_wx）。
- 会場ごとの 決まり手内訳（逃げ・差し・まくり・まくり差し・抜き）（venues_kimarite）。
アプリ(index.html)はこの stats.js を読んで v2 表示に使う。
"""
import json, os, datetime, zoneinfo
from collections import defaultdict, Counter
import results_store

JST = zoneinfo.ZoneInfo("Asia/Tokyo")
WEATHERS = ("晴", "曇", "雨")   # 天候別に集計する対象（雪・霧は数が少ないので当面まとめない）
KIMARITE = ("逃げ", "差し", "まくり", "まくり差し", "抜き")

def blank():
    return {c: {"n": 0, "w1": 0, "w2": 0, "w3": 0, "st": 0.0, "stn": 0} for c in range(1, 7)}

def add(acc, course, chaku, st):
    a = acc[course]
    a["n"] += 1
    if chaku == 1: a["w1"] += 1
    if chaku <= 2: a["w2"] += 1
    if chaku <= 3: a["w3"] += 1
    if st is not None:
        a["st"] += st; a["stn"] += 1

def finalize(acc):
    out = {}
    for c, a in acc.items():
        if a["n"] == 0:
            continue
        out[c] = {
            "n": a["n"],
            "win": round(a["w1"] / a["n"] * 100, 1),
            "p2": round(a["w2"] / a["n"] * 100, 1),
            "p3": round(a["w3"] / a["n"] * 100, 1),
            "st": round(a["st"] / a["stn"], 3) if a["stn"] else None,
        }
    return out

def finalize_wx(acc):
    """天候別は表示が軽くなるよう 1着率と本数だけ持つ。"""
    out = {}
    for c, a in acc.items():
        if a["n"] == 0:
            continue
        out[c] = {"win": round(a["w1"] / a["n"] * 100, 1), "n": a["n"]}
    return out

def finalize_kimarite(counter, total):
    """決まり手の内訳を %(小数1桁) にする。既知の5種以外（不明・特殊）は分母に含めるが内訳には出さない。"""
    if total == 0:
        return None
    out = {"n": total}
    for k in KIMARITE:
        out[k] = round(counter.get(k, 0) / total * 100, 1)
    return out

def main():
    if not results_store.exists():
        print("[stop] results/ が無い。先に collect_results.py を回してください。")
        return
    overall = blank()
    by_venue = defaultdict(blank)
    by_venue_wx = defaultdict(lambda: defaultdict(blank))   # [会場][天候] -> コース別
    kimarite_overall = Counter(); kimarite_overall_n = 0
    kimarite_by_venue = defaultdict(Counter)
    kimarite_venue_n = defaultdict(int)
    seen = set(); dates = set(); races = 0
    for r in results_store.iter_records():
        key = f'{r["date"]}:{r["会場"]}:{r["レース番号"]}'
        if key in seen:           # 重複行は無視（再取り込み対策）
            continue
        seen.add(key); dates.add(r["date"]); races += 1
        w = r.get("天候")
        for x in r["結果"]:
            add(overall, x["進"], x["着"], x.get("ST"))
            add(by_venue[r["会場"]], x["進"], x["着"], x.get("ST"))
            if w in WEATHERS:
                add(by_venue_wx[r["会場"]][w], x["進"], x["着"], x.get("ST"))
        k = r.get("決まり手")
        if k:
            kimarite_overall_n += 1
            kimarite_overall[k] += 1
            kimarite_venue_n[r["会場"]] += 1
            kimarite_by_venue[r["会場"]][k] += 1

    out = {
        "updated": datetime.datetime.now(JST).strftime("%Y-%m-%d"),
        "days": len(dates), "races": races,
        "overall": finalize(overall),
        "venues": {v: finalize(acc) for v, acc in by_venue.items()},
        "venues_wx": {v: {w: finalize_wx(acc) for w, acc in wd.items()}
                      for v, wd in by_venue_wx.items()},
        "kimarite_overall": finalize_kimarite(kimarite_overall, kimarite_overall_n),
        "venues_kimarite": {v: finalize_kimarite(kimarite_by_venue[v], kimarite_venue_n[v])
                            for v in by_venue},
    }
    js = "window.STATS = " + json.dumps(out, ensure_ascii=False, separators=(",", ":")) + ";\n"
    open("stats.js", "w", encoding="utf-8").write(js)
    print(f"[done] stats.js 更新 / {len(dates)}日分 / {races}レース / {len(by_venue)}会場 / 天候別・決まり手別も出力")

if __name__ == "__main__":
    main()
