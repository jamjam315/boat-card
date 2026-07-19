# -*- coding: utf-8 -*-
"""
一度きりのバックフィル用スクリプト（自動ワークフローには組み込まない）。
既に実行済み(過去分への払戻追記は完了済み)。2026-07-19の年別ファイル分割に
伴い、複数年ファイルへ対応させたが、今後の再実行は基本的に想定していない。

parse_results.py / collect_results.py に払戻(単勝〜3連複の配当・人気)を追加したが、
既にresults(現在は年別ファイル)へ入っている過去分にはこの項目が無い場合がある。
実在する全日付ぶんのKファイルを取り直し、既存レコード(date:会場:レース番号が
一致するもの)に払戻だけ追記する。着順・進入・ST・展示タイム等の既存項目は
一切変えない。新規レコードは追加しない(取得済みの日付だけを対象にするため)。

生データ(ダウンロードしたlzh/txt)はこのPC上だけで処理し、GitHubには出力の
results/{年}.jsonl(要約側の1行1レース形式)だけを反映する。従来方針を踏襲。

実行環境:ローカルWindows。lhasaの代わりに7-Zip(7z.exe)を使う。
使い方: python backfill_payout.py
"""
import os, glob, time, json, datetime, subprocess, urllib.request, urllib.error
from parse_results import parse_results
import results_store

POLITE_WAIT = 2   # 秒（公式サーバーへの配慮。1〜2秒程度に留める）
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


def process_year_file(path):
    """1つの年ファイルぶんだけを対象に処理する(年ファイルをまたいだ処理はしない、
    date:会場:レース番号のキーは年の中で完結するため)。"""
    existing, order = {}, []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.rstrip("\n")
            if not line:
                continue
            r = json.loads(line)
            key = f'{r["date"]}:{r["会場"]}:{r["レース番号"]}'
            existing[key] = (r, line)
            order.append(key)

    dates = sorted({r["date"] for r, _ in existing.values()})
    print(f"[info] {path}: 対象日数 {len(dates)}日 / 対象レコード数 {len(order)}")

    updated_races = 0
    missing_days = []
    for i, date_iso in enumerate(dates, 1):
        d = datetime.date.fromisoformat(date_iso)
        yyyymm, yymmdd = d.strftime("%Y%m"), d.strftime("%y%m%d")
        url = f"https://www1.mbrace.or.jp/od2/K/{yyyymm}/k{yymmdd}.lzh"
        lzh = f"k{yymmdd}.lzh"
        if not download(url, lzh):
            missing_days.append(date_iso)
            time.sleep(POLITE_WAIT)
            continue
        subprocess.run([SEVENZIP, "x", "-y", lzh], check=True, stdout=subprocess.DEVNULL)
        txts = glob.glob("[Kk]" + yymmdd + ".[Tt][Xx][Tt]")
        if not txts:
            print(f"  [skip] 解凍後テキスト無し {yymmdd}")
            missing_days.append(date_iso)
            os.remove(lzh)
            time.sleep(POLITE_WAIT)
            continue

        for r in parse_results(txts[0]):
            key = f'{date_iso}:{r["会場"]}:{r["レース番号"]}'
            if key not in existing:
                continue   # 実在する日付だけを対象にするため、無ければ何もしない
            rec, _ = existing[key]
            rec["払戻"] = r.get("払戻")
            existing[key] = (rec, json.dumps(rec, ensure_ascii=False))
            updated_races += 1

        os.remove(lzh)
        for t in txts:
            os.remove(t)
        time.sleep(POLITE_WAIT)
        if i % 20 == 0 or i == len(dates):
            print(f"  [{i}/{len(dates)}] {date_iso} 処理済み(累計更新 {updated_races}レース)")

    with open(path, "w", encoding="utf-8") as f:
        for key in order:
            _, line = existing[key]
            f.write(line + "\n")

    print(f"[done] {path}: {len(dates)}日ぶん処理、{updated_races}/{len(order)}レースに払戻を追記")
    if missing_days:
        shown = missing_days[:10]
        more = "..." if len(missing_days) > 10 else ""
        print(f"[warn] {path}: 取得できなかった日 {len(missing_days)}日 {shown}{more}")


def main():
    for path in results_store.all_year_files():
        process_year_file(path)


if __name__ == "__main__":
    main()
