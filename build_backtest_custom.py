# -*- coding: utf-8 -*-
"""
バックテスト「自由条件指定」(5b第一弾)用の軽量中間データを作る。

results.jsonl(52,798行・約65MB、選手名や天候など表示用の項目も多い)を
そのままブラウザに読ませると重いため、ビルド時に「回収率・的中率の計算に
必要な最小限」だけを取り出した軽量JSONに前処理する。ブラウザ側(backtest-custom.html)
はこの軽量JSONを読み、ユーザーが選んだ会場・期間・券種・買い目でその場集計する。

【会場ごとにファイルを分割する理由】
全国ぶん(52,798レース)を1ファイルにまとめると、会場を1つだけ選んだ検証でも
毎回全件をダウンロードすることになり無駄が大きい。そこで
  backtest-data/zenkoku.json  … 全国(全レース)
  backtest-data/{romaji}.json … 会場ごと(24ファイル、zenkokuの部分集合)
に分割し、ユーザーが選んだ会場に応じて必要な1ファイルだけ読ませる。
全国ぶんは会場別ファイルの合計と同じデータを重複して持つ形になるが、
マージ処理を挟まず単純に1ファイル読むだけで済むメリットを優先した。

【将来10年分(約50万レース)になったときの方針】
現状はデータが1年分しか無く年またぎの分割は検証しようがないため、今回は
会場軸の分割のみ実装する。将来年数が増えたら、この同じ会場ディレクトリの下に
年ごとのファイル(例: backtest-data/omura-2027.json)を追加し、期間選択に応じて
必要な年のファイルだけ読む形に拡張する想定(ファイル名の付け方だけ決めておき、
実装は年またぎデータが実在してから行う)。

【中間データの1レコード(1レース)の形】
  {"d": "2026-06-30",
   "t":  [["1", 130]],                 単勝  (組, 金額)
   "f":  [["1", 100], ["2", 210]],     複勝
   "2t": [["1-2", 180]],               2連単
   "2f": [["1-2", 200]],               2連複
   "3t": [["1-2-4", 740]],             3連単
   "3f": [["1-2-4", 540]]}             3連複
選手名・天候・展示タイム等、回収率計算に使わない項目は持たない。人気も持たない。
拡連複は自由条件指定の対象外(仕様により今回含めない)なので持たない。

【「艇が出走しているか」の前提】
collect_results.py は6艇そろったレースしか results.jsonl に入れないため、
この中間データの艇番1〜6は常に全艇出走している前提で計算してよい
(欠場等で6艇そろわなかったレースはそもそも results.jsonl に存在しない)。
そのため中間データ側で艇の出走有無を別途持つ必要はない。

【払戻が空のレースの扱い】
返還・特払い等でその券種の払戻が読み取れなかったレースは、元の results.jsonl
でも払戻が空配列になっている(build_backtest.py と同じ仕様)。この中間データでも
そのまま空配列で持ち、ブラウザ側では「賭けたが払戻0円、的中もしていない」として
扱う(対象レース数には含め、的中はしない)。
"""
import json, os, datetime
from parse_results import JCD, PAYOUT_LABELS
from build_race_pages import VENUE_ROMAJI
import results_store

OUT_DIR = "backtest-data"

# 中間データに残す券種だけ(拡連複は自由条件指定の対象外)
KEEP_BETS = {"単勝": "t", "複勝": "f", "2連単": "2t", "2連複": "2f", "3連単": "3t", "3連複": "3f"}


def load_races():
    """build_backtest.py と同じ重複排除の作法(再取り込み対策)。

    【重要】このスクリプトは results.jsonl(現在は results/{年}.jsonl に分割)の
    全期間をそのまま中間データに書き出す設計で、直近1年に絞るフィルタを持たない
    (期間の絞り込みはフロント側backtest-custom.htmlがmeta.jsonのearliest/latestを
    見て行う)。2023年分の過去データが results/ に追加された状態でこのスクリプトを
    再実行すると、5bの中間データが一気に約3年分に広がり「表示は今まで通り1年のまま」
    という前提が崩れる。そのため、年別分割対応のコード更新はここで済ませるが、
    実際の再生成(main実行)は別タスクとして見送る(年別・期間別分割の設計を
    別途検討してから行う)。"""
    races, seen = [], set()
    for r in results_store.iter_records():
        key = f'{r["date"]}:{r["会場"]}:{r["レース番号"]}'
        if key in seen:
            continue
        seen.add(key)
        races.append(r)
    return races


def compact(r):
    """1レースぶんを軽量な形に変換する。"""
    payout = r.get("払戻") or {}
    rec = {"d": r["date"]}
    for label, key in KEEP_BETS.items():
        entries = payout.get(label) or []
        # 人気は自由条件指定の計算に不要なので落とす。組・金額だけ残す。
        rec[key] = [[e.get("組", ""), e.get("金額", 0)] for e in entries]
    return rec


def write_json(path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    return os.path.getsize(path)


def main():
    races = load_races()
    if not races:
        print("[stop] results/ が無い/空です。")
        return

    os.makedirs(OUT_DIR, exist_ok=True)

    dates = sorted(r["date"] for r in races)
    earliest, latest = dates[0], dates[-1]

    zenkoku = [compact(r) for r in races]
    by_venue = {v: [] for v in JCD.values()}
    for r in races:
        if r["会場"] in by_venue:
            by_venue[r["会場"]].append(compact(r))
        # 未知の会場名(表記ゆれ等)は会場別からは漏れるが、全国には含まれる(build_backtest.pyと同じ扱い)

    sizes = {}
    sizes["zenkoku.json"] = write_json(os.path.join(OUT_DIR, "zenkoku.json"), zenkoku)
    venue_files = []
    for v, recs in by_venue.items():
        romaji = VENUE_ROMAJI.get(v)
        if not romaji:
            continue
        fname = f"{romaji}.json"
        sizes[fname] = write_json(os.path.join(OUT_DIR, fname), recs)
        venue_files.append({"name": v, "romaji": romaji, "file": fname, "count": len(recs)})

    meta = {
        "generated_at": datetime.datetime.now().isoformat(timespec="seconds"),
        "earliest": earliest,
        "latest": latest,
        "全国件数": len(zenkoku),
        "venues": venue_files,
    }
    write_json(os.path.join(OUT_DIR, "meta.json"), meta)

    total = sum(sizes.values())
    print(f"[done] {OUT_DIR}/ 生成: 全国{len(zenkoku)}レース / 会場{len(venue_files)}件 / "
          f"期間{earliest}〜{latest}")
    print(f"  zenkoku.json: {sizes['zenkoku.json']:,} bytes")
    print(f"  会場ファイル合計: {sum(v for k, v in sizes.items() if k != 'zenkoku.json' and k != 'meta.json'):,} bytes")
    print(f"  全体合計: {total:,} bytes")


if __name__ == "__main__":
    main()
