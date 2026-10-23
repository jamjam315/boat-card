"""朝の通知(send-morning-push)で飛ばした利用者を、GitHub Issue で知らせる(2026-10-23)。

【なぜ要るのか】
朝の便は、1人の失敗で全員が止まらないよう、壊れた条件・時間切れの宛先などをその人(その件)だけ
飛ばして先へ進む(2026-10-23 点検の中-1・中-2)。そのままでは失敗が黙って消えるので、便の最後に
関数が push-failures.yml を起動し、ここで Issue を立てる(supabase/functions/_shared/failure-report.ts)。

【書くもの・書かないもの】
boat-card は公開リポジトリなので、Issue は誰でも読める。書くのは利用者IDの先頭8文字と、何が起きたか
の種類と件数だけ。通知の文面・宛先URL・条件の中身は関数の側でも送ってこない。ここでも形を確かめ、
形の違うもの(ID が先頭8文字の16進でない・種類の名前が想定と違う)は本文に出さず、件数だけ数える。

【同じ朝に何度も知らせない】(gh_issue.py)
印は「日付+失敗の中身」。保険の cron 便が同じ人で同じ失敗を繰り返しても、印が同じなので二度は書かない。
中身が変われば(新しい人・新しい種類)同じ Issue にコメントで足す。

入力(環境変数・push-failures.yml が workflow_dispatch の入力から入れる):
  DATE      便の日付(YYYY-MM-DD)
  TRIGGER   どの便か(ci / cron / drill など)
  FAILURES  {"items":[{"user":"1a2b3c4d","kind":"web_timeout","n":1}, ...], "more": 0}

【手元での確かめ方】
  DATE=2026-10-24 TRIGGER=ci FAILURES='{"items":[{"user":"1a2b3c4d","kind":"web_error:403","n":2}],"more":0}' \
    python scripts/notify_push_failures.py --dry
"""
import argparse
import hashlib
import json
import os
import re
import sys

import gh_issue   # 同じ scripts/ にある

TITLE = "朝の通知で、飛ばした利用者がいました(send-morning-push)"

# 種類 → 説明。関数の側(failure-report.ts の FailureKind)と同じ名前。
KINDS = {
    "cond_shape": "保存した条件の形が壊れていて照合できない(その条件だけ飛ばした。その人のほかの条件・お気に入りの通知は送っている)",
    "cond_error": "条件の照合で例外(その条件だけ飛ばした)",
    "user_error": "その人の処理で想定外の例外(その人だけ飛ばした。この朝は届いていない)",
    "web_blocked": "通知の宛先が、通知サービス(Chrome・Firefox・Safari・Edge)のURLではない(送らなかった)",
    "web_timeout": "通知の宛先が10秒以内に応答しなかった(この宛先には届いていない)",
    "web_error": "通知の宛先が失敗を返した(この宛先には届いていない)",
    "ios_error": "iOSアプリへの送信が失敗した(届かない端末の片付けとは別)",
    "log_error": "送信記録を書けなかった(次の便で同じ人に重複して届きうる)",
    "run_error": "便そのものが想定外の例外で止まった(まだ送っていなかった人には届いていない)",
    "drill": "稽古(通知の配線を確かめるための、わざとの1件。直すものはない)",
}
USER_RE = re.compile(r"^([0-9a-f]{8}|-)$")
KIND_RE = re.compile(r"^([a-z_]+)(?::([A-Za-z0-9_]{1,20}))?$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TRIGGER_RE = re.compile(r"^[a-z0-9_-]{1,20}$", re.I)


def clean(raw):
    """入力の失敗一覧から、本文に出してよい行だけを取り出す。戻り値: (行の一覧, 出さなかった行の数, 省いた行の数)"""
    try:
        doc = json.loads(raw or "")
    except ValueError:
        return [], 1, 0
    items = doc.get("items") if isinstance(doc, dict) else None
    more = doc.get("more") if isinstance(doc, dict) else 0
    rows, bad = [], 0
    for it in items if isinstance(items, list) else []:
        if not isinstance(it, dict):
            bad += 1
            continue
        user, kind, n = it.get("user"), it.get("kind"), it.get("n")
        m = KIND_RE.match(kind) if isinstance(kind, str) else None
        if not (isinstance(user, str) and USER_RE.match(user) and m and m.group(1) in KINDS
                and isinstance(n, int) and 0 < n < 10 ** 6):
            bad += 1
            continue
        rows.append((user, kind, n))
    return sorted(rows), bad, more if isinstance(more, int) and more > 0 else 0


def describe(kind):
    base, detail = KIND_RE.match(kind).groups()
    text = KINDS[base]
    if base == "web_error" and detail:
        text += "。状態コード " + ("なし" if detail == "none" else detail)
    return text


def body_of(date, trigger, rows, bad, more):
    drill = any(k == "drill" for _, k, _ in rows)
    users = sorted({u for u, _, _ in rows if u != "-"})
    lines = []
    if drill:
        lines += ["**これは稽古です。** push-failures.yml を drill で手動実行し、朝の便を「1通も送らない稽古モード」で"
                  "通しました。下に drill 以外の行があれば、それは本物です(稽古でも、全員ぶんの条件の照合と宛先の確かめは"
                  "本番と同じように通しています)。", ""]
    lines += [
        "**%s** の朝の通知(便: %s)で、想定外の失敗がありました。その人(その件)だけを飛ばして、ほかの人には送っています。"
        % (date, trigger),
        "",
        "| 利用者(IDの先頭8文字) | 何が起きたか | 件数 |",
        "|---|---|---|",
    ]
    for user, kind, n in rows:
        lines.append("| %s | %s | %d |" % ("(便全体)" if user == "-" else "`%s`" % user, describe(kind), n))
    if more:
        lines.append("| (ほか %d 行は省略) | | |" % more)
    if bad:
        lines.append("| (形の違う行 %d 件は出していません) | | |" % bad)
    lines += [
        "",
        "飛ばした利用者: %d人。期限切れの宛先(404・410)は、いつもどおり消しただけで、ここには入れていません。" % len(users),
        "",
        "**見るところ**",
        "- 誰の分か: Supabase の表で `user_id` が上の8文字で始まる行(条件なら race_alerts、ブラウザの宛先なら push_subscriptions、"
        "iOS なら apns_tokens)。",
        "- 何が起きたか: Supabase の Edge Functions → send-morning-push のログで、同じ8文字を検索。",
        "- 壊れた条件・通知サービス以外の宛先は、画面からは作れない形です。わざと書き込まれたものか、保存側の不具合を疑う。",
        "",
        "scripts/notify_push_failures.py が立てました。片付けたら閉じてください(次の失敗は新しく立ちます)。",
    ]
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true", help="gh を呼ばず、立てる内容を出すだけ")
    a = ap.parse_args()
    env = os.environ
    date = env.get("DATE", "")
    trigger = env.get("TRIGGER", "")
    if not DATE_RE.match(date):
        date = "(日付不明)"
    if not TRIGGER_RE.match(trigger):
        trigger = "other"
    rows, bad, more = clean(env.get("FAILURES", ""))
    if not rows and not bad:
        print("[push-failures] 知らせる失敗がありません")
        return 0
    digest = hashlib.sha1(json.dumps([date, rows, bad, more]).encode("utf-8")).hexdigest()[:12]
    marker = "<!-- push-failures:%s:%s -->" % (date, digest)
    body = marker + "\n" + body_of(date, trigger, rows, bad, more)
    print("[push-failures] %d行(形の違う行 %d)を知らせます" % (len(rows), bad))
    ok = gh_issue.notify(TITLE, body, marker, dry=a.dry, tag="[push-failures]")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
