#!/usr/bin/env python3
# results.jsonl から選手（登番）別の平均STを集計して players.js を作る
# 出力: window.PLAYERS = { "登番": {"st":平均ST, "n":本数}, ... }
import json, statistics, datetime

SRC = "results.jsonl"
OUT = "players.js"
MIN_RACES = 8   # これ未満は「癖」と呼べないので除外

def main():
    st = {}
    try:
        with open(SRC, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                d = json.loads(line)
                for x in d.get("結果", []):
                    # 通常スタートのみ（フライング等STt付き・欠測は除外）
                    if x.get("STt", "") == "" and x.get("ST") is not None:
                        st.setdefault(x["登番"], []).append(x["ST"])
    except FileNotFoundError:
        print(f"[skip] {SRC} が無いので players.js は作りません")
        return

    players = {}
    for toban, vals in st.items():
        if len(vals) >= MIN_RACES:
            players[toban] = {"st": round(statistics.mean(vals), 3), "n": len(vals)}

    today = datetime.date.today().isoformat()
    payload = {"updated": today, "min": MIN_RACES, "players": players}
    js = "window.PLAYERS = " + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n"
    open(OUT, "w", encoding="utf-8").write(js)
    print(f"[done] players.js 更新: {len(players)}選手（{MIN_RACES}走以上）")

if __name__ == "__main__":
    main()
