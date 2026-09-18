"""毎晩・毎朝のジョブが失敗したことを GitHub Issue で知らせる(2026-09-18)。

【なぜ要るのか】
2026-09-18 01:05 JST の結果収集(Supabase のキッカーから起動)が、main への push の rebase で
衝突して失敗していたのに、誰も見ていなかった(ジョブが赤くなるだけで、どこにも届かない)。
results.yml / daily.yml の本体ジョブが失敗したら、そのワークフローの最後のジョブからこれを呼ぶ。

【知らせ方】gh_issue.py(AI講評の監視と同じ作法)
  題はワークフローごとに1つ(--title)。開いている Issue があればコメントで足す。
  印は run の番号と試行回数(<!-- run-failure:<run_id>-<attempt> -->)。同じ run では1回だけ。
  本文: 何日の何の起動か・失敗したジョブと手順の名前・run の URL。ログの中身は載せない(公開リポジトリ)。

【手元での確かめ方】
  python scripts/notify_run_failure.py --title "テスト" --dry \
    --fake-jobs '[{"name":"collect","conclusion":"failure","steps":[{"name":"x","conclusion":"failure"}]}]'

使う環境変数(GitHub Actions が入れる): GITHUB_RUN_ID / GITHUB_RUN_ATTEMPT / GITHUB_REPOSITORY /
GITHUB_SERVER_URL / GITHUB_WORKFLOW / GITHUB_EVENT_NAME。gh には GH_TOKEN と GH_REPO。
"""
import argparse
import datetime
import json
import os
import sys

import gh_issue   # 同じ scripts/ にある


def failed_parts(jobs):
    """失敗したジョブと、その中で失敗した手順の名前を並べる。"""
    out = []
    for j in jobs or []:
        if j.get("conclusion") != "failure":
            continue
        steps = [s.get("name", "?") for s in j.get("steps") or [] if s.get("conclusion") == "failure"]
        out.append("%s(%s)" % (j.get("name", "?"), "・".join(steps) or "手順の名前は取れず"))
    return out


def body_of(env, parts, hint):
    now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=9)))
    run_id = env.get("GITHUB_RUN_ID", "?")
    url = "%s/%s/actions/runs/%s" % (env.get("GITHUB_SERVER_URL", "https://github.com"),
                                      env.get("GITHUB_REPOSITORY", "?"), run_id)
    lines = [
        "<!-- run-failure:%s-%s -->" % (run_id, env.get("GITHUB_RUN_ATTEMPT", "1")),
        "**%s JST** の「%s」(起動: %s)が失敗しました。"
        % (now.strftime("%Y-%m-%d %H:%M"), env.get("GITHUB_WORKFLOW", "?"), env.get("GITHUB_EVENT_NAME", "?")),
        "",
        "失敗したところ: " + (", ".join(parts) or "(ジョブの一覧を読めませんでした)"),
        "run: " + url,
    ]
    if hint:
        lines += ["", hint]
    lines += ["", "scripts/notify_run_failure.py が立てました。直したら閉じてください(次の失敗は新しく立ちます)。"]
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--title", required=True)
    ap.add_argument("--hint", default="", help="本文に添える一言(そのワークフローで最初に見る場所など)")
    ap.add_argument("--dry", action="store_true", help="gh を呼ばず、立てる内容を出すだけ")
    ap.add_argument("--fake-jobs", help="gh run view の jobs の代わりに使う JSON(手元での確認用)")
    a = ap.parse_args()
    env = os.environ

    if a.fake_jobs:
        jobs = json.loads(a.fake_jobs)
    else:
        r = gh_issue.gh(["run", "view", env.get("GITHUB_RUN_ID", ""), "--json", "jobs"])
        try:
            jobs = json.loads(r.stdout).get("jobs") if r.returncode == 0 else None
        except ValueError:
            jobs = None
        if jobs is None:
            print("[run-failure] ジョブの一覧を読めませんでした: %s" % (r.stderr or "")[:200])

    parts = failed_parts(jobs)
    print("[run-failure] 失敗: %s" % (", ".join(parts) or "不明"))
    marker = "<!-- run-failure:%s-%s -->" % (env.get("GITHUB_RUN_ID", "?"), env.get("GITHUB_RUN_ATTEMPT", "1"))
    ok = gh_issue.notify(a.title, body_of(env, parts, a.hint), marker, dry=a.dry, tag="[run-failure]")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
