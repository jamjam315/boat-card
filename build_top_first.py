# -*- coding: utf-8 -*-
"""
トップページの「最初の1画面ぶん」だけを小さく切り出して top-first.js に書く。

  python build_top_first.py

【なぜ要るのか】
トップは本文末尾で data.js など8本(gzip後で約101KB)を同期で読み終えてから描いていた。
Slow 4G 相当では、ヘッダーが出てから一覧が出るまで約1.5秒かかり、その大半が
ダウンロードだった(JSの実行と描画は合わせて約12ms)。

最初に見えるのは「会場の一覧」と「最初の会場(先頭)の1R」だけなので、それを描くのに
要る分を先に届け、残りは描いたあとで読む。data.js は 269KB あるが、最初の会場ぶんは
約22KB(gzip後で約3.7KB)しかない。

【中身】ページが描画で読むものの、最初の会場に関わる部分だけの写し。
  data          … 日付・生成時刻・全会場の名前 + 先頭の会場のレース
  players       … 先頭の会場に出る選手ぶん(ST・3着内率)
  motors        … 先頭の会場のモーターぶん(前回使用者)
  stats         … 全国の基準値 + 先頭の会場の傾向・天候・決まり手
  player_pages  … 上に出てくる登番のうち、選手ページがある人
  featured      … 注目選手(そのまま)

**数字は元のファイルから写すだけで、ここで計算しない。** 画面は後から本物の
data.js 等を読み、先出しと違うところがあれば描き直す(index.html の reconcile)。
先出しはあくまで「早く見せるための写し」で、正しさは本物のファイルが持つ。

【どこで作るか】daily.yml で data.js と同じコミットに入れる。stats.js / players.js は
深夜の results.yml で先に更新されているので、朝の data.js の時点で最新がそろう。
3つのワークフローそれぞれで作ると、同じファイルを同時にコミットして push が
衝突するので、ここ1か所にしてある。

変化が無ければ書き換えない(毎回コミットが増えないように)。sitemap には載せない
(HTMLではないので sitemap_util の対象にならない)。
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "top-first.js")


def load_js(name, var):
    """`window.VAR = {...};` の形のファイルを読む。無ければ None(ページの onerror と同じ扱い)。"""
    path = os.path.join(HERE, name)
    if not os.path.exists(path):
        print(f"[top-first] {name} がありません(null として扱います)")
        return None
    with open(path, encoding="utf-8") as f:
        text = f.read()
    prefix = f"window.{var}"
    start = text.index(prefix)
    body = text[text.index("=", start) + 1:].strip()
    if body.endswith(";"):
        body = body[:-1]
    return json.loads(body)


def build():
    data = load_js("data.js", "DATA")
    if not data or not data.get("venues"):
        sys.exit("[top-first] data.js が読めないか、会場が1つもありません。作りません。")

    first = data["venues"][0]
    races = first.get("races") or []
    venue = first["name"]

    # 全会場の名前(と、レース以外の項目)。会場のチップはこれで描ける。
    venues = [first] + [{k: v for k, v in x.items() if k != "races"} for x in data["venues"][1:]]
    top = {k: v for k, v in data.items() if k != "venues"}
    top["venues"] = venues

    tobans = set()
    mnos = set()
    for r in races:
        for b in r.get("boats") or []:
            if b.get("t"):
                tobans.add(str(b["t"]))
            if b.get("mno") is not None:
                mnos.add(b["mno"])

    players = load_js("players.js", "PLAYERS")
    if players is not None:
        players = dict(players)
        allp = players.get("players") or {}
        players["players"] = {t: allp[t] for t in sorted(tobans) if t in allp}

    motors = load_js("motors.js", "MOTORS")
    prev_tobans = set()
    if motors is not None:
        keep = {}
        for m in sorted(mnos):
            key = f"{venue}:{m}"
            if key in motors:
                keep[key] = motors[key]
                if motors[key] and motors[key].get("touban"):
                    prev_tobans.add(str(motors[key]["touban"]))
        motors = keep

    stats = load_js("stats.js", "STATS")
    if stats is not None:
        by_venue = ("venues", "venues_wx", "venues_kimarite")
        out = {k: v for k, v in stats.items() if k not in by_venue}
        for k in by_venue:
            if isinstance(stats.get(k), dict):
                out[k] = {venue: stats[k][venue]} if venue in stats[k] else {}
        stats = out

    featured = load_js("featured.js", "FEATURED")

    pages = load_js("players_index.js", "PLAYER_PAGES")
    if pages is not None:
        want = tobans | prev_tobans
        if featured and featured.get("toban"):
            want.add(str(featured["toban"]))
        have = set(str(t) for t in pages)
        pages = sorted(want & have)

    return {
        "v": 1,
        "venue": venue,
        "data": top,
        "players": players,
        "motors": motors,
        "stats": stats,
        "player_pages": pages,
        "featured": featured,
    }


def main():
    bundle = build()
    text = ("// 自動生成(build_top_first.py)。トップの最初の1画面ぶんの写し。手で直さないこと。\n"
            "window.TOP_FIRST = " + json.dumps(bundle, ensure_ascii=False, separators=(",", ":")) + ";\n")
    old = None
    if os.path.exists(OUT):
        with open(OUT, encoding="utf-8") as f:
            old = f.read()
    if old == text:
        print("[top-first] 変化なし(書き換えません)")
        return
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    races = len(bundle["data"]["venues"][0].get("races") or [])
    print(f"[top-first] 書き出しました {len(text.encode('utf-8')) / 1024:.1f}KB "
          f"/ 先頭の会場={bundle['venue']} {races}レース / 会場{len(bundle['data']['venues'])}")


if __name__ == "__main__":
    main()
