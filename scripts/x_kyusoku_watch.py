# -*- coding: utf-8 -*-
"""
昇級ボーダーウォッチの変化を見つけて、1日に最大1件だけXへ投稿する。

  python scripts/x_kyusoku_watch.py [--dry-run]

【全体の流れ】
  kyusoku.json（results.yml が毎晩01:00に作る）と、前回の状態を突き合わせて
  「今日いちばん伝える価値のある変化」を1つだけ選び、文面にして投稿する。

【比較の基準は data_to（generated_at は使わない）】
generated_at は再生成のたびに動くので、中身が同じでも「変化した」ことになる。
実際このリポジトリで、中身が完全に同じ2,116ファイルがタイムスタンプだけで
差分に出た事故がある。data_to は「どの日までの成績か」を表すので、
同じ data_to なら b1/b2 の中身も順序も完全に一致する（CI(Ubuntu)生成ぶんと
ローカル(Windows)再生成ぶんがバイト単位で一致することを実測で確認済み）。

【応援アカウントとしての掟】
圏外に落ちた選手の名前は、絶対に出さない。人の成績が下がったことを名指しで
広める道具にはしない。圏内の人数が減ったという数字にだけ反映する。
また、リストから消えた選手を「圏外落ち」とは扱わない。kyusoku.json は
上位200人で打ち切られているので、消えたのは他の選手に押し出されただけかもしれない。

【事故を構造で防ぐ】
  - 初回（状態ファイルが無い）はイベント判定をしない。いきなり102人ぶんの
    「圏内入り」を投げないため
  - data_to が前回と同じ日は投稿しない（データがまだ更新されていない）
  - 同じ日に2回は投稿しない（last_posted_date で見張る）
  - 投稿は x_post.post() 経由。1実行1投稿・リトライ無し・失敗は非0終了
  - 投稿に失敗したら状態を更新しない。翌日、同じ変化がもう一度拾われて投稿される
"""
import argparse
import datetime
import json
import os
import sys
import zoneinfo

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import x_post

JST = zoneinfo.ZoneInfo("Asia/Tokyo")
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KYUSOKU_PATH = os.path.join(REPO, "kyusoku.json")
STATE_PATH = os.path.join(REPO, "x_state", "kyusoku_state.json")

# 表示上のラベル。b1 は B1→A2 圏、b2 は B2→B1 圏。
LABEL = {"b1": "B1→A2", "b2": "B2→B1"}
# 「出走70回以上」の70は build_player_career.py の KYU_REQ["B1"]["starts"]。
# kyusoku.json には入っていないのでここに書くしかない。あちらを変えたらここも直すこと。
MIN_STARTS_TEXT = 70
TAGS = "#ボートレース #競艇"


def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def md(date_iso):
    """"2026-08-26" -> "8/26"。ゼロ埋めしない。"""
    d = datetime.date.fromisoformat(date_iso)
    return f"{d.month}/{d.day}"


def snapshot(doc):
    """状態ファイルに残す最小の形。{toban: {ok, rank}} だけ持つ。

    名前・勝率まで持たせない。次回の kyusoku.json から引けるものを二重に
    持つと、片方だけ古くなったときに食い違うため。"""
    out = {}
    for key in ("b1", "b2"):
        out[key] = {r["toban"]: {"ok": bool(r["ok"]), "rank": r["rank"]}
                    for r in doc.get(key, [])}
    return out


def rank1_toban(m):
    """マップから rank=1 の登番を取り出す。無ければ None。"""
    for toban, v in m.items():
        if v.get("rank") == 1:
            return toban
    return None


def find_entrants(doc, prev_map, key):
    """圏内入りした選手を、kyusoku.json の行そのままで返す（rank順）。

    拾うのは2通り:
      - 前回 ok=False → 今回 ok=True
      - 前回のリストに居なかった登番が、今回 ok=True で現れた（急浮上）
    圏外落ち（True→False）は拾わない。名前を出さないと決めている。"""
    prev = prev_map.get(key, {})
    out = []
    for r in doc.get(key, []):
        if not r["ok"]:
            continue
        before = prev.get(r["toban"])
        if before is None or not before.get("ok"):
            out.append(r)
    out.sort(key=lambda r: r["rank"])
    return out


def counts(doc):
    return (sum(1 for r in doc.get("b1", []) if r["ok"]),
            sum(1 for r in doc.get("b2", []) if r["ok"]))


def footer(doc):
    b = doc["border"]
    n1, n2 = counts(doc)
    # 定員(658)は登録選手数から毎回計算される値。固定で書くと期替わりで黙って壊れる。
    return (f"圏内: B1 {n1}人／B2 {n2}人\n"
            f"※出走{MIN_STARTS_TEXT}回以上 {b['qualified_count']}/{b['a_seats_total']}人\n"
            f"{TAGS}")


def names_phrase(rows, limit=3):
    """「A選手・B選手・C選手ほか2名」。limit名まで挙げて、残りは人数にまとめる。"""
    shown = "・".join(f"{r['name']}選手" for r in rows[:limit])
    rest = len(rows) - limit
    return shown + (f"ほか{rest}名" if rest > 0 else "")


# ---------------------------------------------------------------- 文面

def text_border(doc):
    b = doc["border"]
    return (f"昇級ボーダーウォッチ {md(doc['data_to'])}🚤\n"
            f"推定ボーダーの表示が始まりました。\n"
            f"A級圏のボーダーは勝率{b['border_rate_estimate']}あたりと推定されます。\n"
            f"（出走{MIN_STARTS_TEXT}回以上が{b['a_seats_total']}人に到達）\n"
            f"{TAGS}")


def text_entry(doc, key, rows, name_limit=3):
    head = f"{names_phrase(rows, name_limit)}、{LABEL[key]}の昇級圏内に浮上。"
    if len(rows) == 1:
        detail = f"勝率{rows[0]['rate']}・{rows[0]['starts']}走で3要件クリア✅"
    else:
        # 複数人のときに1人ぶんの勝率だけ書くと、誰の数字か分からなくなる。
        detail = "いずれも3要件クリア✅"
    return (f"昇級ボーダーウォッチ {md(doc['data_to'])}🚤\n"
            f"{head}\n{detail}\n{footer(doc)}")


def text_lead_change(doc, key, row):
    return (f"昇級ボーダーウォッチ {md(doc['data_to'])}🚤\n"
            f"{LABEL[key]}圏で首位交代。\n"
            f"新首位は{row['name']}選手（勝率{row['rate']}・{row['starts']}走）。\n"
            f"{footer(doc)}")


def text_weekly(doc):
    top = doc.get("b1", [])[:3]
    line = "／".join(f"{i + 1}位 {r['name']} {r['rate']}" for i, r in enumerate(top))
    return (f"今週の昇級ボーダーウォッチ🚤\n"
            f"B1→A2圏 上位{len(top)}名\n"
            f"{line}\n{footer(doc)}")


def fit(build):
    """全角140字（重み280）に収める。名前の数を減らしながら作り直す。

    収まらなければ諦めて None を返す。切り詰めて意味の変わった文を
    黙って投げるより、投稿しないほうがよい。"""
    for limit in (3, 2, 1):
        t = build(limit)
        if x_post.weighted_len(t) <= x_post.MAX_WEIGHTED:
            return t
    return None


# ---------------------------------------------------------------- 判定

def decide(doc, state, today):
    """投稿する1件を決める。(種別, 本文) か (None, 理由) を返す。

    優先順位: ボーダー確定 > 圏内入り > 首位交代 > 日曜まとめ。
    上位が1つでも成立したら、そこで打ち切る（1日1投稿）。"""
    prev_map = {"b1": state.get("b1", {}), "b2": state.get("b2", {})}

    # 1. ボーダー確定（null → 数値）
    now_border = doc["border"].get("border_rate_estimate")
    was_border = state.get("border_rate_estimate")
    if was_border is None and now_border is not None:
        return "border", text_border(doc)

    # 2. 圏内入り。B1→A2 のほうがニュース性が高いので先に見る。
    for key in ("b1", "b2"):
        rows = find_entrants(doc, prev_map, key)
        if rows:
            t = fit(lambda limit, k=key, r=rows: text_entry(doc, k, r, limit))
            if t:
                return "entry", t
            print(f"[watch] {key} の圏内入りが長すぎて収まりませんでした（{len(rows)}名）")

    # 3. 首位交代
    for key in ("b1", "b2"):
        before = rank1_toban(prev_map.get(key, {}))
        rows = doc.get(key, [])
        if not rows or before is None:
            continue
        now = rows[0]
        if now["toban"] != before:
            return "lead", text_lead_change(doc, key, now)

    # 4. 日曜だけ、変化が無くてもまとめを出す
    if today.weekday() == 6:
        return "weekly", text_weekly(doc)

    return None, "伝えるほどの変化がありませんでした（日曜でもないため投稿しません）"


# ---------------------------------------------------------------- 本体

def save_state(doc, state, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    snap = snapshot(doc)
    out = {
        "data_to": doc["data_to"],
        "last_posted_date": state.get("last_posted_date"),
        "border_rate_estimate": doc["border"].get("border_rate_estimate"),
        "b1": snap["b1"],
        "b2": snap["b2"],
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"[watch] 状態を保存しました data_to={out['data_to']} "
          f"last_posted_date={out['last_posted_date']} "
          f"b1={len(out['b1'])}件 b2={len(out['b2'])}件")


def main():
    p = argparse.ArgumentParser(description="昇級ボーダーウォッチの変化をXへ投稿する")
    p.add_argument("--dry-run", action="store_true", help="投稿せず、本文だけ出す")
    p.add_argument("--kyusoku", default=KYUSOKU_PATH)
    p.add_argument("--state", default=STATE_PATH)
    p.add_argument("--today", help="テスト用。今日(JST)を YYYY-MM-DD で上書きする")
    a = p.parse_args()

    today = (datetime.date.fromisoformat(a.today) if a.today
             else datetime.datetime.now(JST).date())
    doc = load_json(a.kyusoku)
    print(f"[watch] kyusoku.json data_to={doc['data_to']} / 今日(JST)={today}")

    # --- 初回は判定しない ---
    if not os.path.exists(a.state):
        # ここは --dry-run でも保存する。保存しないと初期化が済まず、
        # 次の実行もまた初回になってしまうため。投稿はしないので害はない。
        print("[watch] 状態ファイルがありません。初回として、判定せずに保存だけします"
              "（--dry-run でも保存します。投稿はしません）。")
        save_state(doc, {}, a.state)
        return

    state = load_json(a.state)

    # --- データがまだ更新されていない日 ---
    if state.get("data_to") == doc["data_to"]:
        print(f"[watch] data_to が前回と同じ（{doc['data_to']}）ため投稿しません。"
              "結果データがまだ更新されていない日です。")
        return

    # --- 同じ日に2回投稿しない ---
    if state.get("last_posted_date") == today.isoformat():
        print(f"[watch] 今日（{today}）はすでに投稿済みのため投稿しません。状態だけ更新します。")
        save_state(doc, state, a.state)
        return

    kind, text = decide(doc, state, today)
    if kind is None:
        print(f"[watch] {text}")
        save_state(doc, state, a.state)
        return

    print(f"[watch] 投稿する種別: {kind}")
    # post() の中で長さ・認証を確かめ、失敗すれば非0で落ちる。
    # ここで落ちた場合は状態を更新しない。翌日もう一度同じ変化が拾われる。
    x_post.post(text, dry_run=a.dry_run)

    if not a.dry_run:
        state["last_posted_date"] = today.isoformat()
    save_state(doc, state, a.state)


if __name__ == "__main__":
    main()
