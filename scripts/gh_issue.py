"""GitHub Issue で運営に知らせる共通の部品(2026-09-18)。

AI講評の監視(check_ai_health.py)と、毎晩・毎朝のジョブの失敗通知(notify_run_failure.py)が使う。
x-bot の notify_once / budget_stop と同じく gh で立てる。X には投げない。

【同じ用件で何枚も立てない】
同じ題の Issue が開いていれば、そこへコメントで足す。本文とコメントに印(marker、HTMLコメント)を入れ、
同じ印がすでにあれば何もしない(同じ用件で二度走っても1回だけ)。閉じれば、次は新しく立つ。
"""
import json
import subprocess


def gh(args):
    # encoding を決めておく。決めないと Windows では cp932 で読もうとして落ち、
    # 一覧が空に見えて同じ Issue を何枚も立てた(2026-09-18 手元の確認で起きた)。
    return subprocess.run(["gh"] + args, capture_output=True, text=True,
                          encoding="utf-8", errors="replace", timeout=60)


def notify(title, body, marker, dry=False, tag="[gh-issue]"):
    """題 title の Issue で知らせる。知らせた(または知らせ済み)なら True。"""
    if dry:
        print("%s (dry) 題: %s\n%s" % (tag, title, body))
        return True
    # --search は使わない(検索の索引は数分遅れるので、立てた直後の二度目の実行で見つからない)。
    # 開いている Issue を並べて題で照らす。読めなければ立てない(重複より、赤くして気づかせる)。
    r = gh(["issue", "list", "--state", "open", "--json", "number,title", "--limit", "200"])
    try:
        if r.returncode != 0:
            raise ValueError(r.stderr[:200])
        listed = json.loads(r.stdout)
    except ValueError as e:
        print("%s Issue の一覧を読めませんでした: %s" % (tag, e))
        return False
    same = [i for i in listed if i.get("title") == title]
    if same:
        n = str(same[0]["number"])
        v = gh(["issue", "view", n, "--json", "body,comments"])
        if v.returncode != 0:
            print("%s Issue #%s を読めませんでした: %s" % (tag, n, v.stderr[:200]))
            return False
        data = json.loads(v.stdout)
        texts = [data.get("body") or ""] + [c.get("body") or "" for c in data.get("comments") or []]
        if any(marker in t for t in texts):
            print("%s #%s で知らせ済みです" % (tag, n))
            return True
        c = gh(["issue", "comment", n, "--body", body])
        if c.returncode == 0:
            print("%s #%s にコメントしました" % (tag, n))
            return True
        print("%s コメントできませんでした: %s" % (tag, c.stderr[:200]))
        return False
    c = gh(["issue", "create", "--title", title, "--body", body])
    if c.returncode == 0:
        print("%s 知らせました: %s" % (tag, c.stdout.strip()))
        return True
    print("%s Issue を立てられませんでした: %s" % (tag, c.stderr[:200]))
    return False
