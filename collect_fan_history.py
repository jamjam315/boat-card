# -*- coding: utf-8 -*-
"""
級別の履歴を作るために、過去の「ファン手帳(fan)」を期ごとに集めて保存する。

【なぜ要るのか】
級別(A1/A2/B1/B2)は結果ファイル(K票)に入っておらず、番組表(B票)は履歴を
2026-07-26からしか貯めていない。一方 fan は期ごとに公式が配っていて、
過去の期のファイルも今も取得できる(2026-07-29時点で fan1604 まで確認済み)。
1ファイルに「級別・前期級・前々期級」の3世代が入っているので、期ごとに集めれば
10年分の級別変遷が復元できる。

【期の対応(実データで確認済み)】
- fanYY04 … 審査期間 前年11月01日〜当年04月30日 (算出期2)
- fanYY10 … 審査期間 当年05月01日〜10月31日   (算出期1)
- fan2604 の級別は、2026-07-28のB票の級別と 864/864 完全一致した。
  つまり「審査期間の終了から約2か月後に適用が始まる」形になっている。

【保存先】(いずれも data ブランチ側)
  raw/F/fan{YYMM}.lzh … 公式の生データを圧縮のまま(K票・B票と同じ流儀)
  fan/{YYMM}.json     … パース済み(選手ごとの級別・勝率・出走数など)

fanは年2回しか更新されないので、このスクリプトは新しい期が出たときだけ
実行すればよい(既にあるファイルは再ダウンロードしない)。

使い方:
    python collect_fan_history.py            # 2016年から現在までの全期
    python collect_fan_history.py 2604       # 期を指定
"""
import sys, os, glob, json, time, shutil, subprocess, datetime
import urllib.request, urllib.error
from parse_fan import parse_fan
import data_paths

BASE_URL = "https://boatrace.jp/static_extra/pc_static/download/data/kibetsu/fan{}.lzh"
DATA_ROOT = data_paths.DATA_ROOT
RAW_DIR = os.path.join(DATA_ROOT, "raw", "F")
OUT_DIR = os.path.join(DATA_ROOT, "fan")
TMP_DIR = os.path.join(DATA_ROOT, "_fan_tmp")
START_YEAR = 16
POLITE_WAIT = 3
SEVENZIP = r"C:\Program Files\7-Zip\7z.exe"


def all_periods():
    """2016年前期から、今日より前に公開済みの期までを並べる。"""
    today = datetime.date.today()
    out = []
    for y in range(START_YEAR, today.year % 100 + 1):
        for mm in ("04", "10"):
            out.append(f"{y:02d}{mm}")
    return out


def download(period):
    dest = os.path.join(RAW_DIR, f"fan{period}.lzh")
    if os.path.isfile(dest) and os.path.getsize(dest) > 0:
        return dest, False
    os.makedirs(RAW_DIR, exist_ok=True)
    req = urllib.request.Request(BASE_URL.format(period), headers={"User-Agent": "Mozilla/5.0"})
    tmp = dest + ".part"
    try:
        with urllib.request.urlopen(req, timeout=30) as r, open(tmp, "wb") as f:
            f.write(r.read())
        os.replace(tmp, dest)
        return dest, True
    except urllib.error.HTTPError as e:
        if e.code == 404:
            print(f"  [skip] fan{period} はまだ公開されていません (404)")
        else:
            print(f"  [warn] fan{period}: HTTP {e.code}")
        return None, True
    except Exception as e:
        print(f"  [warn] fan{period}: {e}")
        return None, True


def extract(lzh, period):
    shutil.rmtree(TMP_DIR, ignore_errors=True)
    os.makedirs(TMP_DIR, exist_ok=True)
    for cmd in ([SEVENZIP, "x", "-y", f"-o{TMP_DIR}", lzh],
                ["lhasa", "-xqw=" + TMP_DIR, lzh]):
        try:
            subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL)
            break
        except FileNotFoundError:
            continue
    hits = glob.glob(os.path.join(TMP_DIR, f"[Ff][Aa][Nn]{period}.[Tt][Xx][Tt]"))
    return hits[0] if hits else None


def main():
    periods = [sys.argv[1]] if len(sys.argv) > 1 else all_periods()
    os.makedirs(OUT_DIR, exist_ok=True)
    print(f"[start] {len(periods)}期 / data root = {DATA_ROOT}")

    made = skipped = 0
    for period in periods:
        out_path = os.path.join(OUT_DIR, f"{period}.json")
        if os.path.isfile(out_path):
            skipped += 1
            continue

        lzh, did_dl = download(period)
        if not lzh:
            if did_dl:
                time.sleep(POLITE_WAIT)
            continue

        txt = extract(lzh, period)
        if not txt:
            print(f"  [warn] fan{period}: 解凍後のテキストが見つかりません")
            continue

        players = parse_fan(txt)
        if not players:
            print(f"  [warn] fan{period}: 0選手。書式が違う可能性があります")
            continue

        # 級別の履歴に必要な項目だけに絞って保存する(元の全項目は raw/F に残っている)。
        slim = [{
            "登番": p["登番"], "氏名": p["氏名"], "支部": p.get("支部"),
            "級別": p["級別"], "前期級": p.get("前期級"), "前々期級": p.get("前々期級"),
            "勝率": p.get("勝率"), "複勝率": p.get("複勝率"),
            "出走回数": p.get("出走回数"), "1着回数": p.get("1着回数"), "2着回数": p.get("2着回数"),
        } for p in players]
        meta = {
            "period": period,
            "算出年": players[0].get("算出年"), "算出期": players[0].get("算出期"),
            "算出期間": players[0].get("算出期間"),
            "players": slim,
        }
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, separators=(",", ":"))
        made += 1
        print(f"  fan{period}: {len(slim)}選手 → {os.path.relpath(out_path, DATA_ROOT)} "
              f"({os.path.getsize(out_path):,} bytes)")
        if did_dl:
            time.sleep(POLITE_WAIT)

    shutil.rmtree(TMP_DIR, ignore_errors=True)
    print(f"[done] 新規{made}期 / 既存スキップ{skipped}期")


if __name__ == "__main__":
    main()
