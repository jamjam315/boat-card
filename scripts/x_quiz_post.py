# -*- coding: utf-8 -*-
"""
今日の一問(quiz/{今日}.json)を、朝08:05 JSTにXへ1件だけ投稿する(AI-14 v1⑥)。

  python scripts/x_quiz_post.py [--dry-run] [--preview] [--today YYYY-MM-DD]

【本文に入れるもの・入れないもの】(2026-09-16 JAM)
  入れる … 会場・レース番号・種別と距離・気象(レース時点の値)・6艇の艇番と選手名と級別・ページへのリンク
  入れない … レースの日付(ページでも結果のところまで伏せている)・着順・払戻・決まり手など答えの側のもの
  予想印も入れない(サイトと同じ)。購入を促す言い方もしない。
出題ファイルの question だけを読み、answer には触れない(答えを本文に混ぜる経路を作らない)。

【事故を構造で防ぐ】(x_kyusoku_watch.py と同じ作法)
  - 投稿は x_post.post() 経由。1実行1投稿・リトライ無し・失敗は非0終了
  - 同じ日に2回は投稿しない(x_state/quiz_state.json の last_posted_date)
  - 今日の出題ファイルが無い・崩れている日は投稿しない(非0で終わって気づけるようにする。
    リンク先が「準備しています」のまま投稿すると、押した人が何も遊べない)
  - 本文が長すぎたら、気象の行 → 級別の順に削って作り直す。それでも入らなければ投稿しない
  - 投稿に失敗したら状態を更新しない
  - 本番に出すかどうかは、ワークフロー(x-post-quiz.yml)の POST_LIVE が決める(元栓)

--preview は認証情報を使わず、本文と文字数を出すだけ(手元で文面を確かめる用)。
--dry-run は x_post の dry-run(認証情報の配線まで確かめる。CI 用)。
"""
import argparse
import datetime
import json
import os
import re
import sys
import zoneinfo

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import x_post

JST = zoneinfo.ZoneInfo("Asia/Tokyo")
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
QUIZ_DIR = os.path.join(REPO, "quiz")
STATE_PATH = os.path.join(REPO, "x_state", "quiz_state.json")
URL = "https://teiyomi.com/quiz.html"
TAGS = "#ボートレース #競艇"


def load_question(path):
    """出題ファイルの question だけを返す。形が崩れていれば None。"""
    try:
        with open(path, encoding="utf-8") as f:
            q = json.load(f)
    except (OSError, ValueError):
        return None
    Q = q.get("question") if isinstance(q, dict) else None
    if not isinstance(Q, dict) or not isinstance(Q.get("venue"), str) or not isinstance(Q.get("no"), int):
        return None
    boats = Q.get("boats")
    if not isinstance(boats, list) or [b.get("n") for b in boats] != [1, 2, 3, 4, 5, 6]:
        return None
    if not all(isinstance(b.get("name"), str) and b["name"].strip() for b in boats):
        return None
    return Q


def clean(s):
    """データの文字を1行の文字にする(改行・連続空白をつぶす)。"""
    return re.sub(r"\s+", " ", str(s or "")).strip()


def race_line(Q):
    parts = []
    if Q.get("kind"):
        parts.append(clean(Q["kind"]))
    if isinstance(Q.get("dist"), int):
        parts.append(f"{Q['dist']}m")
    return f"{clean(Q['venue'])} {Q['no']}R" + (f"（{'・'.join(parts)}）" if parts else "")


def wx_line(Q):
    """気象(レース時点の値)。数でない値は出さない。"""
    wx = Q.get("wx") or {}
    parts = []
    if isinstance(wx.get("天候"), str) and wx["天候"].strip():
        parts.append(clean(wx["天候"]))
    wind = wx.get("風速")
    if isinstance(wind, (int, float)) and not isinstance(wind, bool):
        d = clean(wx.get("風向")) if isinstance(wx.get("風向"), str) else ""
        parts.append(f"{d}の風{wind:g}m" if d else f"風{wind:g}m")
    wave = wx.get("波高")
    if isinstance(wave, (int, float)) and not isinstance(wave, bool):
        parts.append(f"波高{wave:g}cm")
    return "・".join(parts)


def boat_lines(Q, with_class=True):
    out = []
    for b in Q["boats"]:
        k = clean(b.get("k")) if with_class and isinstance(b.get("k"), str) else ""
        out.append(f"{b['n']} {clean(b['name'])}" + (f" {k}" if k else ""))
    return out


def build(Q, with_wx=True, with_class=True):
    lines = [f"今日の一問🚤 {race_line(Q)}"]
    w = wx_line(Q) if with_wx else ""
    if w:
        lines.append(w)
    lines += boat_lines(Q, with_class)
    lines.append("過去に実際にあったレースです。番組表を読んで買い目を記録→スタートで結果と答案。")
    lines.append(URL)
    lines.append(TAGS)
    return "\n".join(lines)


def fit(Q):
    """重み280に収める。気象 → 級別の順に削る。入らなければ None(切り詰めた文は投げない)。"""
    for with_wx, with_class in ((True, True), (False, True), (False, False)):
        t = build(Q, with_wx, with_class)
        if x_post.weighted_len(t) <= x_post.MAX_WEIGHTED:
            return t
    return None


def load_state(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_state(state, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, separators=(",", ":"))
    print(f"[quiz-x] 状態を保存しました last_posted_date={state.get('last_posted_date')}")


def main():
    p = argparse.ArgumentParser(description="今日の一問をXへ投稿する")
    p.add_argument("--dry-run", action="store_true", help="投稿せず、x_post の dry-run で本文を出す(認証情報の配線も確かめる)")
    p.add_argument("--preview", action="store_true", help="認証情報を使わず、本文と文字数だけを出す")
    p.add_argument("--today", help="今日(JST)を YYYY-MM-DD で上書きする(文面の確認用)")
    p.add_argument("--state", default=STATE_PATH)
    a = p.parse_args()

    today = (datetime.date.fromisoformat(a.today) if a.today else datetime.datetime.now(JST).date()).isoformat()
    path = os.path.join(QUIZ_DIR, today + ".json")
    Q = load_question(path)
    if Q is None:
        sys.exit(f"[quiz-x] 今日({today})の出題ファイルが無いか崩れています: {path}\n"
                 "  リンク先で遊べないので投稿しません。results.yml の「今日の一問を1週間先まで作り置く」を確認してください。")

    text = fit(Q)
    if text is None:
        sys.exit("[quiz-x] 本文が長すぎて、削っても入りませんでした。投稿しません。")

    if a.preview:
        print(f"[quiz-x] {today} の本文(文字数 {x_post.weighted_len(text)}/{x_post.MAX_WEIGHTED}・全角=2)")
        print(text)
        return

    state = load_state(a.state)
    if state.get("last_posted_date") == today:
        print(f"[quiz-x] 今日({today})はすでに投稿済みのため投稿しません。")
        return

    x_post.post(text, dry_run=a.dry_run)
    if not a.dry_run:
        state["last_posted_date"] = today
        save_state(state, a.state)


if __name__ == "__main__":
    main()
