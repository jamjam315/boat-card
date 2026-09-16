# -*- coding: utf-8 -*-
"""
風速帯×進入コースの「1着率リフト」を測る(AI-13)。読むだけで、何も書き換えない。

  python scripts/measure_wind_course.py            # 風速(5bと同じ3帯)
  python scripts/measure_wind_course.py --wave     # 波高(読み採点Dの4帯)の再現も出す

【何を測るか】読み採点の配点表(yomi.js の YOMI_TABLE)と同じ手法。
  リフト = その帯の1着率 − その帯に入った走者それぞれの「同じ会場×同じ進入コースの
           平均1着率」の平均(pt)
会場ごとの水面の差(インの強い場・弱い場)を消してから、風や波の効き目だけを見るため。

【数え方】
  - 期間: results/ にある全レース(2026-09時点で 2016-07-05〜)
  - コース: 進入コース(結果の "進")。答案は枠(艇番)で代用しているが、測るのは進入
  - 走者: 着順が数字の走者だけ(F・L・欠場など着の無い走者は母数に入れない)
  - 風速・波高が記録されていないレースは、その帯の集計から外す

【結果の置き場所】ここで出た数字(1着率 % と lift)を course1_wave_wind.json に手で写す。
自動では書き込まない(測り直すたびにレースページの数字が黙って動かないように)。
画面に出すのは全国の1コース平均と、帯ごとの1着率(%)だけ(AI-13c で pt の表示はやめた)。
2026-09-16 に測った値(〜2026-09-01・331万走):
  全国の1コース平均 55.2% (n=552,329)
  波高  0〜1cm +2.6pt (58.7%, n=192,506) / 2〜3cm −0.4pt (54.5%, n=246,166) /
        4〜5cm −3.0pt (51.7%, n=84,637) / 6cm以上 −4.9pt (48.4%, n=29,020)
  風速  〜2m +2.3pt (57.8%, n=270,498) / 3〜4m −1.2pt (54.2%, n=195,910) /
        5m以上 −4.6pt (49.6%, n=85,921)

【帯の % − 全国平均 は、lift と同じにならない】lift は「その会場の1コース平均」との差を
走者ごとに取っているので、会場の偏りが消えている。高い波や強い風は1コースの弱い会場に
偏って起きるため、全国平均から引くと差が大きく出る(6cm以上: 48.4 − 55.2 = −6.8、lift は −4.9)。

【波高について】読み採点 v1.1 の D 表とは、24セル中19セルが一致・残りは±0.1pt。
D 表の導出スクリプトはリポジトリに無く、母数の数え方が完全には同じでない
(表記は334万走、この数え方では331万走)。正式な揃え直しは v2 で行う。
"""
import argparse
import json
import os
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import data_paths  # noqa: E402
import results_store  # noqa: E402


def wind_band(v):
    if v is None:
        return None
    return "〜2m" if v <= 2 else "3〜4m" if v <= 4 else "5m以上"


def wave_band(v):
    if v is None:
        return None
    return "0〜1cm" if v <= 1 else "2〜3cm" if v <= 3 else "4〜5cm" if v <= 5 else "6cm以上"


def load_rows():
    files = results_store.all_year_files()
    if not files:
        sys.exit(data_paths.missing_message("results"))
    rows, dates = [], []
    for p in files:
        with open(p, encoding="utf-8") as f:
            for line in f:
                r = json.loads(line)
                res = r.get("結果") or []
                if not res:
                    continue
                dates.append(r["date"])
                for b in res:
                    course, chaku = b.get("進"), b.get("着")
                    if not isinstance(course, int) or not 1 <= course <= 6:
                        continue
                    if not isinstance(chaku, int):
                        continue
                    rows.append((r["会場"], course, r.get("風速"), r.get("波高"), 1 if chaku == 1 else 0))
    return rows, min(dates), max(dates)


def measure(rows, key, bandfn, bands):
    base_n, base_w = defaultdict(int), defaultdict(int)
    for venue, course, _wd, _wv, win in rows:
        base_n[(venue, course)] += 1
        base_w[(venue, course)] += win
    n, w, e = defaultdict(int), defaultdict(int), defaultdict(float)
    for venue, course, wd, wv, win in rows:
        b = bandfn(wd if key == "wind" else wv)
        if b is None:
            continue
        k = (course, b)
        n[k] += 1
        w[k] += win
        e[k] += base_w[(venue, course)] / base_n[(venue, course)]
    out = {}
    for course in range(1, 7):
        out[course] = []
        for b in bands:
            k = (course, b)
            if not n[k]:
                out[course].append({"band": b, "n": 0})
                continue
            out[course].append({
                "band": b,
                "lift": round((w[k] - e[k]) / n[k] * 100, 1),
                "rate": round(w[k] / n[k] * 100, 1),
                "n": n[k],
            })
    return out


def show(title, table):
    print(f"\n== {title}")
    for course, cells in table.items():
        parts = []
        for c in cells:
            if not c["n"]:
                parts.append(f'{c["band"]}: -')
            else:
                parts.append(f'{c["band"]}: {c["lift"]:+.1f}pt ({c["rate"]:.1f}%, n={c["n"]:,})')
        print(f"{course}コース  " + " / ".join(parts))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wave", action="store_true", help="波高(読み採点Dの4帯)も出す")
    a = ap.parse_args()
    print(data_paths.describe())
    rows, first, last = load_rows()
    print(f"期間 {first}〜{last} / 走者 {len(rows):,}")
    c1 = [r for r in rows if r[1] == 1]
    print(f"全国の1コース平均 {sum(r[4] for r in c1) / len(c1) * 100:.1f}% (n={len(c1):,})")
    show("風速×進入コース(1着率リフト)", measure(rows, "wind", wind_band, ["〜2m", "3〜4m", "5m以上"]))
    if a.wave:
        show("波高×進入コース(1着率リフト)",
             measure(rows, "wave", wave_band, ["0〜1cm", "2〜3cm", "4〜5cm", "6cm以上"]))


if __name__ == "__main__":
    main()
