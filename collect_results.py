# -*- coding: utf-8 -*-
"""
結果(成績)データを集めて results.jsonl に貯めるスクリプト。

2つの使い方:
  python collect_results.py                 # 昨日ぶんを1日（毎晩の自動用）
  python collect_results.py --days 30       # 直近30日をまとめて（過去の一括取り込み用）

公式サーバーに優しく：1ファイルごとに数秒あけてダウンロードします。
"""
import sys, os, glob, time, json, datetime, zoneinfo, subprocess, urllib.request, urllib.error
from parse_results import parse_results

JST = zoneinfo.ZoneInfo("Asia/Tokyo")
STORE = "results.jsonl"
POLITE_WAIT = 3   # 秒（サーバー負荷をかけない礼儀）

def existing_keys():
    keys = set()
    if os.path.exists(STORE):
        for line in open(STORE, encoding="utf-8"):
            try:
                r = json.loads(line)
                keys.add(f'{r["date"]}:{r["会場"]}:{r["レース番号"]}')
            except Exception:
                pass
    return keys

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

def collect_one(date, keys, fout):
    yyyymm, yymmdd = date.strftime("%Y%m"), date.strftime("%y%m%d")
    url = f"https://www1.mbrace.or.jp/od2/K/{yyyymm}/k{yymmdd}.lzh"
    lzh = f"k{yymmdd}.lzh"
    if not download(url, lzh):
        return 0
    subprocess.run(["lhasa", "-xqw=.", lzh], check=True)
    txts = glob.glob("[Kk]" + yymmdd + ".[Tt][Xx][Tt]")
    if not txts:
        print(f"  [skip] 解凍後テキスト無し {yymmdd}"); return 0
    added = append_from_txt(txts[0], date.isoformat(), keys, fout)
    print(f"  {date}: {added}レース追加")
    return added

def append_from_txt(txt_path, date_iso, keys, fout):
    added = 0
    for r in parse_results(txt_path):
        key = f'{date_iso}:{r["会場"]}:{r["レース番号"]}'
        if key in keys:
            continue
        keys.add(key)
        rec = {"date": date_iso, "会場": r["会場"], "レース番号": r["レース番号"],
               "結果": [{"着": x["着順"], "艇": x["艇番"], "進": x["進入コース"],
                        "ST": x["ST"], "STt": x["ST種別"], "登番": x["登番"]}
                       for x in r["結果"]]}
        fout.write(json.dumps(rec, ensure_ascii=False) + "\n")
        added += 1
    return added

def main():
    days = 1
    start_offset = 1  # 既定は「昨日」
    if "--days" in sys.argv:
        days = int(sys.argv[sys.argv.index("--days") + 1])
    keys = existing_keys()
    today = datetime.datetime.now(JST).date()
    total = 0
    with open(STORE, "a", encoding="utf-8") as fout:
        for i in range(start_offset, start_offset + days):
            d = today - datetime.timedelta(days=i)
            total += collect_one(d, keys, fout)
            time.sleep(POLITE_WAIT)
    print(f"[done] 合計 {total}レース追加 / 総レコード見込み: {len(keys)}")

if __name__ == "__main__":
    main()
