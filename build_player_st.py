#!/usr/bin/env python3
# results.jsonl から選手（登番）別の平均ST・全国3着以内率を集計して players.js を作る
# 出力: window.PLAYERS = { "登番": {"st":平均ST, "n":ST本数, "p3":全国3着以内率(%), "p3n":集計本数}, ... }
import json, statistics, datetime

SRC = "results.jsonl"
OUT = "players.js"
MIN_RACES = 8   # ST癖はこれ未満だと「癖」と呼べないので除外(3着以内率は別基準、表示側で判定)

def main():
    st = {}
    p3 = {}   # 登番 -> [本数, 3着以内本数]  (開始種別を問わず、着順があるレース全てが対象)
    try:
        with open(SRC, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                d = json.loads(line)
                for x in d.get("結果", []):
                    touban = x["登番"]
                    chaku = x.get("着")
                    if chaku is not None:
                        n, hit = p3.get(touban, (0, 0))
                        p3[touban] = (n + 1, hit + (1 if chaku <= 3 else 0))
                    # ST癖は通常スタートのみ（フライング等STt付き・欠測は除外）
                    if x.get("STt", "") == "" and x.get("ST") is not None:
                        st.setdefault(touban, []).append(x["ST"])
    except FileNotFoundError:
        print(f"[skip] {SRC} が無いので players.js は作りません")
        return

    players = {}
    for touban in set(st) | set(p3):
        rec = {}
        vals = st.get(touban)
        if vals and len(vals) >= MIN_RACES:
            rec["st"] = round(statistics.mean(vals), 3)
            rec["n"] = len(vals)
        n, hit = p3.get(touban, (0, 0))
        if n:
            rec["p3"] = round(hit / n * 100, 1)
            rec["p3n"] = n
        if rec:
            players[touban] = rec

    today = datetime.date.today().isoformat()
    payload = {"updated": today, "min": MIN_RACES, "players": players}
    js = "window.PLAYERS = " + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n"
    open(OUT, "w", encoding="utf-8").write(js)
    print(f"[done] players.js 更新: {len(players)}選手（ST癖は{MIN_RACES}走以上、3着以内率は全員ぶん）")

if __name__ == "__main__":
    main()
