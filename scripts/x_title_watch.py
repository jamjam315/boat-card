# -*- coding: utf-8 -*-
"""
二つ名の週次の変化を見つけて、1週に最大1件だけXへ投稿する。

  python scripts/x_title_watch.py [--dry-run]

【全体の流れ】
  build_profiles_v5 と同じ計算で「今週の二つ名」を出し、前回の状態
  (x_state/title_state.json)と突き合わせて1件だけ選び、文面にして投稿する。
  ついでに変化した人だけを titles_history.json へ追記する。選手ページの
  「二つ名の変遷」は、このファイルを読んで焼き込む。

【昇級ウォッチ(x_kyusoku_watch.py)との違い】
昇級のほうは kyusoku.json という「その日の出来上がり」を読むので、初回は
比較相手が無く、判定せず保存だけして終わる。二つ名は results から
**任意の日付で計算し直せる**ので、初回は1週間前の姿を自分で作って比べる。
初週から本物の差分が出るし、状態ファイルを失っても復旧できる。

【比較の基準は as_of(データの最新日)。generated_at は使わない】
昇級ウォッチと同じ理由。再生成のたびに動く値で比べると、中身が同じでも
「変化した」ことになる。as_of が同じなら二つ名の計算結果も完全に一致する。

【応援アカウントとしての掟】
称号を失った人の名前は、絶対に出さない。「主」でなくなった選手も、巧者から
外れた選手も、名前は出さずに人数にだけ反映する。名指しで出すのは
「主」が新しく付いた人だけ。人の成績が下がったことを広める道具にはしない。

【事故を構造で防ぐ】
  - as_of が前回と同じ週は投稿しない(結果データがまだ更新されていない)
  - 同じ日に2回は投稿しない(last_posted_date で見張る)
  - 投稿は x_post.post() 経由。1実行1投稿・リトライ無し・失敗は非0終了
  - 投稿に失敗したら状態を更新しない。翌週、同じ変化がもう一度拾われる
"""
import argparse
import datetime
import json
import os
import sys
import zoneinfo

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import x_post

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)
import build_profiles_v5 as B
import results_store

JST = zoneinfo.ZoneInfo("Asia/Tokyo")
STATE_PATH = os.path.join(REPO, "x_state", "title_state.json")
HISTORY_PATH = os.path.join(REPO, "titles_history.json")
TAGS = "#ボートレース #競艇"

# 前の週をどれだけ遡って作るか。投稿も週1回なので7日。
WEEK_DAYS = 7


def md(date_iso):
    """"2026-09-08" -> "9/8"。ゼロ埋めしない。"""
    d = datetime.date.fromisoformat(date_iso)
    return f"{d.month}/{d.day}"


def load_json(path, default=None):
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8") as f:
        return json.load(f)


# ---------------------------------------------------------------- 二つ名の計算

def load_records():
    """results を1回だけ読んで、必要な列だけ持つ。

    全列を抱えると10年ぶんでメモリが持たないので、
    (日付, 会場, 決まり手, [(登番, 着, ST), ...]) まで削って持つ。"""
    slim = []
    for r in results_store.iter_records():
        slim.append((r["date"], r.get("会場"), r.get("決まり手"),
                     [(x.get("登番"), x.get("着"), x.get("ST")) for x in r.get("結果", [])]))
    return slim


def k_stats(rows, as_of):
    """build_profiles_v5.load_k_stats() の窓だけを as_of に差し替えたもの。

    あちらは「データの最新日から365日前まで」を results 全体から決めるが、
    ここでは過去の任意の週を再現したいので、最新日を引数で受ける。
    窓の切り方(365日・cutoff以上)と集計内容は同じにしてあり、
    片方だけ変えると二つ名が食い違うので、直すときは必ず両方を見ること。"""
    from collections import Counter, defaultdict
    latest = datetime.date.fromisoformat(as_of)
    cutoff = (latest - datetime.timedelta(days=365)).isoformat()
    nat = Counter()
    players = defaultdict(lambda: {"kwin": Counter(), "sts": [],
                                   "venue": defaultdict(lambda: {"n": 0, "w1": 0})})
    for date, venue, kimarite, res in rows:
        if date < cutoff or date > as_of:
            continue
        for touban, chaku, st in res:
            p = players[touban]
            v = p["venue"][venue]
            v["n"] += 1
            if st is not None:
                p["sts"].append(st)
            if chaku == 1:
                v["w1"] += 1
                if kimarite:
                    p["kwin"][kimarite] += 1
                    nat[kimarite] += 1
    total = sum(nat.values()) or 1
    nat_pct = {k: nat.get(k, 0) / total * 100 for k in B.KIMARITE_ORDER}
    return players, nat_pct


def titles(rows, as_of, fan):
    """その日時点の全選手の二つ名。{登番: {c,m,v,n,w,d}}

    c=二つ名 / m=「主」か / v=ホーム会場 / n=当地走数 / w=当地1着率 / d=他会場との差。
    ks(今節の流れ)と展示ラベルは二つ名に影響しないので、計算しない
    (週次で全選手ぶん回すので、要らないものは積まない)。"""
    players, nat_pct = k_stats(rows, as_of)
    out = {}
    for touban, fan_p in fan.items():
        k_p = players.get(touban)
        try:
            prof = B.build_profile(touban, fan_p, k_p, nat_pct, {}, {},
                                   venue_today=None, day_today=None,
                                   today_iso=None, tenji_label=None)
        except Exception as e:      # 1人の欠損で週次を止めない
            print(f"[title] {touban} の二つ名を作れませんでした: {e}")
            continue
        home = prof["home"] or {}
        out[touban] = {
            "c": prof["catch"],
            "m": bool(prof["home_master"]),
            "v": home.get("venue"),
            "n": home.get("n"),
            "w": round(home["win"], 1) if home.get("win") is not None else None,
            "d": round(home["diff"], 1) if home.get("diff") is not None else None,
            "name": fan_p.get("氏名"),
        }
    return out


def master_pool(rows, as_of, fan):
    """「主」の予備軍。数字は主の水準だが、当地の走行数が足りない人の数。

    build_profiles_v5 の判定をそのまま呼ぶ。ここで独自に条件を書くと、
    称号の定義が2か所に分かれて食い違う。"""
    players, _ = k_stats(rows, as_of)
    n = 0
    for touban in fan:
        k_p = players.get(touban)
        if not k_p:
            continue
        home = B.home_venue(k_p)
        if home and not B.is_master(home) and B.is_master_grade(home):
            n += 1
    return n


# ---------------------------------------------------------------- 差分

def is_kosha(v):
    return bool(v.get("c")) and "巧者" in v["c"]


def diff_titles(prev, cur):
    """前週と今週を突き合わせる。共通の登番だけを見る
    (期替わりで fan から消えた・現れた人を「変化」にしない)。"""
    common = [t for t in cur if t in prev]
    return {
        "changed": [t for t in common if cur[t]["c"] != prev[t]["c"]],
        # 「主」になった人だけ。失った人は数えるだけで名前は持ち回らない。
        "master_born": [t for t in common if cur[t]["m"] and not prev[t]["m"]],
        "master_lost": sum(1 for t in common if prev[t]["m"] and not cur[t]["m"]),
        "kosha_born": [t for t in common if is_kosha(cur[t]) and not is_kosha(prev[t])],
        "kosha_lost": sum(1 for t in common if is_kosha(prev[t]) and not is_kosha(cur[t])),
    }


def top_venue(cur, tobans):
    """新しく巧者になった人が、どの会場でいちばん増えたか。(会場, 人数) か (None, 0)。"""
    from collections import Counter
    c = Counter(cur[t]["v"] for t in tobans if cur[t].get("v"))
    if not c:
        return None, 0
    venue, n = c.most_common(1)[0]
    return venue, n


# ---------------------------------------------------------------- 文面

def text_master_born(cur, toban, as_of):
    v = cur[toban]
    return (f"二つ名ウォッチ🚤 {md(as_of)}\n"
            f"{v['name']}選手に「{v['v']}の主」が付きました。\n"
            f"当地{v['n']}走・1着率{v['w']}%(他会場より+{v['d']}pt)。\n"
            f"称号の中でいちばん重い名前です。\n"
            f"{TAGS}")


def master_line(n_master, lead="現在の"):
    """「主」の人数を伝える一行。まとめ(A)と予備軍(C)の両方から呼ぶ。

    0人の週は実在する(実測で 2026-07-21 がそうだった)。
    「0人だけです」は日本語として壊れるので、そこだけ言い切りの文へ差し替える。
    空位は空位のまま、飾らずに出す。"""
    if n_master == 0:
        return "いま「主」の称号を持つ選手は、全国にひとりもいません。"
    return f"{lead}「主」は全国で{n_master}人だけです。"


def text_pool(pool, n_master, as_of):
    return (f"二つ名ウォッチ🚤 {md(as_of)}\n"
            f"「主」の水準に届いている選手が{pool}人。あと数走で称号が変わるかもしれません。\n"
            f"{master_line(n_master)}\n"
            f"{TAGS}")


def text_weekly(d, cur, as_of):
    n_kosha = sum(1 for v in cur.values() if is_kosha(v))
    n_master = sum(1 for v in cur.values() if v["m"])
    venue, vn = top_venue(cur, d["kosha_born"])
    # 会場が割り出せない週(新しい巧者が0人など)は、その一文を落とす。
    # 「いちばん増えたのは—(0人)」と書くより、書かないほうがよい。
    lead = f"新しく「◯◯巧者」の称号が付いたのは{len(d['kosha_born'])}人。"
    if venue:
        lead += f"いちばん増えたのは{venue}({vn}人)。"
    return (f"今週の二つ名ウォッチ🚤 {md(as_of)}\n"
            f"{lead}\n"
            f"全国の巧者{n_kosha}人。{master_line(n_master, lead='')}\n"
            f"{TAGS}")


# ---------------------------------------------------------------- 判定

def decide(d, cur, pool, prev_pool, as_of):
    """投稿する1件を決める。(種別, 本文) か (None, 理由) を返す。

    優先順位: 主の誕生 > 予備軍が動いた週 > 週次まとめ。
    「主」を失った週は単独で投稿しない。全国に1人しかいない称号なので、
    失ったことを投稿すると実質その人を名指しすることになる
    (掟「落ちた人の名前は出さない」に抵触する)。まとめの人数にだけ反映する。"""
    if d["master_born"]:
        # 同じ週に2人以上生まれることは実測上ほぼ無いが、起きたら当地走数の多い順に1人。
        t = sorted(d["master_born"], key=lambda x: -(cur[x]["n"] or 0))[0]
        return "master", text_master_born(cur, t, as_of)

    if prev_pool is not None and pool != prev_pool:
        n_master = sum(1 for v in cur.values() if v["m"])
        return "pool", text_pool(pool, n_master, as_of)

    return "weekly", text_weekly(d, cur, as_of)


# ---------------------------------------------------------------- 保存

def save_state(cur, pool, as_of, last_posted, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    out = {
        "as_of": as_of,
        "last_posted_date": last_posted,
        "master_pool": pool,
        # 差分に要るものだけ。名前や勝率まで持つと、次回の計算結果と
        # 二重持ちになって片方だけ古くなる。
        "t": {t: v["c"] for t, v in cur.items()},
        "m": sorted(t for t, v in cur.items() if v["m"]),
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"[title] 状態を保存しました as_of={as_of} "
          f"last_posted_date={last_posted} 選手={len(out['t'])}人 "
          f"主={len(out['m'])}人 予備軍={pool}人")


def append_history(changed, cur, as_of, path):
    """変化した人だけを追記する。全員ぶん毎週足すと年に数十MBになる。

    同じ as_of で二度書かない(再実行しても履歴が重複しない)。"""
    hist = load_json(path, default={}) or {}
    added = 0
    for t in changed:
        rows = hist.setdefault(t, [])
        if rows and rows[-1].get("d") == as_of:
            continue
        rows.append({"d": as_of, "c": cur[t]["c"]})
        added += 1
    with open(path, "w", encoding="utf-8") as f:
        json.dump(hist, f, ensure_ascii=False, separators=(",", ":"))
    size = os.path.getsize(path)
    print(f"[title] 変遷を追記しました +{added}件 / 累計{len(hist)}人 "
          f"({size / 1024:.0f}KB)")


# ---------------------------------------------------------------- 本体

def main():
    p = argparse.ArgumentParser(description="二つ名の週次の変化をXへ投稿する")
    p.add_argument("--dry-run", action="store_true", help="投稿せず、本文だけ出す")
    p.add_argument("--state", default=STATE_PATH)
    p.add_argument("--history", default=HISTORY_PATH)
    p.add_argument("--today", help="テスト用。今日(JST)を YYYY-MM-DD で上書きする")
    a = p.parse_args()

    today = (datetime.date.fromisoformat(a.today) if a.today
             else datetime.datetime.now(JST).date())

    fan = B.load_fan_master()
    rows = load_records()
    as_of = max(r[0] for r in rows)
    print(f"[title] データ最新日={as_of} / 今日(JST)={today} / fan={len(fan)}人")

    cur = titles(rows, as_of, fan)
    pool = master_pool(rows, as_of, fan)
    state = load_json(a.state)

    # --- 前の週の姿を用意する ---
    if state is None:
        # 初回。1週間前を自分で計算して比べる(昇級ウォッチのように空振りしない)。
        base = (datetime.date.fromisoformat(as_of)
                - datetime.timedelta(days=WEEK_DAYS)).isoformat()
        print(f"[title] 状態ファイルがありません。{base} 時点を作って比べます。")
        before = titles(rows, base, fan)
        prev = {t: v["c"] for t, v in before.items()}
        prev_master = {t for t, v in before.items() if v["m"]}
        prev_pool = None    # 予備軍は前回値が無いので、この週は「動いた」と見なさない
        last_posted = None
    else:
        if state.get("as_of") == as_of:
            print(f"[title] as_of が前回と同じ({as_of})ため投稿しません。"
                  "結果データがまだ更新されていません。")
            return
        prev = state.get("t", {})
        prev_master = set(state.get("m", []))
        prev_pool = state.get("master_pool")
        last_posted = state.get("last_posted_date")

    # state は二つ名の文字列しか持たないので、差分を取る形に組み直す。
    prev_full = {t: {"c": c, "m": t in prev_master} for t, c in prev.items()}
    d = diff_titles(prev_full, cur)

    print(f"[title] 変化 {len(d['changed'])}人 / "
          f"主 +{len(d['master_born'])}/-{d['master_lost']} / "
          f"巧者 +{len(d['kosha_born'])}/-{d['kosha_lost']} / 予備軍 {prev_pool}→{pool}")

    # 変遷は投稿の成否と関係なく残す。投稿が失敗した週の変化も、
    # 選手ページには出したいため。
    append_history(d["changed"], cur, as_of, a.history)

    # --- 同じ日に2回投稿しない ---
    if last_posted == today.isoformat():
        print(f"[title] 今日({today})はすでに投稿済みのため投稿しません。状態だけ更新します。")
        save_state(cur, pool, as_of, last_posted, a.state)
        return

    kind, text = decide(d, cur, pool, prev_pool, as_of)
    print(f"[title] 投稿する種別: {kind}")

    # post() の中で長さ・認証を確かめ、失敗すれば非0で落ちる。
    # ここで落ちた場合は状態を更新しない。翌週もう一度同じ変化が拾われる。
    x_post.post(text, dry_run=a.dry_run)

    if not a.dry_run:
        last_posted = today.isoformat()
    save_state(cur, pool, as_of, last_posted, a.state)


if __name__ == "__main__":
    main()
