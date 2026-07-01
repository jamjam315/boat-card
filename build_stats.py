# -*- coding: utf-8 -*-
"""
貯めた results.jsonl から「コース別の傾向」を計算して stats.js を書き出す。
- 全国まとめ（overall）と、会場ごと（venues）の、進入コース別 1着率・2連対率・3連対率・平均ST。
- さらに 会場×天候（晴/曇/雨）ごとの 進入コース別1着率（venues_wx）も出す。
アプリ(index.html)はこの stats.js を読んで v2 表示に使う。
"""
import json, os, datetime, zoneinfo
from collections import defaultdict

JST = zoneinfo.ZoneInfo("Asia/Tokyo")
STORE = "results.jsonl"
WEATHERS = ("晴", "曇", "雨")   # 天候別に集計する対象（雪・霧は数が少ないので当面まとめない）

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

def main():
    if not os.path.exists(STORE):
        print("[stop] results.jsonl が無い。先に collect_results.py を回してください。")
        return
    overall = blank()
    by_venue = defaultdict(blank)
    by_venue_wx = defaultdict(lambda: defaultdict(blank))   # [会場][天候] -> コース別
    seen = set(); dates = set(); races = 0
    for line in open(STORE, encoding="utf-8"):
        try:
            r = json.loads(line)
        except Exception:
            continue
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

    out = {
        "updated": datetime.datetime.now(JST).strftime("%Y-%m-%d"),
        "days": len(dates), "races": races,
        "overall": finalize(overall),
        "venues": {v: finalize(acc) for v, acc in by_venue.items()},
        "venues_wx": {v: {w: finalize_wx(acc) for w, acc in wd.items()}
                      for v, wd in by_venue_wx.items()},
    }
    js = "window.STATS = " + json.dumps(out, ensure_ascii=False, separators=(",", ":")) + ";\n"
    open("stats.js", "w", encoding="utf-8").write(js)
    print(f"[done] stats.js 更新 / {len(dates)}日分 / {races}レース / {len(by_venue)}会場 / 天候別も出力")

if __name__ == "__main__":
    main()
