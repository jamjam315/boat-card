# -*- coding: utf-8 -*-
"""
今日の一問(過去の実レースで読む練習)の出題を、今日から1週間先まで作り置きする(AI-14 v1③)。

  python build_quiz.py            今日(JST)から7日分のうち、まだ無い日だけ作る(毎晩 results.yml)
  python build_quiz.py --dry      選ぶだけで書かない

【出題の決め方】(AI-14 step0 の裁定)
- 池: snapshots/(その日のレースページと同じ番組表の数字。scripts/archive_race_snapshots.py)にある
  2026-07-26 以降のレースのうち、6艇とも完走し(欠場・フライング・失格なし)、払戻があるもの
- 出題日の8日以上前のレースだけ。レースページ(race/)は7日残るので、日付を伏せた問題から
  その日のページ(結果が載る)に辿れないようにする
- 使用済みは出さない。使用済み = quiz/ に既にある出題の answer.key(配った出題ファイルそのものが台帳。
  別に台帳を持つと、片方だけ更新されて食い違うため)
- 同じ会場を7日以内に出さない(前後6日の出題日の会場を外す)
- 残った候補をレースキーの順に並べ、出題日から作った数(sha256)で1つ選ぶ。
  誰がいつ作っても、同じ池なら同じ1問になる。全員が同じ日に同じ問題を解く
- 一度作った日は作り直さない(池が増えても、配った問題は変わらない)

【ファイルの形】quiz/{出題日}.json
  question … 問題。記録する前に見せてよいもの。レースの日付・締切・レースキーは入れない
    venue / no / kind / dist / fixed … 会場・R・種別・距離・進入固定(競走成績から)
    wx    … 天候・風向・風速・波高(競走成績に記録されたレース時点の気象)
    boats … その日のレースページと同じ艇の数字(data.js のレース要素の boats)+ ex(展示タイム・競走成績から)
  answer … 答え。記録を済ませてから使う
    date / key          … どのレースだったか
    order / in / kimarite / pay … 払戻JSON(payouts/)と同じ形。採点は {...answer, wx: question.wx} を
                           yomi.js の scoreOne に、{boats: question.boats} をスナップショットとして buildPaper に渡す
    st / rt             … 艇番順のST・レースタイム(秒)。ドット再生に使う。レースタイムが無い艇は null
"""
import argparse
import datetime
import glob
import hashlib
import io
import json
import os
import zoneinfo

import data_paths
import results_store
from build_payouts import race_doc

POOL_FROM = "2026-07-26"
DAYS_AHEAD = 7          # 今日を含めて何日分を作り置くか
MIN_AGE_DAYS = 8        # 出題日の何日以上前のレースを出すか(race/ は7日残る)
VENUE_GAP_DAYS = 7      # 同じ会場を出さない間隔
OUT_DIR = "quiz"
SNAP_DIR = os.path.join(data_paths.DATA_ROOT, "snapshots")
SEED_SALT = "teiyomi-quiz-v1"


def today_jst():
    return datetime.datetime.now(zoneinfo.ZoneInfo("Asia/Tokyo")).date()


def load_snapshots():
    snaps = {}
    for path in sorted(glob.glob(os.path.join(SNAP_DIR, "*.jsonl"))):
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    x = json.loads(line)
                    if x["key"][:10] >= POOL_FROM:
                        snaps[x["key"]] = x["race"]
    return snaps


def load_results(years):
    out = {}
    for path in results_store.all_year_files():
        if os.path.basename(path)[:4] not in years:
            continue
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                r = json.loads(line)
                if r["date"] >= POOL_FROM:
                    out[f'{r["date"]}:{r["会場"]}:{r["レース番号"]}'] = r
    return out


def race_seconds(rt):
    """レースタイム "1.51.1"(分.秒.1/10秒) を秒にする。無ければ None。"""
    try:
        m, s, t = rt.split(".")
        return round(int(m) * 60 + int(s) + int(t) / 10, 1)
    except (AttributeError, ValueError):
        return None


def eligible(snap, r):
    """出題に使えるレースか。6艇とも完走・払戻あり・スナップショットも6艇。"""
    if not r or r.get("欠場"):
        return False
    boats = r.get("結果") or []
    if len(boats) != 6 or sorted(x.get("艇") for x in boats) != [1, 2, 3, 4, 5, 6]:
        return False
    if any(not isinstance(x.get("着"), int) or x.get("状") for x in boats):
        return False
    if sorted(b.get("n") for b in (snap.get("boats") or [])) != [1, 2, 3, 4, 5, 6]:
        return False
    doc = race_doc(r)
    return not doc.get("status") and bool((doc.get("pay") or {}).get("3連単"))


def make_quiz(date_iso, key, snap, r):
    doc = race_doc(r)
    by_lane = {x["艇"]: x for x in r["結果"]}
    boats = []
    for b in sorted(snap["boats"], key=lambda b: b["n"]):
        b = dict(b)
        b["ex"] = by_lane[b["n"]].get("展")
        boats.append(b)
    _, venue, no = key.split(":")
    return {
        "date": date_iso,
        "question": {
            "venue": venue, "no": int(no),
            "kind": r.get("種別"), "dist": r.get("距離"), "fixed": r.get("進入固定"),
            "wx": doc["wx"],
            "boats": boats,
        },
        "answer": {
            "date": key[:10], "key": key,
            "order": doc["order"], "in": doc["in"], "kimarite": doc["kimarite"], "pay": doc["pay"],
            "st": [by_lane[n].get("ST") for n in range(1, 7)],
            "rt": [race_seconds(by_lane[n].get("RT")) for n in range(1, 7)],
        },
    }


def existing_quizzes():
    """quiz/ にある出題。{出題日: (answer.key, 会場)}"""
    out = {}
    for path in glob.glob(os.path.join(OUT_DIR, "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].json")):
        with open(path, encoding="utf-8") as f:
            q = json.load(f)
        out[q["date"]] = (q["answer"]["key"], q["question"]["venue"])
    return out


def pick(date_iso, pool, quizzes):
    d = datetime.date.fromisoformat(date_iso)
    newest = (d - datetime.timedelta(days=MIN_AGE_DAYS)).isoformat()
    used = {k for k, _ in quizzes.values()}
    near = set()
    for i in range(1, VENUE_GAP_DAYS):
        for other in (d - datetime.timedelta(days=i), d + datetime.timedelta(days=i)):
            if other.isoformat() in quizzes:
                near.add(quizzes[other.isoformat()][1])
    cands = sorted(k for k in pool if k[:10] <= newest and k not in used and k.split(":")[1] not in near)
    if not cands:
        return None, 0
    h = int(hashlib.sha256(f"{SEED_SALT}:{date_iso}".encode("utf-8")).hexdigest(), 16)
    return cands[h % len(cands)], len(cands)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true")
    a = ap.parse_args()

    snaps = load_snapshots()
    if not snaps:
        raise SystemExit(f"[error] 出題の池(snapshots/)が空です: {SNAP_DIR}")
    results = load_results({k[:4] for k in snaps})
    pool = {k for k, s in snaps.items() if eligible(s, results.get(k))}
    quizzes = existing_quizzes()
    print(f"[info] 池 {len(pool)}レース(スナップショット {len(snaps)}・{min(snaps)[:10]}〜{max(snaps)[:10]}) / 既存の出題 {len(quizzes)}日")

    today = today_jst()
    made = 0
    for i in range(DAYS_AHEAD):
        date_iso = (today + datetime.timedelta(days=i)).isoformat()
        if date_iso in quizzes:
            continue
        key, n = pick(date_iso, pool, quizzes)
        if not key:
            print(f"[warn] {date_iso}: 出せる候補がありません")
            continue
        quiz = make_quiz(date_iso, key, snaps[key], results[key])
        quizzes[date_iso] = (key, quiz["question"]["venue"])
        made += 1
        print(f"[quiz] {date_iso} ← {key}(候補 {n})")
        if a.dry:
            continue
        os.makedirs(OUT_DIR, exist_ok=True)
        with io.open(os.path.join(OUT_DIR, f"{date_iso}.json"), "w", encoding="utf-8", newline="\n") as f:
            json.dump(quiz, f, ensure_ascii=False, separators=(",", ":"))
    print(f"[done] {'(書かない) ' if a.dry else ''}作った出題 {made}日 → {OUT_DIR}/")


if __name__ == "__main__":
    main()
