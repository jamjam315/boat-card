#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
選手バックテスト(5bの選手条件)用の索引を players/bt/{登番}.json に書き出す。

【なぜ選手別のファイルにするのか】
5bは backtest-data/{会場}-{年}.json をブラウザが直接ダウンロードして集計する
作りで、「読み込み量が期間の長さにほぼ比例する」ことを設計の柱にしている。
選手条件を既存ファイル側に持たせる(全レコードに登番6件を足す)と、選手条件を
使わない人まで取得量が23%増える。一方、選手が出たレースは全体の0.5%程度しか
ないので、選手ごとに切り出せば取得量は85MB→86KB程度で済む。既存の5bの
取得量にはまったく影響しない。

【1行の形】
  [日付, m, 艇番, 着, 単勝, 複勝, 2連単1着ながし]
    m     … しぼり込み用のビット詰め。build_backtest_custom.pack_meta をそのまま使う
            (5bと同じ絞り込みがそのまま効くようにするため、定義を二重に持たない)
    艇番   … その選手がその日に乗っていた艇。買い目はレースごとに変わるので必要
    着     … 1〜6。失格・転覆・フライング等の非完走は null
    単勝   … その艇の単勝の払戻(円)。当たっていなければ0
    複勝   … その艇の複勝の払戻(円)。当たっていなければ0
    2連単  … その選手を1着に固定して残り5艇へ流したときの払戻(円)
             (既存 build_backtest.py の「2連単1着ながし」と同じ定義)

【集計の決めごと(既存の実装と揃えてある)】
- 非完走の出走も1行として入れる。失格・転覆は確実なハズレなので、分母から
  抜くと回収率が甘く出る(2026-07-30のresults再生成で直したのと同じ話)
- 払戻が空のレース(中止・返還等、全体の約1.2〜1.4%)も1行として入れる。
  build_backtest.py が分母に数えているので、5bと数字が比較できるように揃える
- 同着は払戻の行を全部走査して合算する(build_backtest.py の payout_amount と
  5bのクライアント側の両方が既にこの扱い)。2連単の1着同着では、1着固定の
  ながしが2組とも当たるので合算が正しい
- 5艇以下のレースは複勝が1着ぶんしか発売されない(1行しか無いレースが5,622件)。
  2着に入っても払戻0になることがあるので、表示側で注記する前提でそのまま入れる
- 単勝が発売されなかった開催では、1着でも払戻を引けない(670勝中10件規模)。
  0円として扱う

【投資単位】
単勝・複勝は1レース100円、2連単1着ながしは5点なので500円。
build_backtest.py の finalize(unit) と同じ。ファイルの stake に書いておく。

入力:
  results/{年}.jsonl  … data ブランチ(data_paths が場所を決める)
出力:
  players/bt/{登番}.json … main側(ブラウザが直接読む公開ファイル)
"""
import json, os, datetime, collections
import results_store
from build_backtest_custom import pack_meta

OUT_DIR = os.path.join("players", "bt")

STAKE = {"tan": 100, "fuku": 100, "nagashi2t": 500}


def payout_amount(entries, matcher):
    """払戻1券種ぶんから、matcher(組→bool)に合う金額の合計。
    build_backtest.py と同じ考え方(同着で複数行あれば合算、空なら0円)。"""
    if not entries:
        return 0
    return sum(e.get("金額", 0) for e in entries if matcher(e.get("組", "")))


def main():
    if not results_store.exists():
        print("[skip] results/ が無いので players/bt/ は作りません")
        return

    rows = collections.defaultdict(list)
    names = {}
    races = 0
    for r in results_store.iter_records():
        races += 1
        m = pack_meta(r)
        pay = r.get("払戻") or {}
        p_tan, p_fuku, p_2t = pay.get("単勝"), pay.get("複勝"), pay.get("2連単")
        for b in r["結果"]:
            frame = b.get("艇")
            if frame is None:
                continue
            bs = str(frame)
            rows[b["登番"]].append([
                r["date"], m, frame, b["着"],
                payout_amount(p_tan, lambda k: k == bs),
                payout_amount(p_fuku, lambda k: k == bs),
                # 1着固定ながし: 組の1番目がこの艇のものを全部足す
                payout_amount(p_2t, lambda k: k.split("-")[0] == bs),
            ])
            if b.get("名"):
                names[b["登番"]] = b["名"]

    os.makedirs(OUT_DIR, exist_ok=True)
    generated_at = datetime.datetime.now().isoformat(timespec="seconds")
    written = total_bytes = 0
    for toban, rs in rows.items():
        rs.sort(key=lambda x: x[0])
        doc = {
            "toban": toban,
            "name": names.get(toban),
            "generated_at": generated_at,
            "from": rs[0][0], "to": rs[-1][0],
            "races": len(rs),
            "stake": STAKE,
            "columns": ["date", "m", "frame", "chaku", "tan", "fuku", "nagashi2t"],
            "note": "1行=この選手の1出走。chaku=null は非完走(失格・転覆・フライング等)で、"
                    "確実なハズレとして分母に入れる。払戻が0でも出走は出走として数える。"
                    "m のビットの意味は build_backtest_custom.py の docstring を参照。"
                    "5艇以下のレースは複勝が1着ぶんしか発売されないため、2着でも fuku が0のことがある。",
            "rows": rs,
        }
        path = os.path.join(OUT_DIR, f"{toban}.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
        written += 1
        total_bytes += os.path.getsize(path)

    print(f"[done] {OUT_DIR}/ 生成: {written:,}選手 / {races:,}レースから / "
          f"合計 {total_bytes:,} bytes / 平均 {total_bytes // written if written else 0:,} bytes/人")


if __name__ == "__main__":
    main()
