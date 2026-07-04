# -*- coding: utf-8 -*-
"""
毎朝1回、その日の番組表を公式から取得して data.js を更新するスクリプト（クラウド用）。
GitHub Actions の Ubuntu 上で動かす前提。lzh解凍は lhasa（ワークフロー側で apt install 済み）。

流れ: 今日の日付(JST) → b{YYMMDD}.lzh をDL → lhasa で解凍 → parse_program で変換 → data.js を書き出し

【今節の流れについて】
番組表の「今節成績」欄(着順のみ、前節混入なし)ではなく、選手カードに載せる
進入・ST・着順の推移は、貯めている results.jsonl(過去のレース結果)から
「選手(登番)・会場・今節の初日〜前日」で検索して復元する。
今節の初日は「開催の何日目か」と今日の日付から逆算する。
"""
import sys, os, glob, time, json, datetime, zoneinfo, subprocess, urllib.request, urllib.error
from collections import defaultdict
from parse_program import parse_program

JST = zoneinfo.ZoneInfo("Asia/Tokyo")
RESULTS_STORE = "results.jsonl"

def today_jst():
    return datetime.datetime.now(JST).date()

def load_results_index():
    """results.jsonl を 登番 → [(date, race_no, 進入, ST, 着順), ...] にインデックス化(会場込み)。"""
    idx = defaultdict(list)
    if not os.path.exists(RESULTS_STORE):
        return idx
    for line in open(RESULTS_STORE, encoding="utf-8"):
        try:
            r = json.loads(line)
        except Exception:
            continue
        for x in r.get("結果", []):
            idx[(x["登番"], r["会場"])].append((r["date"], r["レース番号"], x["進"], x.get("ST"), x["着"]))
    for key in idx:
        idx[key].sort()   # 日付・レース番号順(古い→新しい)
    return idx

def kon_setsu_flow(idx, touban, venue, day, today):
    """選手の「今節の流れ」(進入・ST・着順の推移、古い→新しい)を、開催日目と日付レンジから復元する。"""
    if not day:
        return None
    first_day = (today - datetime.timedelta(days=day - 1)).isoformat()
    today_iso = today.isoformat()
    rows = [rec for rec in idx.get((touban, venue), []) if first_day <= rec[0] < today_iso]
    return {
        "c": [rec[2] for rec in rows],   # 進入コース
        "s": [rec[3] for rec in rows],   # ST
        "r": [rec[4] for rec in rows],   # 着順
    }

def download(url, dest, tries=3):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    for i in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=30) as r, open(dest, "wb") as f:
                f.write(r.read())
            return True
        except urllib.error.HTTPError as e:
            if e.code == 404:
                print(f"[info] まだ公開されていない可能性 (404): {url}")
                return False
            print(f"[warn] HTTP {e.code} 再試行 {i+1}/{tries}")
        except Exception as e:
            print(f"[warn] {e} 再試行 {i+1}/{tries}")
        time.sleep(10)
    return False

def build():
    d = today_jst()
    yyyymm, yymmdd = d.strftime("%Y%m"), d.strftime("%y%m%d")
    url = f"https://www1.mbrace.or.jp/od2/B/{yyyymm}/b{yymmdd}.lzh"
    lzh = f"b{yymmdd}.lzh"
    print(f"[info] 取得対象: {d} → {url}")

    if not download(url, lzh):
        print("[stop] ダウンロード不可。data.js は更新せず終了（前回ぶんを維持）。")
        sys.exit(1)

    # lzh 解凍（lhasa は静かに展開）
    subprocess.run(["lhasa", "-xqw=.", lzh], check=True)
    txts = glob.glob("[Bb]" + yymmdd + ".[Tt][Xx][Tt]") or glob.glob("*.[Tt][Xx][Tt]")
    if not txts:
        print("[stop] 解凍後のテキストが見つからない。")
        sys.exit(1)
    txt = txts[0]
    print(f"[info] 解凍 → {txt}")

    races = parse_program(txt)
    if not races:
        print("[stop] レースが0件。今日は非開催か、書式変更の可能性。data.js は維持。")
        sys.exit(1)

    results_idx = load_results_index()

    # 表示用にフィールドを絞る（index.html が読む形）
    order, venues = [], {}
    for r in races:
        venues.setdefault(r["会場"], [])
        if r["会場"] not in order:
            order.append(r["会場"])
        venues[r["会場"]].append({
            "no": r["レース番号"], "dl": r["締切予定"],
            "boats": [{
                "n": b["艇番"], "t": b["登番"], "name": b["選手名"], "k": b["級別"], "age": b["年齢"],
                "br": b["支部"], "wt": b["体重"],
                "nw": b.get("全国勝率"), "nw2": b.get("全国2連率"),
                "lw": b.get("当地勝率"), "lw2": b.get("当地2連率"),
                "mo": b.get("モーター2連率"), "bo": b.get("ボート2連率"),
                "ks": kon_setsu_flow(results_idx, b["登番"], r["会場"], r["開催日目"], d),
            } for b in r["艇"]],
        })
    label = f"{d.year}年{d.month}月{d.day}日"
    out = {"date": label, "venues": [{"name": n, "races": venues[n]} for n in order]}

    js = "window.DATA = " + json.dumps(out, ensure_ascii=False, separators=(",", ":")) + ";\n"
    open("data.js", "w", encoding="utf-8").write(js)
    print(f"[done] data.js 更新: {len(order)}会場 / {len(races)}レース / {label}")

if __name__ == "__main__":
    build()
