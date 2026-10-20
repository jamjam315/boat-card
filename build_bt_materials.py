# -*- coding: utf-8 -*-
"""
バックテスト(条件指定)の「艇の材料」を月ごとのファイルに書き出す(2026-10-20)。

  python build_bt_materials.py --all          … 全期間を作り直す(手元で。過去の番組表のキャッシュが要る)
  python build_bt_materials.py --days 3       … 直近3日が入る月だけ作り直す(毎晩の results.yml)

【材料】1艇ごとに5つ。どれも「そのレースの朝に分かっていた値」だけを使う。
  級別        … 番組表(B票)
  全国勝率    … 番組表。同じ節の中では変わらない(2026-10-20 に71,333件で確認)。結果から計算し直すと
                公式の値と合わないので、当時の番組表の値そのものを使う
  モーター2連率 … 番組表
  平均ST      … 朝の data.js(fetch_update.player_flow)と同じ決め方で、結果から作る:
                今節(同じ会場・節の初日〜前日)に2走以上あればその走、無ければ直近30日・全会場の走。
                当日以降の走は入れない(同じ日の前のレースも入れない。朝の時点と同じ)。
                F の ST もそのまま平均に入れる(data.js と同じ)
  直近3走の平均着 … 上と同じ走のうち、着のある最後の3走の平均(2走以上あるときだけ。yomi.js fromKs と同じ)
番組表の選手と、実際に走った選手が違う艇(選手交代)は、番組表の3つを不明にする(別の人の値なので)。

【置き場所と形】backtest-data/mat/(ブラウザが直接読む。材料を使う条件のときだけ)
  mat/all/{YYYY-MM}.json      … 全国のその月の全レース
  mat/{ローマ字}/{YYYY-MM}.json … 会場ごと(会場を選んだ検証が全国ぶんを読まずに済むように)
  mat/meta.json               … どの月があるか・詰め方の版
  1行 = [鍵, 1号艇, 2号艇, …, 6号艇]
    鍵 = 日 × 10000 + 会場コード × 100 + レース番号(会場コードは meta.json の venues の code)
    艇 = 5つを1つの整数に詰めたもの(51ビット。JavaScript の数で正確に扱える 53 ビットに収まる):
         級別 + 8 × (全国勝率×100 + 1024 × (モーター2連率×100 + 16384 × (平均ST×10000 + 16384 × 直近平均着×100)))
         級別 0=A1 1=A2 2=B1 3=B2 7=不明 / 全国勝率・直近平均着は 1023=不明 / モーター2連率・平均STは 16383=不明
    精度は帯の境目をまたがないように決めた。全国勝率・モーター2連率は番組表が小数2桁なのでそのまま。
    平均STは小数2桁の ST の平均なので、0.14 の手前の値は 0.14 から少なくとも 0.01/走数 離れている。
    ×10000 の丸め(±0.00005)なら 200走まで境目をまたがない(×1000 では 0.1395 が 0.140 になり帯がずれた)
  月で分けるのは git の履歴のため。毎晩書き換わるのは今月(と月初は前月)のファイルだけになる。

【入力】data ブランチの results/ と program/(data_paths が場所を決める)。
番組表は 2026-07-26 から data ブランチにあり、それより前は手元のキャッシュ
(scripts/fetch_program_archive.py の program/。環境変数 TEIYOMI_PROGRAM_CACHE)から読む。
毎晩の CI はキャッシュを持たないので、番組表がそろっていない月は書き換えない(下の守り)。
"""
import argparse
import bisect
import collections
import datetime
import glob
import json
import os
import sys
import zoneinfo

import program_store
import results_store

JST = zoneinfo.ZoneInfo("Asia/Tokyo")
BASE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(BASE, "backtest-data", "mat")
META_IN = os.path.join(BASE, "backtest-data", "meta.json")
CACHE = os.environ.get("TEIYOMI_PROGRAM_CACHE", "F:/dev/boat-card-cache")

MIN_KON_SETSU = 2      # fetch_update.py と同じ。今節がこれ未満なら直近30日
RECENT_DAYS = 30
MIN_FORM_RACES = 2     # yomi.js fromKs と同じ。着が2走未満なら調子は出さない
MIN_PROGRAM_SHARE = 0.9   # 番組表がこの割合に満たない月は書き換えない(材料を不明で上書きしないため)

K_CODE = {"A1": 0, "A2": 1, "B1": 2, "B2": 3}
NONE10 = 1023
NONE14 = 16383


def pack(k, nw, mo, st, fm):
    """1艇の材料を1つの整数にする(docstring の式)。不明は None で渡す。"""
    def q(v, scale, top):
        if v is None:
            return top
        x = int(round(v * scale))
        return x if 0 <= x < top else top
    kk = K_CODE.get(k, 7)
    return kk + 8 * (q(nw, 100, NONE10) + 1024 * (q(mo, 100, NONE14) + 16384 * (q(st, 10000, NONE14)
                                                                         + 16384 * q(fm, 100, NONE10))))


def iter_results(year):
    """results/{年}.jsonl を1件ずつ。壊れた行は飛ばす(results_store.iter_records と同じ作法)。"""
    with open(results_store.year_file_path(str(year)), encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except ValueError:
                continue


def load_venues():
    with open(META_IN, encoding="utf-8") as f:
        return {v["name"]: v for v in json.load(f)["venues"]}


def program_records(years):
    """番組表を (date, 会場, R) → (開催日目, {艇番: (登番, 級別, 全国勝率, モーター2連率)}) で返す。
    data ブランチを先に、無い分をキャッシュから。10年分を丸ごと持つと数GBになるので、使う項目だけにする。"""
    out = {}

    def add(r, overwrite):
        k = (r["date"], r["会場"], r["レース番号"])
        if overwrite or k not in out:
            out[k] = (r.get("開催日目"), {b["艇"]: (b["登番"], b.get("級"), b.get("全国"), b.get("モ2"))
                                       for b in r.get("艇", [])})
    for y in years:
        if os.path.isfile(program_store.year_file_path(str(y))):
            for r in program_store.iter_records(str(y)):
                add(r, True)
        cache = os.path.join(CACHE, "program", f"{y}.jsonl")
        if os.path.isfile(cache):
            with open(cache, encoding="utf-8") as f:
                for line in f:
                    add(json.loads(line), False)
    return out


def months_for(a):
    """作り直す月の一覧(YYYY-MM)。"""
    if a.month:
        return sorted(set(a.month))
    if a.days:
        today = datetime.datetime.now(JST).date()
        return sorted({(today - datetime.timedelta(days=i)).strftime("%Y-%m") for i in range(a.days + 1)})
    # --all: 結果がある全期間
    return None


def build(months):
    venues = load_venues()
    years_needed = set()
    if months:
        for m in months:
            y = int(m[:4])
            years_needed |= {y, y - 1}   # 月初の直近30日・今節は前の年にかかる
    # 結果: 選手ごとの走り(日付, 会場, R, ST, 着)と、対象月のレース
    by_player = collections.defaultdict(list)
    races = []
    if not results_store.exists():
        raise FileNotFoundError("results/ が見つかりません(data_paths.py の説明を参照)")
    years = sorted(int(os.path.basename(p)[:4]) for p in results_store.all_year_files())
    for y in years:
        if months and y not in years_needed:
            continue
        for r in iter_results(y):
            for x in r.get("結果", []):
                by_player[x["登番"]].append((r["date"], r["会場"], r["レース番号"], x.get("ST"), x.get("着")))
            if not months or r["date"][:7] in months:
                # 払戻などは使わないので、レースは鍵と「どの艇に誰が乗ったか」だけを持つ
                races.append((r["date"], r["会場"], r["レース番号"],
                              {x["艇"]: x["登番"] for x in r.get("結果", [])}))
    for k in by_player:
        by_player[k].sort(key=lambda v: (v[0], v[2]))
    dates_of = {k: [v[0] for v in vs] for k, vs in by_player.items()}
    earliest_all = min((vs[0][0] for vs in by_player.values()), default=None)
    prog = program_records(sorted({int(r[0][:4]) for r in races}))
    print(f"[mat] 対象 {len(races):,}レース / 番組表 {len(prog):,}レース / 選手 {len(by_player):,}人")

    def flow(t, venue, d, day):
        """朝の data.js の ks と同じ走り(今節 or 直近30日)。当日以降は入れない。"""
        a, ds = by_player.get(t, []), dates_of.get(t, [])
        hi = bisect.bisect_left(ds, d)
        rows = []
        if day:
            first = (datetime.date.fromisoformat(d) - datetime.timedelta(days=day - 1)).isoformat()
            if earliest_all and first < earliest_all:
                return None, None      # 結果の始まりより前に始まった節は、今節の走りがそろわない
            lo = bisect.bisect_left(ds, first)
            rows = [v for v in a[lo:hi] if v[1] == venue]
        if len(rows) < MIN_KON_SETSU:
            start = (datetime.date.fromisoformat(d) - datetime.timedelta(days=RECENT_DAYS)).isoformat()
            if earliest_all and start < earliest_all:
                return None, None      # 結果の始まり(2016-07-05)から30日たたないうちは、直近30日がそろわない
            lo = bisect.bisect_left(ds, start)
            rows = a[lo:hi]
        st = [v[3] for v in rows if isinstance(v[3], (int, float))]
        fin = [v[4] for v in rows if isinstance(v[4], int)]
        return (sum(st) / len(st) if st else None,
                sum(fin[-3:]) / len(fin[-3:]) if len(fin) >= MIN_FORM_RACES else None)

    out = collections.defaultdict(list)     # (セット, 月) → 行
    stats = collections.Counter()
    for date, venue, rno, actual in races:
        v = venues.get(venue)
        if not v:
            stats["会場不明"] += 1
            continue
        day, pboats = prog.get((date, venue, rno), (None, {}))
        stats["番組表あり" if pboats else "番組表なし"] += 1
        cells = []
        for n in range(1, 7):
            b = pboats.get(n)                 # (登番, 級別, 全国勝率, モーター2連率)
            t = actual.get(n) or (b[0] if b else None)
            # 番組表の選手と実際に走った選手が違う(選手交代)なら、番組表の値は別の人のものなので使わない
            same = bool(b) and (n not in actual or actual[n] == b[0])
            if b and not same:
                stats["選手交代"] += 1
            st, fm = flow(t, venue, date, day) if t else (None, None)
            cells.append(pack(b[1] if same else None, b[2] if same else None, b[3] if same else None, st, fm))
        key = int(date[8:10]) * 10000 + v["code"] * 100 + rno
        m = date[:7]
        out[("all", m)].append([key] + cells)
        out[(v["romaji"], m)].append([key] + cells)
    return out, stats


def write(out, stats, months):
    # 守り: 番組表がそろっていない月(CI でキャッシュの無い期間など)は、既にあるファイルを上書きしない
    share = collections.defaultdict(lambda: [0, 0])
    for (s, m), rows in out.items():
        if s != "all":
            continue
        for row in rows:
            share[m][1] += 1
            share[m][0] += 1 if any((c % 8) != 7 for c in row[1:]) else 0
    skip = {m for m, (ok, n) in share.items() if n and ok / n < MIN_PROGRAM_SHARE}
    for m in sorted(skip):
        print(f"[mat] {m} は番組表が {share[m][0]}/{share[m][1]} レースしか無いので書き換えません")
    written = 0
    for (s, m), rows in sorted(out.items()):
        if m in skip:
            continue
        rows.sort()
        path = os.path.join(OUT, s, f"{m}.json")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            json.dump({"v": 1, "month": m, "rows": rows}, f, separators=(",", ":"))
        written += 1
    # meta.json: セットごとの月の一覧(実際にあるファイルから作る)
    sets = {}
    for d in sorted(glob.glob(os.path.join(OUT, "*", ""))):
        name = os.path.basename(os.path.dirname(d))
        sets[name] = sorted(os.path.basename(p)[:7] for p in glob.glob(os.path.join(d, "*.json")))
    with open(os.path.join(OUT, "meta.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump({"v": 1, "generated_at": datetime.datetime.now(JST).strftime("%Y-%m-%dT%H:%M:%S"),
                   "sets": sets}, f, ensure_ascii=False, separators=(",", ":"))
    print(f"[mat] 書き出し {written}ファイル / {dict(stats)}")
    if skip and months:
        # 毎晩の CI で今月が書けないのは、番組表の取り込みが止まっている印。気づけるよう非0で終わる
        sys.exit(1)


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--all", action="store_true")
    g.add_argument("--days", type=int)
    g.add_argument("--month", action="append", help="YYYY-MM(複数可)")
    a = ap.parse_args()
    months = months_for(a)
    out, stats = build(months)
    write(out, stats, months)


if __name__ == "__main__":
    main()
