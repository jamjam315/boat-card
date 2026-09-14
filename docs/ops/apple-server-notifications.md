# App Store Server Notifications V2（WP-6）

自動更新・支払いの失敗・期限切れ・返金を、アプリを開かなくても memberships に反映する。

## しくみ（案B）

Apple が送ってくる通知は「**確かめ直すきっかけ**」としてだけ使う。

1. 通知の本文から「どの購読か」（originalTransactionId）を読む。**署名は見ない・値は信用しない**
2. memberships の iOS の行（`purchase_token` が一致・`platform = 'ios'`）を探す。**無ければ何もしない**
   （行を作るのは verify-purchase だけ。購入時にアカウントの印を付けていないので、通知だけでは誰の購入か分からない）
3. Sandbox の通知は、`APPLE_ALLOW_SANDBOX=true` かつ、その行の user_id が `APPLE_SANDBOX_USER_IDS` にあるときだけ扱う
4. App Store Server API（Get All Subscription Statuses）で今の状態を取り、`status`・`current_period_end`・`updated_at` だけを書き換える

| Apple の status | memberships |
|---|---|
| 1 有効 | `active`・期限は取引の `expiresDate`（返金済みなら `inactive`） |
| 4 猶予期間 | `active`・期限は猶予の期限（**Billing Grace Period は有効にする**） |
| 2 期限切れ／3 支払い再試行中／5 取り消し | `inactive` |

偽の通知を送られても、既にある行を Apple の答えどおりに取り直すだけで、誰かを勝手にプレミアムにはできない。

受け取った記録は `apple_notifications` 表（service role 専用）に残し、**90日で消す**（関数が動いたついで）。

URL は公開されている前提で作ってある（security-review 2026-09-13 で直した点を含む）。

- **応答を先に返し、処理はその後**（2026-09-14）。形・大きさ・bundleId だけ確かめて 200 を返し、
  行の確認・Apple への問い合わせ・memberships の更新は応答の後に行う。以前は全部を待ってから応答していて、
  TestFlight の自動更新の DID_RENEW が Apple の記録で `TIMED_OUT` になった（止まっていた関数の起動と合わせて約4.5秒）
- 応答した後なので、失敗しても Apple は送り直さない。一時的な失敗は関数の中で2回までやり直し、
  それでも駄目なら記録の `result` が `error: …` になる。取りこぼした分は、アプリを開いたときの日次の復元で取り直す
  （billing-ios.js の `autoRestoreIfRenewalDue`: iOSアプリ・ログイン済み・期限切れ扱い・この端末で検証済みのとき、1日1回）
- 行が見つからない通知・他のアプリの通知・Sandbox の許可リストに無い人の通知は、記録も残さない
- TEST 通知は環境ごとに1行（`test-production` / `test-sandbox`）を上書きするだけ
- 種類・サブタイプが Apple の形（英大文字と `_`）でなければ読まない。本文は 64KB まで
- **同じ購読について Apple へ問い合わせるのは1分に1回まで**（環境ごと）。間隔の内側で届いたものは、明けるまで待ってから扱う。
  問い合わせるのは確認の行（`notification_uuid` が `check:環境:取引ID:直前の確認の時刻`）を先に入れた1件だけで、
  同時に待っていた他の通知はその結果を見届ける。その1件が失敗していたら1件だけが代わりに問い合わせる（鍵の末尾に `:takeover`）。
  記録はこの確認の行だけなので、1つの購読につき1分に1行（失敗の代わりを入れても2行）まで

## JAM の作業（この順）

### 1. 表を作る

```bash
cd ~/dev/boat-card && git pull && supabase db push --project-ref vynbhssakpxiikmseoja
```

### 2. 関数をデプロイする

```bash
cd ~/dev/boat-card && supabase functions deploy apple-notifications --no-verify-jwt --project-ref vynbhssakpxiikmseoja
```

`--no-verify-jwt` を忘れると、Apple の通知がすべて401で弾かれる（Apple は Supabase の JWT を持たない）。
Secrets は verify-purchase と同じもの（`APPLE_*`・`APPLE_ALLOW_SANDBOX`・`APPLE_SANDBOX_USER_IDS`）をそのまま使うので、足すものは無い。

verify-purchase も JWT を作る部分を共有ファイルへ移したので、あわせてデプロイし直す（動作は変わらない）。

```bash
cd ~/dev/boat-card && supabase functions deploy verify-purchase --project-ref vynbhssakpxiikmseoja
```

### 3. App Store Connect で通知の送り先を入れる

App Store Connect →「アプリ」→ 艇読み → 左メニュー「App 情報」→「App Store Server Notifications」

| 項目 | 値 |
|---|---|
| 本番サーバ URL | `https://vynbhssakpxiikmseoja.supabase.co/functions/v1/apple-notifications` |
| バージョン | バージョン 2 |
| Sandbox サーバ URL | 上と同じ URL |
| バージョン | バージョン 2 |

同じ URL でよい（本番か Sandbox かは、関数が通知の中の environment で見分ける）。

### 4. 支払いの猶予期間（Billing Grace Period）を有効にする

App Store Connect →「アプリ」→ 艇読み →「サブスクリプション」→ 右上付近の「請求の猶予期間」→ 有効にする
（期間は ASC の選択肢から。対象は「すべての更新」でよい）。

### 5. 届くか確かめる

```bash
cd ~/dev/boat-card && node tools/apple-test-notification.mjs
```

`2/2 送信結果: ✅ SUCCESS` なら、Apple → 関数まで届いている（`apple_notifications` の `notification_uuid = 'test-sandbox'` の行の `processed_at` が今の時刻になる）。
使う鍵は `tools/.env.local`（apple-jwt-check.mjs と同じもの）。

### 6. 実際の更新で確かめる（任意）

Sandbox の月額購読は数分ごとに自動更新される。許可リストにあるテスト用アカウントで Sandbox 購入をしたあと、
Supabase の Table Editor で `apple_notifications` に `check:sandbox:…` の行が `updated active: active` で増え、
memberships のその行の `updated_at` と `current_period_end` が進んでいくことを見る。

## ログの見方（Edge Function のログ）

| ログ | 意味 |
|---|---|
| `updated active (active) user=xxxxxxxx type=DID_RENEW env=Production` | 更新を反映した |
| `updated inactive (expired) …` | 期限切れ・返金などを反映した |
| `no membership row type=SUBSCRIBED …` | その購入をまだアプリで検証していない（アプリを開けば verify-purchase が行を作る） |
| `sandbox not allowed user=…` | 許可リストに無い人の Sandbox 購読（TestFlight のテスター等）。正常な無視（記録は残さない） |
| `cooldown: wait NNs user=…` | 同じ購読を1分以内に確認したばかりなので、明けるまで待ってから扱う |
| `cooldown: merged …` / `covered …` / `covered (watching) …` / `takeover by another …` | 同じ間隔の確認を別の1件がした（またはしている）ので、この通知は扱わずに終えた。短時間に大量に出ていたら偽の通知の連打 |
| `takeover (error: …) …` | 先に確認した1件が失敗したので、代わりに確認した |
| `retry in Ns (…)` | Apple への問い合わせか更新が一時的に失敗したので、やり直す |
| `gave up (apple status 401) …` | やり直しても駄目だった（401 は鍵の誤り）。記録は `error: …`。Apple は送り直さないので、鍵を直したあとは日次の復元で取り直される |
| `shutdown …` | 実行環境が止められた。処理の途中なら記録が `processing` のまま残る（待っていた通知があれば38秒後に代わりに確認する） |

## Google Play 側の同じ穴（別 WP の候補）

Android（Play Billing）も、購読の状態が memberships に反映されるのはアプリで購入・確認したときだけで、
**Google の Real-time Developer Notifications（RTDN）を受けていない**。更新・解約・返金はアプリを開くまで反映されない。
iOS と同じ形（通知をきっかけに Play Developer API で取り直す）で塞げる。今回は範囲外。
