#!/usr/bin/env python3
# results/{年}.jsonl から選手（登番）別の平均ST・全国3着以内率を集計して players.js を作る
# 出力: window.PLAYERS = { "登番": {"st":平均ST, "n":ST本数, "p3":全国3着以内率(%), "p3n":集計本数}, ... }
# 2026-07-19に単一のresults.jsonlから年別ファイルへ分割。読み込みはresults_store経由。
#
# 【直近1年に絞る理由(2026-07-20)】build_stats.pyと同じ経緯。このスクリプトも元々
# 期間フィルタが無く、分割で過去2年分が加わったことで翌日の自動実行時に選手のST癖・
# 3着以内率が3年集計へ意図せず変わって本番に出てしまった。build_backtest.py(5a)と
# 同じ「データの最新日から365日前まで」に揃えて元に戻す。
import json, statistics, datetime
import results_store

OUT = "players.js"
MIN_RACES = 8   # ST癖はこれ未満だと「癖」と呼べないので除外(3着以内率は別基準、表示側で判定)

def main():
    st = {}
    p3 = {}   # 登番 -> [本数, 3着以内本数]  (開始種別を問わず、着順があるレース全てが対象)
    if not results_store.exists():
        print("[skip] results/ が無いので players.js は作りません")
        return

    all_records = list(results_store.iter_records())
    if not all_records:
        print("[skip] results/ が空なので players.js は作りません")
        return
    latest = datetime.date.fromisoformat(max(r["date"] for r in all_records))
    cutoff = (latest - datetime.timedelta(days=365)).isoformat()

    for d in all_records:
        if d["date"] < cutoff:
            continue
        for x in d.get("結果", []):
            touban = x["登番"]
            chaku = x.get("着")
            if chaku is not None:
                n, hit = p3.get(touban, (0, 0))
                p3[touban] = (n + 1, hit + (1 if chaku <= 3 else 0))
            # ST癖は通常スタートのみ（フライング等STt付き・欠測は除外）
            if x.get("STt", "") == "" and x.get("ST") is not None:
                st.setdefault(touban, []).append(x["ST"])

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
