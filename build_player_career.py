#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
選手(登番)ごとのキャリア推移を players/career/{登番}.json に書き出す。

【第1弾で入れるもの】
- 年ごとの出走数・1着数・2連対数・勝率・2連対率(results/ の実レース結果から)
- 級別の変遷(fan/ の期別ファイルから)
- generated_at(生成日時)

【入れないもの(意図的)】
順位・偏差値・スコア・「絶好調」等の評価語は一切入れない。ここは事実の数値だけを
出す層で、どう見せるか・どう注記するかは表示側の仕事。出走数が少ない年も
母数をそのまま出す(隠さない)。

【勝率について】
公式の「勝率」は着順に応じた得点の平均(1着10点…等)で、ここで出しているのは
「1着数 ÷ 出走数」。名前が同じでも中身が違うので、キー名を win_rate とし、
公式の勝率(fan由来)は別に class 側で持つ。表示側で取り違えないよう、
JSONにも rate_note を入れて意味を書いておく。

【級別の適用期間(実データで確認済み)】
fanYYMM は「審査期間」で算出され、適用はその約2か月後から6か月間:
  fanYY04(審査 前年11/01〜当年04/30) → 適用 当年07/01〜12/31
  fanYY10(審査 当年05/01〜10/31)     → 適用 翌年01/01〜06/30
確認方法: fan2604 の級別が2026-07-28のB票と864/864一致。さらに各fanの
「前期級」が1つ前の期の「級別」と100%一致することを21期で確認した。

入力:
  results/{年}.jsonl  … data ブランチ(data_paths が場所を決める)
  fan/{YYMM}.json     … 同上。collect_fan_history.py が作る
出力:
  players/career/{登番}.json … main側(将来ブラウザから読む前提の公開ファイル)
"""
import json, os, glob, datetime, collections
import results_store
import data_paths

OUT_DIR = os.path.join("players", "career")
FAN_DIR = os.path.join(data_paths.DATA_ROOT, "fan")


def class_periods():
    """fan/*.json から「適用開始日 → {登番: 級別}」の一覧を、古い順に作る。"""
    out = []
    for path in sorted(glob.glob(os.path.join(FAN_DIR, "[0-9][0-9][0-9][0-9].json"))):
        period = os.path.basename(path)[:4]
        yy, mm = int(period[:2]), period[2:]
        year = 2000 + yy
        if mm == "04":
            start, end = f"{year}-07-01", f"{year}-12-31"
        else:
            start, end = f"{year + 1}-01-01", f"{year + 1}-06-30"
        data = json.load(open(path, encoding="utf-8"))
        out.append({
            "period": period, "from": start, "to": end,
            "審査期間": data.get("算出期間"),
            "by_toban": {p["登番"]: p for p in data["players"]},
        })
    out.sort(key=lambda x: x["from"])
    return out


def main():
    if not results_store.exists():
        print("[skip] results/ が無いので players/career/ は作りません")
        return
    periods = class_periods()
    if not periods:
        print(f"[skip] {FAN_DIR} に期別ファイルが無いので作りません "
              f"(先に collect_fan_history.py を実行してください)")
        return

    # ---- 年別成績(results から) ----
    # 登番 -> 年 -> [出走, 1着, 2連対(=2着以内)]
    tally = collections.defaultdict(lambda: collections.defaultdict(lambda: [0, 0, 0]))
    names = {}
    for r in results_store.iter_records():
        year = r["date"][:4]
        for b in r["結果"]:
            row = tally[b["登番"]][year]
            # 出走数は「完走しなくても1走」。失格・転覆・フライングも出走に数える
            # (2026-07-30までは、そういうレースがresultsに存在しなかった)。
            row[0] += 1
            chaku = b["着"]        # 非完走艇は None
            if chaku == 1:
                row[1] += 1
            if chaku is not None and chaku <= 2:
                row[2] += 1
            if b.get("名"):
                names[b["登番"]] = b["名"]

    os.makedirs(OUT_DIR, exist_ok=True)
    generated_at = datetime.datetime.now().isoformat(timespec="seconds")
    written = total_bytes = 0

    for toban, by_year in tally.items():
        years = []
        for year in sorted(by_year):
            starts, wins, top2 = by_year[year]
            years.append({
                "year": int(year),
                "starts": starts, "wins": wins, "top2": top2,
                "win_rate": round(wins / starts, 4) if starts else None,
                "top2_rate": round(top2 / starts, 4) if starts else None,
            })

        classes = []
        for p in periods:
            rec = p["by_toban"].get(toban)
            if not rec:
                continue   # その期に在籍していない(引退・未デビュー)
            classes.append({
                "period": p["period"], "from": p["from"], "to": p["to"],
                "class": rec["級別"],
                "official_win_rate": rec.get("勝率"),      # 公式の勝率(着順点の平均)
                "official_top2_rate": rec.get("複勝率"),
                "starts": rec.get("出走回数"),
            })

        # 名前は results 由来(2025-07-05〜2026-05-05の期間だけ結果側に名前が無いので、
        # 見つからない場合は fan 側の氏名で補う)。
        name = names.get(toban)
        if not name:
            for p in reversed(periods):
                rec = p["by_toban"].get(toban)
                if rec:
                    name = rec.get("氏名")
                    break

        doc = {
            "toban": toban,
            "name": name,
            "generated_at": generated_at,
            "source": {
                "results_from": years[0]["year"] if years else None,
                "results_to": years[-1]["year"] if years else None,
                "class_periods": len(classes),
            },
            "rate_note": "win_rate=1着数÷出走数, top2_rate=2着以内÷出走数。"
                         "official_win_rate は公式の勝率(着順点の平均)で計算方法が異なる。",
            "years": years,
            "classes": classes,
        }
        path = os.path.join(OUT_DIR, f"{toban}.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
        written += 1
        total_bytes += os.path.getsize(path)

    print(f"[done] {OUT_DIR}/ 生成: {written:,}選手 / 合計 {total_bytes:,} bytes "
          f"/ 級別 {len(periods)}期分({periods[0]['from']}〜{periods[-1]['to']})")


if __name__ == "__main__":
    main()
