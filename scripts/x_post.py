# -*- coding: utf-8 -*-
"""
X(旧Twitter)へ1回の実行につき1件だけ投稿する。

  python scripts/x_post.py --text "本文" [--dry-run]

【なぜ最小限の作りにしてあるか】
投稿は取り消しの効かない外向きの操作で、事故ると人目に触れる。連投・二重投稿は
アカウントの信用に直接響く。そのため次の3つを構造で禁じている:

  1. 1回の実行で投稿は最大1件。2回目の呼び出しは例外で止める
  2. 自動リトライをしない。失敗したら止まる(同じ本文が2回出る事故を作らない)
  3. 失敗を握りつぶさない。応答本文をそのまま出して非0で終わる

3つ目は特に、このリポジトリで前科がある。build_featured.py が例外を
print だけして exit 0 していたため、45日間ずっと失敗していたのに CI が緑のまま
気づけなかった(2026-07-13〜08-26)。同じ形を作らない。

【リンクを入れない】(2026-10-05)
X API は URL を含む投稿が1件$0.20(通常は$0.015)。今日の一問・二つ名ウォッチは
返信でURLを付けていたが、10/4の今日の一問は本文1,000表示に対し返信13表示(約1.3%)で、
返信のURLだけで月$6強かかっていた。返信をやめ、行き先は本文で
「プロフィールのリンク→〇〇」と案内する。
本文に URL やドメインらしき文字列(teiyomi.com など)があれば送らない。
X が自動でリンクにして、URL入りの投稿として数えられるため。
(以前ここにあった本文+返信1件の post_thread() は、使う所が無くなったので外した)

【認証】
X API v2 の POST /2/tweets は OAuth 1.0a User Context を要求する。
キー4本は環境変数から読む。リポジトリのSecretsに同名で入れてある。
  X_API_KEY / X_API_KEY_SECRET / X_ACCESS_TOKEN / X_ACCESS_TOKEN_SECRET
値はログに出さない(設定の有無だけを出す)。

【依存】
  pip install requests requests-oauthlib
このリポジトリで初めての外部依存。tweepy等の大きいものは入れない。
"""
import argparse
import os
import re
import sys
import unicodedata

API_URL = "https://api.x.com/2/tweets"
TIMEOUT_SEC = 30
MAX_WEIGHTED = 280   # Xの上限。全角は1文字=2として数える(下の weighted_len 参照)

# リンクとして拾われそうなもの: http(s)://・www.・「英数字.英字2文字以上」(teiyomi.com 等)。
# 日本語が直後に続いても拾えるよう、境目は \b ではなく英数字かどうかで見る
# (Python の \b は日本語も文字として扱うので「teiyomi.comから」を見逃す)。
LINK_RE = re.compile(r"https?://|www\.|(?<![A-Za-z0-9-])[A-Za-z0-9][A-Za-z0-9-]*\.[A-Za-z]{2,}(?![A-Za-z0-9])")

ENV_KEYS = ("X_API_KEY", "X_API_KEY_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET")

# 1プロセス1投稿の見張り。ここを通せるのは1回だけ。
_posted = False


def weighted_len(text):
    """Xの数え方に寄せた文字数。日本語などの全角は1文字が2つぶんとして数えられる。

    正確な仕様(Twitter text weighting)はもう少し細かいが、ここは投稿前に
    「明らかに長すぎる」を弾くための安全網なので、全角=2 の近似で足りる。
    近似のぶんは必ず厳しい側(実際より長め)に出るようにしてある。"""
    n = 0
    for ch in text:
        n += 2 if unicodedata.east_asian_width(ch) in ("F", "W", "A") else 1
    return n


def find_link(text):
    """本文の中のリンクらしき文字列。無ければ None。"""
    m = LINK_RE.search(text or "")
    return m.group(0) if m else None


def read_credentials():
    """環境変数から4本を読む。1本でも欠けていたら、何が欠けているかを言って止める。"""
    missing = [k for k in ENV_KEYS if not os.environ.get(k)]
    if missing:
        sys.exit(
            "[x_post] 認証情報が足りません: " + ", ".join(missing) + "\n"
            "  GitHub Actions で動かす場合はリポジトリの Secrets に同名で登録し、\n"
            "  ワークフローの env: で渡してください。\n"
            "  手元で試す場合は環境変数に入れてください(値はリポジトリに置かないこと)。"
        )
    return {k: os.environ[k] for k in ENV_KEYS}


def post(text, dry_run=False):
    """1件だけ投稿する。成功したら投稿IDを返す。失敗は例外か sys.exit で表に出す。"""
    global _posted
    if _posted:
        raise RuntimeError("[x_post] 1回の実行で投稿できるのは1件までです")

    if not text or not text.strip():
        sys.exit("[x_post] 本文が空です")
    w = weighted_len(text)
    if w > MAX_WEIGHTED:
        sys.exit(f"[x_post] 本文が長すぎます: {w} > {MAX_WEIGHTED}（全角1文字=2で計算）")
    link = find_link(text)
    if link:
        sys.exit(f"[x_post] 本文にリンクらしき文字列があります: {link}\n"
                 "  URL入りの投稿は1件$0.20かかるので送りません。行き先は「プロフィールのリンク→〇〇」で案内してください。")

    creds = read_credentials()   # dry-runでも読む。Secretsの配線ミスをここで気づけるように。

    print("[x_post] 認証情報: " + " / ".join(f"{k}=設定あり" for k in ENV_KEYS))
    print(f"[x_post] 文字数: {w}/{MAX_WEIGHTED}（全角1文字=2）")
    print("[x_post] 送る本文 ここから")
    print(text)
    print("[x_post] 送る本文 ここまで")

    if dry_run:
        print("[x_post] --dry-run のため投稿しません。")
        return None

    # import をここに置いているのは、--dry-run だけ試したい時に
    # requests-oauthlib が無くても動くようにするため。
    from requests_oauthlib import OAuth1Session

    _posted = True   # 送信を試みた時点で立てる。応答が読めなくても2件目は出さない。
    session = OAuth1Session(
        creds["X_API_KEY"],
        client_secret=creds["X_API_KEY_SECRET"],
        resource_owner_key=creds["X_ACCESS_TOKEN"],
        resource_owner_secret=creds["X_ACCESS_TOKEN_SECRET"],
    )
    # リトライはしない。タイムアウトは「届いていないこと」を保証しないので、
    # 投げ直すと同じ本文が2回出る恐れがある。失敗したら人が確認して判断する。
    try:
        res = session.post(API_URL, json={"text": text}, timeout=TIMEOUT_SEC)
    except Exception as e:
        sys.exit(
            f"[x_post] 送信できませんでした: {type(e).__name__}: {e}\n"
            "  投稿が成立したかどうかはこちらからは分かりません。"
            "再実行する前に、必ずXの画面で投稿の有無を確認してください。"
        )

    body = res.text
    if res.status_code >= 300:
        sys.exit(
            f"[x_post] 投稿に失敗しました HTTP {res.status_code}\n"
            f"  応答: {body}"
        )

    try:
        tweet_id = res.json()["data"]["id"]
    except Exception:
        sys.exit(f"[x_post] 応答を読めませんでした HTTP {res.status_code}\n  応答: {body}")

    print(f"[x_post] 投稿しました id={tweet_id}")
    print(f"[x_post] https://x.com/teiyomi_app/status/{tweet_id}")
    return tweet_id



def main():
    p = argparse.ArgumentParser(description="Xへ1件だけ投稿する")
    p.add_argument("--text", required=True, help="投稿する本文")
    p.add_argument("--dry-run", action="store_true",
                   help="実際には投稿せず、送る予定の本文だけを出す")
    a = p.parse_args()
    post(a.text, dry_run=a.dry_run)


if __name__ == "__main__":
    main()
