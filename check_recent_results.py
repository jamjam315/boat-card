# -*- coding: utf-8 -*-
"""
直近の結果データが取りこぼされていないかを確認する(毎朝のワークフローの最後で実行)。

【なぜ要るのか】
2025-09-15の1日ぶん(146レース)が、夜間収集の失敗によって10か月間欠けたまま
誰にも気づかれていなかった。前後の日は正常だったので、画面を見ても気づけない。
結果データの収集は失敗しても無音で確定する構造だったため、鳴る仕組みを足す。

【判定を「1件以上あるか」だけにしている理由】
ボートレースは事実上365日開催で、2016-07-05〜2026-07-27の3,675日すべてに
1レース以上あった(1レースも無い日は0日)。元日でも134〜161レース行われている。
一方で、荒天等でレース数が極端に少ない日はある(最少は2018-09-30の23レース、
2会場ぶんにも満たない)。そのため「50レース未満なら異常」のような閾値は
誤報を生む。0件かどうかだけを見るのが、誤報なく取りこぼしを捕まえられる線。

【いつの日付を見るか】
結果は「前日ぶん」を毎晩01:00(JST)に収集している。このスクリプトは毎朝
07:30/08:30(JST)に走るので、その時点で入っているはずの直近数日を確認する。
当日ぶんはまだ開催中/未公開なので対象にしない。

使い方:
    python check_recent_results.py          # 直近3日(前日〜3日前)を確認
    python check_recent_results.py 7        # 日数を指定
"""
import sys, os, datetime, zoneinfo
import results_store
import data_paths

JST = zoneinfo.ZoneInfo("Asia/Tokyo")
DEFAULT_DAYS = 3


def count_for_date(date_iso):
    """その日付のレコード数を数える。1行1レースなので、行の文字列一致で足りる
    (全件をJSONに戻すより速い。年ファイルは1本あたり約80MBある)。"""
    path = results_store.year_file_path(date_iso[:4])
    if not os.path.isfile(path):
        return 0
    needles = (f'"date": "{date_iso}"', f'"date":"{date_iso}"')
    n = 0
    with open(path, encoding="utf-8") as f:
        for line in f:
            if needles[0] in line or needles[1] in line:
                n += 1
    return n


def main():
    days = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_DAYS
    today = datetime.datetime.now(JST).date()
    print(f"[info] 基準日(JST): {today} / {data_paths.describe()}")

    missing = []
    for i in range(1, days + 1):
        d = (today - datetime.timedelta(days=i)).isoformat()
        n = count_for_date(d)
        mark = "OK " if n > 0 else "NG "
        print(f"  {mark}{d}: {n:>4}レース")
        if n == 0:
            missing.append(d)

    if missing:
        print(f"\n[NG] 結果データが1件も無い日があります: {', '.join(missing)}")
        print("     夜間の収集(results.yml)が失敗した可能性があります。")
        print("     手元から追い付けます:  python collect_results.py --days 5")
        sys.exit(1)

    print(f"\n[check] 直近{days}日ぶんの結果データはすべて揃っています。")


if __name__ == "__main__":
    main()
