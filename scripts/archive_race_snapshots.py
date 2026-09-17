# -*- coding: utf-8 -*-
"""
レースページで見せていた番組表の数字(data.js のレース要素)を、レースごとに貯める(AI-14 v1③)。
今日の一問(過去の実レースで読む練習)の出題の池になる。

  python scripts/archive_race_snapshots.py                       いまの data.js を貯める(毎晩 results.yml)
  python scripts/archive_race_snapshots.py --from-git 2026-07-26  main の git 履歴から貯める(初回だけ)

【なぜ data.js をそのまま貯めるのか】
読み採点は「記録した時点で本人が見ていた数字」で採点する(yomi.js のスナップショット)。
今日の一問も、その日のレースページと同じ数字で出題する。番組表(program/)と結果から作り直すと、
今節の流れ・当地の出走数・体重・F持ちなどが、その日に表示していたものと食い違う
(fan は期ごとに入れ替わり、今節の流れは日が進むと伸びる)。

【置き場所】data ブランチの snapshots/{YYYY-MM}.jsonl(レースの日付の月)。
1行1レース: {"key": "日付:会場:R", "race": data.js のレース要素}
同じ key が既にあれば書かない。貯めるのは日付が変わった(JSTで今日より前の)日だけ。
その日のうちは data.js が更新されうるので、最後の版になってから貯める。毎晩1時(results.yml)の
時点の data.js は前日の最後の版。git 履歴から貯めるときも、日付ごとに最後のコミットの版を使う。
"""
import datetime
import glob
import json
import os
import subprocess
import sys
import zoneinfo

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import data_paths  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SNAP_DIR = os.path.join(data_paths.DATA_ROOT, "snapshots")


def today_jst():
    return datetime.datetime.now(zoneinfo.ZoneInfo("Asia/Tokyo")).date().isoformat()


def parse_data_js(text):
    """data.js の中身を読み、(日付ISO, [(key, レース要素), ...]) を返す。"""
    prefix = "window.DATA = "
    body = text[text.index(prefix) + len(prefix):].strip()
    if body.endswith(";"):
        body = body[:-1]
    doc = json.loads(body)
    y, m, d = (int(x) for x in doc["date"].replace("年", "-").replace("月", "-").replace("日", "").split("-"))
    date_iso = datetime.date(y, m, d).isoformat()
    out = []
    for v in doc.get("venues", []):
        for race in v.get("races", []):
            out.append((f'{date_iso}:{v["name"]}:{race["no"]}', race))
    return date_iso, out


def existing_keys():
    keys = set()
    for path in glob.glob(os.path.join(SNAP_DIR, "*.jsonl")):
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    keys.add(json.loads(line)["key"])
    return keys


def append(entries, keys):
    """[(key, race)] のうち、まだ無いものを月ごとのファイルに足す。足した件数を返す。"""
    os.makedirs(SNAP_DIR, exist_ok=True)
    by_month = {}
    for key, race in entries:
        if key in keys:
            continue
        by_month.setdefault(key[:7], []).append((key, race))
        keys.add(key)
    n = 0
    for month, rows in sorted(by_month.items()):
        with open(os.path.join(SNAP_DIR, f"{month}.jsonl"), "a", encoding="utf-8", newline="\n") as f:
            for key, race in rows:
                f.write(json.dumps({"key": key, "race": race}, ensure_ascii=False, separators=(",", ":")) + "\n")
                n += 1
    return n


def from_git(since):
    """main の git 履歴から、日付ごとに最後のコミットの data.js を集める。"""
    # --since はコミット時刻で絞る。朝の data.js は前日の UTC 時刻でコミットされることがあるので、
    # 2日前から読み、日付は data.js の中身で絞る
    git_since = (datetime.date.fromisoformat(since) - datetime.timedelta(days=2)).isoformat()
    hashes = subprocess.run(
        ["git", "log", "--reverse", "--format=%H", f"--since={git_since}", "--", "data.js"],
        cwd=REPO, capture_output=True, text=True, check=True).stdout.split()
    by_date = {}
    for h in hashes:
        text = subprocess.run(["git", "show", f"{h}:data.js"], cwd=REPO, capture_output=True, check=True).stdout.decode("utf-8")
        try:
            date_iso, races = parse_data_js(text)
        except (ValueError, KeyError) as e:
            print(f"[warn] {h[:10]} の data.js を読めない: {e}")
            continue
        if since <= date_iso < today_jst():
            by_date[date_iso] = races       # 後のコミットで上書き = その日の最後の版
    return by_date


def main():
    keys = existing_keys()
    if "--from-git" in sys.argv:
        since = sys.argv[sys.argv.index("--from-git") + 1]
        by_date = from_git(since)
        total = 0
        for date_iso in sorted(by_date):
            total += append(by_date[date_iso], keys)
        print(f"[done] git 履歴から {len(by_date)}日ぶん({min(by_date)}〜{max(by_date)}) / 追加 {total}レース → {SNAP_DIR}")
        return
    with open(os.path.join(REPO, "data.js"), encoding="utf-8") as f:
        date_iso, races = parse_data_js(f.read())
    if date_iso >= today_jst():
        print(f"[skip] data.js は今日({date_iso})の版。日付が変わってから貯める")
        return
    n = append(races, keys)
    print(f"[done] data.js({date_iso}) {len(races)}レース中 {n}レースを追加 → {SNAP_DIR}")


if __name__ == "__main__":
    main()
