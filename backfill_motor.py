# -*- coding: utf-8 -*-
"""
一度きりのバックフィル用スクリプト（自動ワークフローには組み込まない）。

parse_results.py / collect_results.py にモーター番号・選手名を残す変更を入れたが、
既にresults.jsonlへ入っている過去分にはこの2項目が無い。「前回使用者」を今すぐ
埋めるには、直近ぶんだけで良い（会場ごとの節の間隔を調べたところ最長29日だったので
安全を見て60日）。該当日数分のKファイルを取り直し、既存レコード(date:会場:レース番号
が一致するもの)にモーター番号・選手名だけ追記する。新規レコードは追加しない
(1年分は既に取り込み済みのため、想定外の抜けがあれば黙って無視する)。

生データ(ダウンロードしたlzh/txt)はこのPC上だけで処理し、GitHubには出力の
results.jsonl(要約側の1行1レース形式)だけを反映する。従来方針を踏襲。

実行環境:ローカルWindows。lhasaの代わりに7-Zip(7z.exe)を使う。
使い方: python backfill_motor.py [--days 60]
"""
import sys, os, glob, time, json, datetime, zoneinfo, subprocess, urllib.request, urllib.error
from parse_results import parse_results

JST = zoneinfo.ZoneInfo("Asia/Tokyo")
STORE = "results.jsonl"
POLITE_WAIT = 3
SEVENZIP = r"C:\Program Files\7-Zip\7z.exe"


def download(url, dest):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r, open(dest, "wb") as f:
            f.write(r.read())
        return True
    except urllib.error.HTTPError as e:
        print(f"  [skip] {url} (HTTP {e.code})")
        return False
    except Exception as e:
        print(f"  [skip] {url} ({e})")
        return False


def main():
    days = 60
    if "--days" in sys.argv:
        days = int(sys.argv[sys.argv.index("--days") + 1])

    # 既存レコードを読み込み、date:会場:レース番号をキーに保持(順序も保つ)
    existing, order = {}, []
    with open(STORE, encoding="utf-8") as f:
        for line in f:
            line = line.rstrip("\n")
            if not line:
                continue
            r = json.loads(line)
            key = f'{r["date"]}:{r["会場"]}:{r["レース番号"]}'
            existing[key] = (r, line)   # 元の行テキストも保持(未変更ぶんは丸ごと使い回す)
            order.append(key)

    today = datetime.datetime.now(JST).date()
    updated_races = 0
    for i in range(1, days + 1):
        d = today - datetime.timedelta(days=i)
        yyyymm, yymmdd = d.strftime("%Y%m"), d.strftime("%y%m%d")
        url = f"https://www1.mbrace.or.jp/od2/K/{yyyymm}/k{yymmdd}.lzh"
        lzh = f"k{yymmdd}.lzh"
        if not download(url, lzh):
            time.sleep(POLITE_WAIT)
            continue
        subprocess.run([SEVENZIP, "x", "-y", lzh], check=True, stdout=subprocess.DEVNULL)
        txts = glob.glob("[Kk]" + yymmdd + ".[Tt][Xx][Tt]")
        if not txts:
            print(f"  [skip] 解凍後テキスト無し {yymmdd}")
            time.sleep(POLITE_WAIT)
            continue

        for r in parse_results(txts[0]):
            key = f'{d.isoformat()}:{r["会場"]}:{r["レース番号"]}'
            if key not in existing:
                continue   # 1年分取り込み済みのはずなので、無ければ何もしない
            rec, _ = existing[key]
            by_touban = {x["登番"]: x for x in r["結果"]}
            changed = False
            for x in rec["結果"]:
                src = by_touban.get(x["登番"])
                if src:
                    x["モ"] = src.get("モーター番号")
                    x["名"] = src.get("選手名")
                    changed = True
            if changed:
                existing[key] = (rec, json.dumps(rec, ensure_ascii=False))
                updated_races += 1

        os.remove(lzh)
        for t in txts:
            os.remove(t)
        time.sleep(POLITE_WAIT)
        print(f"  {d}: 処理済み")

    with open(STORE, "w", encoding="utf-8") as f:
        for key in order:
            _, line = existing[key]
            f.write(line + "\n")

    print(f"[done] 直近{days}日ぶんを処理、{updated_races}レースにモーター番号・選手名を追記")


if __name__ == "__main__":
    main()
