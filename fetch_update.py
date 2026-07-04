# -*- coding: utf-8 -*-
"""
毎朝1回、その日の番組表を公式から取得して data.js を更新するスクリプト（クラウド用）。
GitHub Actions の Ubuntu 上で動かす前提。lzh解凍は lhasa（ワークフロー側で apt install 済み）。

流れ: 今日の日付(JST) → b{YYMMDD}.lzh をDL → lhasa で解凍 → parse_program で変換 → data.js を書き出し

【選手カードの「流れ」について】
選手カードに載せる進入・ST・着順の推移は、貯めている results.jsonl(過去のレース結果)から
「選手(登番)・会場・今節の初日〜前日」で検索して復元する(今節の初日は「開催の何日目か」と
今日の日付から逆算)。今節にまだ十分な走り(2走以上)が無い場合は、節の序盤で寂しい表示に
ならないよう、過去1か月・全会場での直近の走りに切り替えて見せる(どちらを見せているかは
data.js側に "which":"今節"/"直近" として残し、表示側でラベルを分ける)。
"""
import sys, os, glob, time, json, datetime, zoneinfo, subprocess, urllib.request, urllib.error
from collections import defaultdict
from parse_program import parse_program

JST = zoneinfo.ZoneInfo("Asia/Tokyo")
RESULTS_STORE = "results.jsonl"
MIN_KON_SETSU = 2   # 今節の走行数がこれ未満なら「直近」にフォールバック
RECENT_DAYS = 30     # 「直近」の対象期間

def today_jst():
    return datetime.datetime.now(JST).date()

def load_results_index():
    """results.jsonl を以下の2通りにインデックス化する。
      by_venue: (登番,会場) → [(date, race_no, 進入, ST, 着順), ...]   … 今節(同一会場)の検索用
      by_player: 登番 → [(date, venue, race_no, 進入, ST, 着順), ...]  … 直近(全会場)の検索用
    """
    by_venue = defaultdict(list)
    by_player = defaultdict(list)
    if not os.path.exists(RESULTS_STORE):
        return by_venue, by_player
    for line in open(RESULTS_STORE, encoding="utf-8"):
        try:
            r = json.loads(line)
        except Exception:
            continue
        for x in r.get("結果", []):
            by_venue[(x["登番"], r["会場"])].append(
                (r["date"], r["レース番号"], x["進"], x.get("ST"), x["着"]))
            by_player[x["登番"]].append(
                (r["date"], r["会場"], r["レース番号"], x["進"], x.get("ST"), x["着"]))
    for key in by_venue:
        by_venue[key].sort()
    for key in by_player:
        by_player[key].sort()
    return by_venue, by_player

def player_flow(by_venue, by_player, touban, venue, day, today):
    """選手の「今節」または「直近」の流れ(進入・ST・着順の推移、古い→新しい)を復元する。
    今節(同一会場・開催の初日〜前日)に十分な走りがあればそれを、無ければ過去1か月・
    全会場の直近成績に切り替える。
    """
    today_iso = today.isoformat()
    which = "今節"
    rows = []
    if day:
        first_day = (today - datetime.timedelta(days=day - 1)).isoformat()
        rows = [rec for rec in by_venue.get((touban, venue), []) if first_day <= rec[0] < today_iso]

    if len(rows) < MIN_KON_SETSU:
        which = "直近"
        start = (today - datetime.timedelta(days=RECENT_DAYS)).isoformat()
        rows = [rec[0:1] + rec[2:] for rec in by_player.get(touban, []) if start <= rec[0] < today_iso]

    return {
        "which": which,
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

    by_venue, by_player = load_results_index()

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
                "ks": player_flow(by_venue, by_player, b["登番"], r["会場"], r["開催日目"], d),
            } for b in r["艇"]],
        })
    label = f"{d.year}年{d.month}月{d.day}日"
    out = {"date": label, "venues": [{"name": n, "races": venues[n]} for n in order]}

    js = "window.DATA = " + json.dumps(out, ensure_ascii=False, separators=(",", ":")) + ";\n"
    open("data.js", "w", encoding="utf-8").write(js)
    print(f"[done] data.js 更新: {len(order)}会場 / {len(races)}レース / {label}")

if __name__ == "__main__":
    build()
