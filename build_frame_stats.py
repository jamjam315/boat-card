#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
results/{年}.jsonl から「選手(登番) × 枠(艇番)」ごとの成績を集計して frames.js を作る。
朝の通知(プレミアム)で「この選手はこの枠が強い」を根拠つきで言うためのデータ。

出力: window.FRAMES = {
  "updated": 生成日, "from": 集計開始日, "to": 集計最終日, "min": 最低標本数,
  "th": {"1": 0.708, ...},                 枠ごとの「上位15%」の1着率(閾値)
  "avg": {"1": 0.552, ...},                枠ごとの全体の1着率(通知に併記する基準)
  "players": {"4082": {"1": [n, 1着, 3着内], ...}}
}

【avg(枠平均)を一緒に出す理由】
通知に「4枠で1着率17%」と書くと、4枠の水準を知らない人には低い数字に見える
(実際は4枠の平均が約10%なので、17%は上位15%に入る好成績)。基準となる枠平均を
併記して「4枠で1着率17%(平均10%)」と読めるようにするため、ここで一緒に書き出す。
閾値(th)と同じく、通知側にはコードに直書きさせない。
なお avg は標本30未満の選手も含めた全体の1着率(=その枠の素の水準)で、
th の分布(標本30以上の組だけ)とは母集団が違う。基準として見せるのは
「枠そのものの平均」であるべきなので、こちらは絞り込まない。

【期間を直近3年にした理由】
このサイトの他の集計(stats.js・players.js・backtest.js)は直近1年に揃えているが、
それらは全国5万レース規模をまとめる集計なので1年でも標本が足りる。一方この集計は
「選手1人 × 枠1つ」まで細かく割るため、1年だと標本が薄くなりすぎる。実測:
  1年 … 中央値32走。標本30以上に届く組は63%どまり
  3年 … 中央値97走。92%が30以上
  10年… 中央値275走。94%が30以上。ただし10年前の実力が今の判断に混ざる
「今の実力」と「言い切れるだけの標本」の釣り合いで3年を選んだ。

【最低標本数を30にした理由】
30走で1着率を出すと、1着が1本増減するだけで3.3ポイント動く。これ以上細かい
標本で「1着率◯%」と言い切るのは誇張になる。30未満の組は frames.js に載せない
(=通知で言及されない)。載せなければ、通知する側が「言えないことは言わない」形になる。

【閾値を枠ごとに出す理由】
1着率は枠によって水準がまったく違う(直近3年の全体: 1枠55.2% / 6枠3.0%)。
全枠共通のしきい値にすると1枠しか光らず、「5枠なのに1着率12%」という本当に
珍しいことを見逃す。枠ごとの分布の上位15%を閾値として一緒に書き出し、
通知側はそれを読むだけにする(閾値をコードに直書きしない=データが変われば
自動で追随する)。
"""
import json, datetime, statistics
import results_store

OUT = "frames.js"
YEARS = 3
MIN_N = 30            # この走数に満たない「登番×枠」は載せない
TOP_RATIO = 0.85      # 枠ごとの上位15%を閾値にする


def percentile(sorted_vals, p):
    if not sorted_vals:
        return None
    return sorted_vals[min(len(sorted_vals) - 1, int(len(sorted_vals) * p))]


def main():
    if not results_store.exists():
        print("[skip] results/ が無いので frames.js は作りません")
        return

    records = list(results_store.iter_records())
    if not records:
        print("[skip] results/ が空なので frames.js は作りません")
        return

    latest = max(r["date"] for r in records)
    cutoff = (datetime.date.fromisoformat(latest) - datetime.timedelta(days=365 * YEARS)).isoformat()

    # (登番, 枠) -> [出走, 1着, 3着内]
    tally = {}
    # 枠 -> [出走, 1着]。選手で割らない、その枠そのものの水準(通知に併記する平均)。
    frame_tally = {f: [0, 0] for f in range(1, 7)}
    for r in records:
        if r["date"] < cutoff:
            continue
        for b in r["結果"]:
            key = (b["登番"], b["艇"])
            row = tally.get(key)
            if row is None:
                row = [0, 0, 0]
                tally[key] = row
            row[0] += 1
            if b["着"] == 1:
                row[1] += 1
            if b["着"] <= 3:
                row[2] += 1
            total = frame_tally.get(b["艇"])
            if total is not None:
                total[0] += 1
                if b["着"] == 1:
                    total[1] += 1

    # 枠ごとの閾値(標本が足りる組だけで分布を作る)
    th = {}
    for frame in range(1, 7):
        rates = sorted(row[1] / row[0] for (t, f), row in tally.items()
                       if f == frame and row[0] >= MIN_N)
        if rates:
            th[str(frame)] = round(percentile(rates, TOP_RATIO), 4)

    # 枠ごとの全体の1着率(通知で「(平均◯%)」として見せる基準)
    avg = {str(f): round(t[1] / t[0], 4) for f, t in frame_tally.items() if t[0]}

    players = {}
    kept = 0
    for (toban, frame), row in tally.items():
        if row[0] < MIN_N:
            continue
        players.setdefault(toban, {})[str(frame)] = row
        kept += 1

    out = {
        "updated": datetime.date.today().isoformat(),
        "from": cutoff, "to": latest, "min": MIN_N,
        "th": th, "avg": avg, "players": players,
    }
    js = "window.FRAMES = " + json.dumps(out, ensure_ascii=False, separators=(",", ":")) + ";\n"
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(js)

    import os
    print(f"[done] {OUT} 更新: {len(players):,}選手 / {kept:,}組(標本{MIN_N}以上) / "
          f"期間 {cutoff}〜{latest} / {os.path.getsize(OUT):,} bytes")
    print("  枠ごとの閾値(上位15%の1着率): " +
          " ".join(f"{f}枠{th[f]:.1%}" for f in sorted(th)))
    print("  枠ごとの平均(全体の1着率): " +
          " ".join(f"{f}枠{avg[f]:.1%}" for f in sorted(avg)))


if __name__ == "__main__":
    main()
