# メールのテンプレート

Supabaseが送るメールの本文。**実体はSupabaseダッシュボードにあり、ここに置いてあるのは
貼り付け用の原本**（`supabase/config.toml` の `content_path` は使っていないので、
このファイルを置いてもデプロイでは反映されない）。

| ファイル | 貼る先 | いつ飛ぶか |
|---|---|---|
| `confirm-signup.html` | Authentication → Emails → **Confirm signup** | 未登録・未確認のアドレスでログインを申し込んだとき |

Magic Link と Change Email Address は2026-07-31に日本語化済みで、原本はダッシュボードに
しかない。**この2つとの見た目の差が気になったら、そちらをこのディレクトリに写しておくこと。**

## 貼り方

1. Supabaseダッシュボード → **Authentication** → **Emails**
2. 上のタブで **Confirm signup** を選ぶ
3. **Subject heading** を `艇読み ログイン用のコード` にする
4. **Message body** を全部消して、`confirm-signup.html` の中身をそのまま貼る
5. 保存

## なぜ確認リンクを置かないのか

`{{ .ConfirmationURL }}` を置くと、iOSアプリの中から申し込んだ人がそのリンクを踏んだとき、
**外部のSafariが開いてそちらにセッションができる**。アプリのWKWebViewには来ないので、
アプリはいつまでも未ログインのまま（Android/PWAでも、Gmailのアプリ内ブラウザで同じことが
起きる。2026-07-31にXperiaで実際に踏んだ）。

コードだけにすれば、セッションは**いま開いている画面**に作られるので、この「部屋が違う」問題が
構造的に起きない。6桁コードの入力欄は `mypage.html` に既にある。

## なぜ Confirm signup にもコードが要るのか

`signInWithOtp` を呼んでも、相手が**新規または未確認**なら GoTrue は `Signup` に委譲するので、
飛ぶのは Magic Link ではなく **Confirm signup**（`internal/api/magic_link.go` の
`isNewUser = !user.IsConfirmed()`）。ここにコードが無いと、初回の人だけログインできない。

検証側は変更不要。`verifyOtp({type:'email'})` は `confirmation_token`（signup が発行）と
`recovery_token`（magiclink が発行）の**両方**を照合する（`internal/api/verify.go` の
`case mail.EmailOTPVerification`）ので、`favorites.js` の `verifyLoginCode` のままで通る。

## 色

`theme.css` の実値をそのまま使っている（メールはCSS変数を解決できないので直書き）。

| 使った場所 | トークン | 値 |
|---|---|---|
| 外側の地 | `--bg` | `#eef0ec` |
| カードの地 | `--surface` | `#ffffff` |
| 枠線 | `--line2` | `#d3d8d2` |
| 本文 | `--ink` | `#13242a` |
| 補助の文字 | `--ink2` | `#4a5a61` |
| いちばん弱い文字 | `--muted` | `#7c8a90` |
| 見出し・コード | `--water` | `#0f2a33` |
| コードの下地 | `--accent-soft` | `#dff0ea` |
