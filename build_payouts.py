# -*- coding: utf-8 -*-
"""
その日の結果を、ブラウザから読める軽い形にして payouts/{日付}.json へ書き出す。

  python build_payouts.py                 直近3日ぶん(既定)
  python build_payouts.py --days 7        直近7日ぶん
  python build_payouts.py --from 2026-07-26   その日から最新日まで(バックフィル)
  python build_payouts.py --date 2026-09-01   1日だけ

【なぜ要るのか】
読み採点(P1-3)は端末の中で採点する。買い目は端末から出さない方針なので、
サーバーに送って採点してもらうことができない。ところが結果の元データ
(results/{年}.jsonl)は data ブランチにあり、公開サイトからは読めない。
そこで採点に要るぶんだけを抜き出して main に置く。

【何を入れて、何を入れないか】
入れる … 着順(艇番と着)・払戻(7券種の組/金額/人気)・決まり手・気象4項目
入れない … ST・展示・レースタイム・選手名・モーター番号
  この機能で採点に使わないものは持たせない。1日30KB前後に収める狙いもあるが、
  それ以上に「公開する情報は必要なぶんだけ」にしておきたい。
  あとから足すのは簡単で、減らすのは難しい。

【中止・返還】
払戻が1つも無いレースは status:"不成立" とだけ書く。採点側はこれを見て
そのレースを勘定から外す(的中でも不的中でもない)。実データで1〜2%ある。

【キー】
"日付:会場:レース番号"。results の重複排除キー・端末の記録のキーと同じ規約で、
これで記録と結果がそのまま突き合わせられる。
"""
import argparse
import io
import json
import os

import data_paths
import results_store

OUT_DIR = "payouts"
KEN = ["単勝", "複勝", "2連単", "2連複", "3連単", "3連複", "拡連複"]
DEFAULT_DAYS = 3


def load_by_date(dates):
    """指定した日付ぶんのレコードだけを、年ファイルから拾って返す。

    results_store.iter_records() は全年を舐めるので、日付が決まっている
    ここでは必要な年のファイルだけを開く(2016〜2026の10年を毎回読むと
    毎晩のワークフローで無駄に数分かかる)。"""
    want = set(dates)
    years = sorted({d[:4] for d in want})
    out = {d: [] for d in want}
    for y in years:
        path = results_store.year_file_path(y)
        if not os.path.exists(path):
            continue
        with io.open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    r = json.loads(line)
                except Exception:
                    continue
                if r.get("date") in want:
                    out[r["date"]].append(r)
    return out


def race_doc(r):
    """1レース分。払戻が無ければ不成立として、それ以上は書かない。

    キーを短くしているのは results/{年}.jsonl や data.js と同じ流儀
    (艇/着/n/t/k…)。素直に書くと1日89KBになり、狙いの30KB前後から外れる。
      order … 艇番順に並べた着順の配列。order[0]が1号艇の着。
              失格・欠場は null(着が付かなかった、という事実をそのまま残す)。
      pay   … 券種ごとの払戻。c=組 / y=金額 / p=人気。
      wx    … 気象。ここだけ日本語のままにしてある(4つしか無く、
              講評で人が読む値なので、短くする利得より読みやすさを取る)。"""
    pay = r.get("払戻") or {}
    hit = {}
    for k in KEN:
        rows = pay.get(k)
        if not rows:
            continue
        hit[k] = [{"c": x.get("組"), "y": x.get("金額"), "p": x.get("人気")}
                  if x.get("人気") is not None
                  else {"c": x.get("組"), "y": x.get("金額")}
                  for x in rows]
    if not hit:
        return {"status": "不成立"}

    order = [None] * 6
    for x in r.get("結果", []):
        lane = x.get("艇")
        if isinstance(lane, int) and 1 <= lane <= 6:
            order[lane - 1] = x.get("着")
    return {
        "order": order,
        "kimarite": r.get("決まり手"),
        "wx": {
            "天候": r.get("天候"), "風向": r.get("風向"),
            "風速": r.get("風速"), "波高": r.get("波高"),
        },
        "pay": hit,
    }


def build_one(date_iso, rows):
    races = {}
    seen = set()
    for r in sorted(rows, key=lambda x: (x["会場"], x["レース番号"])):
        key = f'{date_iso}:{r["会場"]}:{r["レース番号"]}'
        if key in seen:      # 同じレースが二重に入っていたら先勝ち(結果側の重複対策)
            continue
        seen.add(key)
        races[key] = race_doc(r)
    # 生成時刻は入れない。毎晩3日ぶんを作り直すので、時刻を持たせると中身が
    # 同じでも毎回差分が出て、意味の無いコミットが積み上がる(過去に career/ で
    # 2,116ファイルがタイムスタンプだけで差分になった)。いつ作ったかは
    # gitのコミットが覚えている。
    doc = {"date": date_iso, "races": races}
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, f"{date_iso}.json")
    with io.open(path, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
    void = sum(1 for v in races.values() if v.get("status"))
    return path, len(races), void, os.path.getsize(path)


def all_dates():
    """results に入っている日付の一覧(昇順)。"""
    dates = set()
    for path in results_store.all_year_files():
        with io.open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    dates.add(json.loads(line)["date"])
                except Exception:
                    continue
    return sorted(dates)


def main():
    p = argparse.ArgumentParser(description="その日の結果と払戻を payouts/ に書き出す")
    p.add_argument("--days", type=int, default=DEFAULT_DAYS,
                   help=f"最新日から何日ぶん作るか(既定 {DEFAULT_DAYS})")
    p.add_argument("--from", dest="since", help="この日から最新日まで作る(バックフィル)")
    p.add_argument("--date", help="この日だけ作る")
    a = p.parse_args()

    if not results_store.exists():
        print("[stop] results/ が無い。先に collect_results.py を回してください。")
        return

    dates = all_dates()
    if not dates:
        print("[stop] results/ が空です。")
        return

    if a.date:
        target = [a.date] if a.date in dates else []
        if not target:
            print(f"[skip] {a.date} の結果がまだありません。")
            return
    elif a.since:
        target = [d for d in dates if d >= a.since]
    else:
        # 最新日から数日ぶん。遅れて届いた結果を拾い直せるように1日だけにしない。
        target = dates[-a.days:]

    by_date = load_by_date(target)
    total = 0
    for d in target:
        path, n, void, size = build_one(d, by_date.get(d, []))
        total += size
        print(f"[done] {path}  {n}レース(不成立{void}) {size / 1024:.0f}KB")
    if len(target) > 1:
        print(f"[done] 合計 {len(target)}日 / {total / 1024 / 1024:.1f}MB")


if __name__ == "__main__":
    main()
