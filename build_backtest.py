# -*- coding: utf-8 -*-
"""
results.jsonl(払戻付き)から、号艇(1〜6)ごとの機械的な買い方3種の
的中率・回収率を集計してbacktest.jsを書き出す。過去こうだったという
事実の集計であり、予想やおすすめではない(艇読みの方針)。

対象は直近1年(データの最新日から365日前まで)。全国まとめに加えて、
会場別(24場)の同じ集計も出す(24場横並び比較表は今回作らず、
1会場ずつ切り替えて見る前提のUI側で使う)。

集計する3つの買い方(いずれも「軸号艇」を1〜6で固定した場合):
  単勝        : 軸号艇の単勝を毎レース100円
  複勝        : 軸号艇の複勝を毎レース100円
  2連単ながし : 軸号艇を1着に固定し、2着を残り5艇へ流す(5点=500円)

払戻が空(返還・特払い等で該当券種の配当が読み取れない)レースは、
賭けはしたが払戻0円として扱う(対象数には含める)。対象レース数の
分母は、その号艇が実際に出走していたレース(結果に艇番が存在する
レース)のみとし、欠場等でその艇が無いレースは分母から除く。
"""
import json, datetime
from parse_results import JCD
import results_store

BOATS = range(1, 7)
VENUE_ORDER = list(JCD.values())   # 桐生〜大村、既存のVENUE_ROMAJIと同じ並び順


def load_races():
    """results/{年}.jsonl を年をまたいで全件読み込む(2026-07-19に単一の
    results.jsonlから分割。読み込み元が変わっただけで、以降のフィルタ・
    集計ロジックは分割前と一切変えていない)。"""
    races, seen = [], set()
    for r in results_store.iter_records():
        key = f'{r["date"]}:{r["会場"]}:{r["レース番号"]}'
        if key in seen:      # 重複行は無視(再取り込み対策。build_stats.pyと同じ作法)
            continue
        seen.add(key)
        races.append(r)
    return races


def payout_amount(entries, matcher):
    """払戻の1券種ぶんのリストから、matcher(組の文字列→bool)に合う金額の合計を返す。
    entriesが空(特払い等で読み取れなかった場合を含む)なら0円。"""
    if not entries:
        return 0
    return sum(e.get("金額", 0) for e in entries if matcher(e.get("組", "")))


def finalize(acc, unit):
    out = []
    for b in BOATS:
        a = acc[b]
        n = a["n"]
        if n == 0:            # 母数ゼロの会場でも0除算せず、対象数0で出す
            out.append({"艇番": b, "的中率": None, "回収率": None, "対象数": 0})
            continue
        out.append({
            "艇番": b,
            "的中率": round(a["hit"] / n, 4),
            "回収率": round(a["ret"] / (n * unit), 4),
            "対象数": n,
        })
    return out


def aggregate(races):
    """race一覧(全国分、または特定会場ぶんだけ)から3券種の集計を作る。
    計算式そのものは対象レンジを絞る前と一切変えない。"""
    tansho = {b: {"n": 0, "hit": 0, "ret": 0} for b in BOATS}
    fukusho = {b: {"n": 0, "hit": 0, "ret": 0} for b in BOATS}
    nagashi = {b: {"n": 0, "hit": 0, "ret": 0} for b in BOATS}

    for r in races:
        by_boat = {x["艇"]: x for x in r.get("結果", [])}
        payout = r.get("払戻") or {}
        p_tan = payout.get("単勝") or []
        p_fuku = payout.get("複勝") or []
        p_2t = payout.get("2連単") or []

        for b in BOATS:
            x = by_boat.get(b)
            if x is None:
                continue   # この艇がそもそも出走していないレース(欠場等)は分母から除く
            chaku = x["着"]
            bs = str(b)

            # 単勝: 1着なら的中。配当は組がこの艇番と一致する行(通常1件)。
            tansho[b]["n"] += 1
            if chaku == 1:
                tansho[b]["hit"] += 1
                tansho[b]["ret"] += payout_amount(p_tan, lambda k: k == bs)

            # 複勝: 2着以内なら的中。複勝は通常2行あるため、この艇番の行だけを拾う。
            fukusho[b]["n"] += 1
            if chaku <= 2:
                fukusho[b]["hit"] += 1
                fukusho[b]["ret"] += payout_amount(p_fuku, lambda k: k == bs)

            # 2連単1着ながし: 1着なら的中(2着は残り5艇全部に流しているため必ず当たる)。
            # 配当は組の1番目(1着側)がこの艇番の行(通常1件)。
            nagashi[b]["n"] += 1
            if chaku == 1:
                nagashi[b]["hit"] += 1
                nagashi[b]["ret"] += payout_amount(p_2t, lambda k: k.split("-")[0] == bs)

    return {
        "対象レース数": len(races),
        "単勝": finalize(tansho, 100),
        "複勝": finalize(fukusho, 100),
        "2連単ながし": finalize(nagashi, 500),
    }


def main():
    races = load_races()
    if not races:
        print("[stop] results/ が無い/空です。")
        return

    dates = sorted(r["date"] for r in races)
    latest = datetime.date.fromisoformat(dates[-1])
    cutoff = (latest - datetime.timedelta(days=365)).isoformat()
    target = [r for r in races if r["date"] >= cutoff]
    target_dates = sorted(r["date"] for r in target)
    period = f"{target_dates[0]}〜{target_dates[-1]}"

    by_venue = {v: [] for v in VENUE_ORDER}
    for r in target:
        if r["会場"] in by_venue:
            by_venue[r["会場"]].append(r)
        # 未知の会場名(表記ゆれ等)は会場別からは漏れるが、全国まとめには含まれる

    out = {
        "対象期間": period,
        "全国": aggregate(target),
        "会場別": {v: aggregate(rs) for v, rs in by_venue.items()},
    }
    js = "window.BACKTEST = " + json.dumps(out, ensure_ascii=False, separators=(",", ":")) + ";\n"
    open("backtest.js", "w", encoding="utf-8").write(js)
    print(f"[done] backtest.js 更新 / 対象期間 {period} / 全国{len(target)}レース / {len(by_venue)}会場")


if __name__ == "__main__":
    main()
