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
import sys
import unicodedata

API_URL = "https://api.x.com/2/tweets"
TIMEOUT_SEC = 30
MAX_WEIGHTED = 280   # Xの上限。全角は1文字=2として数える(下の weighted_len 参照)

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



# ---------------------------------------------------------------- 本文 + 返信1件

_replied = False


def _send(session, payload):
    """1回だけ送る。リトライしない理由は post() と同じ。成功したら投稿IDを返す。"""
    res = session.post(API_URL, json=payload, timeout=TIMEOUT_SEC)
    if res.status_code >= 300:
        raise RuntimeError(f"HTTP {res.status_code} 応答: {res.text}")
    return res.json()["data"]["id"]


def post_thread(text, reply_text, dry_run=False):
    """本文を1件出し、その返信として1件だけ付ける。(本文ID, 返信ID) を返す。

    【1実行1件の原則をどう広げたか】
    この原則は「同じ本文が2回出る事故を作らない」ためにある。返信は本文とは別の
    文なので、本文1件 + 返信1件 までは許す。本文を2回出す経路は作らない。

    【返信だけ失敗したとき】
    本文はもう世に出ている。ここで非0終了すると、呼び出し側が状態を保存せず、
    翌週もう一度同じ変化を拾って**本文を二重に出す**。それがいちばん悪い。
    だから返信の失敗は、Actionsのエラー注記(::error::)で目立たせたうえで
    終了コードは0のまま返す。握り潰すのではなく、二重投稿を防ぐほうを取る。
    本文の失敗は post() と同じく非0で止める。
    """
    global _posted, _replied
    if _posted or _replied:
        raise RuntimeError("[x_post] 1回の実行で出せるのは本文1件+返信1件までです")
    for label, t in (("本文", text), ("返信", reply_text)):
        if not t or not t.strip():
            sys.exit(f"[x_post] {label}が空です")
        w = weighted_len(t)
        if w > MAX_WEIGHTED:
            sys.exit(f"[x_post] {label}が長すぎます: {w} > {MAX_WEIGHTED}（全角1文字=2で計算）")

    creds = read_credentials()   # dry-runでも読む(post() と同じ理由)

    print("[x_post] 認証情報: " + " / ".join(f"{k}=設定あり" for k in ENV_KEYS))
    print(f"[x_post] 本文 文字数: {weighted_len(text)}/{MAX_WEIGHTED}（全角1文字=2）")
    print("[x_post] 送る本文 ここから")
    print(text)
    print("[x_post] 送る本文 ここまで")
    print(f"[x_post] 返信 文字数: {weighted_len(reply_text)}/{MAX_WEIGHTED}")
    print("[x_post] 返信 ここから")
    print(reply_text)
    print("[x_post] 返信 ここまで")

    if dry_run:
        print("[x_post] --dry-run のため投稿しません。")
        return None, None

    from requests_oauthlib import OAuth1Session

    session = OAuth1Session(
        creds["X_API_KEY"],
        client_secret=creds["X_API_KEY_SECRET"],
        resource_owner_key=creds["X_ACCESS_TOKEN"],
        resource_owner_secret=creds["X_ACCESS_TOKEN_SECRET"],
    )

    _posted = True   # 送信を試みた時点で立てる(post() と同じ)
    try:
        main_id = _send(session, {"text": text})
    except Exception as e:
        sys.exit(
            f"[x_post] 本文を送れませんでした: {e}\n"
            "  投稿が成立したかどうかはこちらからは分かりません。"
            "再実行する前に、必ずXの画面で投稿の有無を確認してください。"
        )
    print(f"[x_post] 本文を投稿しました id={main_id}")
    print(f"[x_post] https://x.com/teiyomi_app/status/{main_id}")

    _replied = True
    try:
        reply_id = _send(session, {"text": reply_text,
                                   "reply": {"in_reply_to_tweet_id": main_id}})
    except Exception as e:
        print(f"::error::[x_post] 本文は投稿済み(id={main_id})ですが、返信を送れませんでした: {e}")
        print("[x_post] 本文の二重投稿を防ぐため、終了コードは0のまま返します。"
              "返信はXの画面から手で付けてください。")
        return main_id, None
    print(f"[x_post] 返信を投稿しました id={reply_id}")
    return main_id, reply_id

def main():
    p = argparse.ArgumentParser(description="Xへ1件だけ投稿する")
    p.add_argument("--text", required=True, help="投稿する本文")
    p.add_argument("--dry-run", action="store_true",
                   help="実際には投稿せず、送る予定の本文だけを出す")
    a = p.parse_args()
    post(a.text, dry_run=a.dry_run)


if __name__ == "__main__":
    main()
