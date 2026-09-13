# 審査用アカウントのパスワード

ストアの審査員がログインするためのアカウントにだけ、パスワードを設定している
（一般の利用者はパスワードを持たず、メールに届く6桁コードでログインする）。

| 用途 | メール | 契約 |
|---|---|---|
| Apple 審査 | `mtpworks.info+applereview@gmail.com` | **無し**（審査員が Sandbox で購入を試すため） |
| Google Play 審査 | Play Console の審査メモを参照 | 手動で付与（2099-12-31 まで） |

Apple 審査用の UID は `APPLE_SANDBOX_USER_IDS` に入れる（`appstore-verify-deploy.md`）。
作り直したら入れ直すこと。

## 設定のしかた（これだけを使う）

```bash
cd ~/dev/boat-card && git pull && node tools/set-review-password.mjs
```

1コマンドで、パスワードの生成 → Admin API で設定 → **実際にパスワードでログインして確認** →
パスワードを1度だけ表示、まで済む。service role キーは supabase CLI（ログイン済み）から
取り、画面にもファイルにも出さない。

- 表示されたパスワードは、すぐ「パスワード」アプリへ保存し、ターミナルは ⌘K で消す
- `4/5 ログイン確認: ✖` になったら、その1行を見て原因を切り分ける（設定自体は済んでいる）
- Play 用に使うときは `--email <Play審査用のメール>`

## SQL で `encrypted_password` を直接書き換えない

2026-09-13、Apple 審査用アカウントに対して、手元で作った bcrypt ハッシュ（`$2a$10$`・60文字）を
SQL で入れる方法を2回試し、2回とも `invalid_credentials` になった。

調べて分かったこと：

- **GoTrue はハッシュの形式では拒まない。** `User.Authenticate` は、暗号化された値でなければ
  そのまま `bcrypt.CompareHashAndPassword` に渡す（`$2a$`/`$2y$` の区別も、長さの検査も無い）。
  ハッシュのコストが 10 を超えるか最小なら、ログイン成功時に作り直すだけ
  （supabase/auth `internal/models/user.go`・`internal/crypto/password.go`）。
- **ユーザーの探し方の条件はすべて満たしていた。** `instance_id` が全ゼロ、`aud = authenticated`、
  `is_sso_user = false`、メールは小文字で1件だけ、メール確認済み、停止なし
  （`internal/models/user.go` の `FindUserByEmailAndAudience`）。
- **作ったハッシュ自体は正しい bcrypt だった。** macOS の `htpasswd -B` で作り `$2y$` → `$2a$` に
  置き換えたハッシュは、ダミーのパスワードで bcryptjs・htpasswd のどちらでも照合が通る。
- 失敗の詳しい理由（`error` 欄）はダッシュボードの Auth ログにしか出ない。DB の
  `auth.audit_log_entries` は使われておらず（0件）、ログイン方式の記録（`mfa_amr_claims`）も
  セッションが消えると残らない。

以上から、**形式ではなく「入れたハッシュと、入力したパスワードが対応していなかった」**
可能性が最も高いが、Auth ログを見ていないので確定はしていない。どちらにしても、
SQL で入れる方法には「その値で本当にログインできるか」をその場で確かめる段が無く、
失敗したときに原因が「値の食い違い」「メール」「GoTrue 側」のどれかに割れて切り分けに
手間がかかる。だから Admin API で設定し、同じスクリプトの中でログインまで確かめる。
