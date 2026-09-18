"""AI講評の前日の成否を読み、おかしければ GitHub Issue を立てる(2026-09-18 監視)。

【なぜ要るのか】
2026-09-17 23:48 から講評が100%タイムアウトしていたのに、ログを見に行くまで気づけなかった。
毎晩の results.yml(01:00 JST)から呼ばれ、Edge Function ai-health で前日(JST)の件数を読む。

【知らせる条件】AIを1回以上呼んだ日に限って、
  ・成功が0件
  ・失敗が半分を超えた(失敗 / 合計 > 0.5)
呼ばれた回数が0の日は知らせない(使う人がいない日は普通にある。毎日鳴ると読まれなくなる)。
件数そのものが読めなかったときも知らせる(監視が黙って止まるのがいちばん危ない)。

【同じ用件で何枚も立てない】
同じ題の Issue が開いていれば、そこへコメントで足す。本文とコメントに日付の印
(<!-- ai-health:YYYY-MM-DD -->)を入れ、同じ日の印があれば何もしない
(キッカーと GitHub の cron で二度走っても1回だけ)。
x-bot の notify_once / budget_stop と同じく gh で立てる。X には投げない(立て方は gh_issue.py)。

【手元での確かめ方】
  python scripts/check_ai_health.py --dry --fake '{"ok_count":0,"fail_count":3,"total":3,"by":{"timeout":3}}'
  (--dry は gh を一切呼ばず、立てるはずの題と本文を出すだけ)

必要な環境変数: CRON_SECRET(件数を読む)、GH_TOKEN と GH_REPO(Issue を立てる)。
日付を変えるときは --date か AI_HEALTH_DATE(YYYY-MM-DD)。
"""
import argparse
import datetime
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

import gh_issue   # 同じ scripts/ にある。Issue の立て方(重複させない作法)は共通

ENDPOINT = "https://vynbhssakpxiikmseoja.supabase.co/functions/v1/ai-health"
LOGS_URL = "https://supabase.com/dashboard/project/vynbhssakpxiikmseoja/functions/yomi-review/logs"
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

TITLE_BAD = "AI講評: 失敗が多い日があります"
TITLE_UNREAD = "AI講評の監視: 成否の件数を読めませんでした"


def yesterday_jst(now=None):
    """JSTの前日。日付を渡さないときに使う(Issue の日付の印にも要る)。"""
    now = now or datetime.datetime.now(datetime.timezone.utc)
    jst = now.astimezone(datetime.timezone(datetime.timedelta(hours=9)))
    return (jst.date() - datetime.timedelta(days=1)).isoformat()


def judge(s):
    """知らせる理由を返す。知らせなくてよければ None。"""
    total = s.get("total") or 0
    ok = s.get("ok_count") or 0
    fail = s.get("fail_count") or 0
    if total < 1:
        return None
    if ok == 0:
        return "成功が0件"
    if fail / total > 0.5:
        return "失敗が半分を超えた(%d%%)" % round(fail * 100 / total)
    return None


def fetch_summary(date):
    secret = os.environ.get("CRON_SECRET", "")
    if not secret:
        raise RuntimeError("CRON_SECRET がありません")
    url = ENDPOINT + "?date=" + date
    last = None
    for attempt in range(2):
        try:
            req = urllib.request.Request(url, headers={"x-cron-secret": secret})
            with urllib.request.urlopen(req, timeout=30) as res:
                body = json.loads(res.read().decode("utf-8"))
            if body.get("ok") is not True:
                raise RuntimeError("応答が ok ではありません")
            return body
        except urllib.error.HTTPError as e:
            last = "HTTP %d" % e.code
        except Exception as e:  # 通信・JSON の崩れ
            last = type(e).__name__
        if attempt == 0:
            time.sleep(5)
    raise RuntimeError(last or "不明")


def body_bad(s, reason):
    by = s.get("by") or {}
    parts = ["%s %d" % (k, by[k]) for k in sorted(by, key=lambda k: (-by[k], k))]
    return "\n".join([
        "<!-- ai-health:%s -->" % s["date"],
        "**%s(JST)** のAI講評: 成功 %d件 / 失敗 %d件 → %s"
        % (s["date"], s.get("ok_count") or 0, s.get("fail_count") or 0, reason),
        "",
        "内訳: " + (", ".join(parts) or "なし"),
        "推論量: " + (", ".join("%s %d" % (k, v) for k, v in sorted((s.get("efforts") or {}).items())) or "記録なし")
        + "(2026-09-18 21:00 JST に既定→low。戻すなら Secret AI_REASONING_EFFORT を消す)",
        "",
        "- timeout … AIの応答が AI_TIMEOUT_MS(既定45秒)に間に合っていない"
        "(2026-09-17 はこれ。応答時間と締切がほぼ同じ長さだった)",
        "- http_error … 鍵・残高・モデル名。exception … 通信",
        "- empty / banned / invented … AIは返したが出力フィルタで止めた",
        "- no_config … AI_API_KEY が無い",
        "",
        "ログ: " + LOGS_URL,
        "",
        "scripts/check_ai_health.py が results.yml から立てました。",
    ])


def body_unread(date, why):
    return "\n".join([
        "<!-- ai-health:%s -->" % date,
        "**%s(JST)** ぶんのAI講評の成否を読めませんでした(%s)。"
        % (date, why),
        "",
        "- 401 … GitHub の CRON_SECRET と Supabase の CRON_SECRET が食い違っている",
        "- 404 … Edge Function ai-health がデプロイされていない",
        "- 500 … テーブル yomi_ai_outcomes_daily が読めない",
        "",
        "scripts/check_ai_health.py が results.yml から立てました。",
    ])


def notify(title, body, date, dry):
    return gh_issue.notify(title, body, "<!-- ai-health:%s -->" % date, dry=dry, tag="[ai-health]")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=os.environ.get("AI_HEALTH_DATE", ""))
    ap.add_argument("--dry", action="store_true", help="gh を呼ばず、立てる内容を出すだけ")
    ap.add_argument("--fake", help="ai-health の応答の代わりに使う JSON(手元での確認用)")
    a = ap.parse_args()

    date = a.date.strip() or yesterday_jst()
    if not DATE_RE.match(date):
        print("[ai-health] 日付の形が違います(YYYY-MM-DD)")
        return 2

    try:
        s = json.loads(a.fake) if a.fake else fetch_summary(date)
        s.setdefault("date", date)
    except Exception as e:
        why = str(e)
        print("[ai-health] %s の件数を読めませんでした: %s" % (date, why))
        return 0 if notify(TITLE_UNREAD, body_unread(date, why), date, a.dry) else 1

    print("[ai-health] %s ok=%s fail=%s by=%s efforts=%s"
          % (s["date"], s.get("ok_count"), s.get("fail_count"),
             json.dumps(s.get("by") or {}, ensure_ascii=False),
             json.dumps(s.get("efforts") or {}, ensure_ascii=False)))
    reason = judge(s)
    if not reason:
        print("[ai-health] 知らせる条件に当たりません")
        return 0
    return 0 if notify(TITLE_BAD, body_bad(s, reason), s["date"], a.dry) else 1


if __name__ == "__main__":
    sys.exit(main())
