# -*- coding: utf-8 -*-
"""
一度きりのバックフィル用スクリプト(自動ワークフローには組み込まない)。
2017年分の過去データ追加(2026-07-23)。既存最古日(2018-07-05)の直前から
さらに約1年分さかのぼり、2017-07-05〜2018-07-04(365日)を取り込む。
2018年は平年のため365日固定でも既存最古日と隙間なく連続する。

collect_results.py と全く同じ取得・解凍・パース・レコード形式
(collect_results.append_from_txt() をそのまま再利用)で、results/{年}.jsonl に
追記する(日付に応じて2017.jsonl/2018.jsonlへ自動振り分け)。新規レコードのみ
追加、既存データの変更・削除はしない。

書式は2016年まで互換確認済み(過去のバックフィルの経緯より)。2017年は
特殊事情のない通常年の見込み。書式違い等が見つかった場合のみ停止する。

生データ(ダウンロードしたlzh/txt)はこのPC上だけで処理し、GitHubには出力の
results/{年}.jsonl(要約側の1行1レース形式)だけを反映する。従来方針を踏襲。

実行環境:ローカルWindows。lhasaの代わりに7-Zip(7z.exe)を使う。
使い方: python backfill_2017.py
"""
import os, glob, time, datetime, subprocess, urllib.request, urllib.error
from collect_results import append_from_txt, existing_keys
import results_store

START = datetime.date(2017, 7, 5)
END = datetime.date(2018, 7, 4)
POLITE_WAIT = 3          # 秒(公式サーバーへの配慮)
SEVENZIP = r"C:\Program Files\7-Zip\7z.exe"
MAX_CONSECUTIVE_FAILURES = 10   # 2017年は特殊事情なしの見込みのため通常水準
MAX_CONSECUTIVE_EMPTY = 3       # 解凍成功したのに0レースが連続したら書式違いの疑いで停止

LOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "backfill_2017_log.txt")


def log(msg):
    line = f"{datetime.datetime.now().strftime('%H:%M:%S')} {msg}"
    print(line, flush=True)
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def download(url, dest):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r, open(dest, "wb") as f:
            f.write(r.read())
        return True
    except urllib.error.HTTPError as e:
        log(f"  [skip] {url} (HTTP {e.code})")
        return False
    except Exception as e:
        log(f"  [skip] {url} ({e})")
        return False


def main():
    keys = existing_keys()
    total_days = (END - START).days + 1
    log(f"[start] {START}〜{END}({total_days}日) 開始。既存レコード数={len(keys)}")

    d = START
    added_total = 0
    processed_days = 0
    consecutive_fail = 0
    consecutive_empty = 0
    max_consecutive_fail_seen = 0

    while d <= END:
        yyyymm, yymmdd = d.strftime("%Y%m"), d.strftime("%y%m%d")
        url = f"https://www1.mbrace.or.jp/od2/K/{yyyymm}/k{yymmdd}.lzh"
        lzh = f"k{yymmdd}.lzh"

        if not download(url, lzh):
            consecutive_fail += 1
            consecutive_empty = 0
            max_consecutive_fail_seen = max(max_consecutive_fail_seen, consecutive_fail)
            if consecutive_fail >= MAX_CONSECUTIVE_FAILURES:
                log(f"[STOP] ダウンロード失敗が{MAX_CONSECUTIVE_FAILURES}日連続。異常の疑いがあるため停止します。"
                    f"直前の日付={d}")
                return
            d += datetime.timedelta(days=1)
            time.sleep(POLITE_WAIT)
            continue

        try:
            subprocess.run([SEVENZIP, "x", "-y", lzh], check=True, stdout=subprocess.DEVNULL)
        except subprocess.CalledProcessError as e:
            log(f"[STOP] 7-Zip解凍でエラー({d}): {e}")
            return

        txts = glob.glob("[Kk]" + yymmdd + ".[Tt][Xx][Tt]")
        if not txts:
            log(f"  [skip] 解凍後テキスト無し {d}")
            os.remove(lzh)
            consecutive_fail = 0
            consecutive_empty = 0
            d += datetime.timedelta(days=1)
            time.sleep(POLITE_WAIT)
            continue

        try:
            with results_store.open_year_file_append(d.isoformat()) as fout:
                added = append_from_txt(txts[0], d.isoformat(), keys, fout)
        except Exception as e:
            log(f"[STOP] レコード変換でエラー({d}): {e}。書式が異なる可能性があります。")
            return

        os.remove(lzh)
        for t in txts:
            os.remove(t)

        if added == 0:
            consecutive_empty += 1
            log(f"  {d}: 0レース(解凍は成功) 連続{consecutive_empty}回")
            if consecutive_empty >= MAX_CONSECUTIVE_EMPTY:
                log(f"[STOP] 解凍成功なのに0レースが{MAX_CONSECUTIVE_EMPTY}日連続。"
                    f"書式違いの疑いがあるため停止します。直前の日付={d}")
                return
        else:
            consecutive_empty = 0
            log(f"  {d}: {added}レース追加(累計{added_total + added})")

        added_total += added
        processed_days += 1
        consecutive_fail = 0
        d += datetime.timedelta(days=1)
        time.sleep(POLITE_WAIT)

    log(f"[done] 完了。処理日数={processed_days}/{total_days} 追加レース数={added_total} "
        f"総レコード見込み={len(keys)} 最大連続失敗={max_consecutive_fail_seen}日")


if __name__ == "__main__":
    main()
