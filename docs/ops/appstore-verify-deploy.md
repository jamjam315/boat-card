# iOS購入検証（verify-purchase）のデプロイ手順

App Store Server API で購入を検証する経路を有効にする手順。**JAMが実施する。**

これをやるまで、iOSの購入は `APPLE_* secrets not configured` で常に無効になる
（フェイルクローズ）。**Androidの経路には一切影響しない。**

> ⚠️ **このファイルは main に置かれるので `https://teiyomi.com/docs/ops/…` から
> 誰でも読めます。** 鍵・Issuer ID・キーIDなどの現物は、ここにも他のどのファイルにも
> 書かないこと。書いてよいのは「どこに何を入れるか」だけ。

---

## 0. いま何が入っているか

| 項目 | 値 |
|---|---|
| Bundle ID | `com.mtpworks.teiyomi` |
| 商品ID | `teiyomi_premium_monthly`（月額 ¥480） |
| Supabase プロジェクト | `vynbhssakpxiikmseoja` |

---

## 1. App Store Server API のキーを用意する

App Store Connect → **ユーザーとアクセス** → **統合** → **App Store Connect API**
→ **App内課金** のタブ

> **「App Store Connect API」タブのチームキーではありません。** 隣にある
> **App内課金（In-App Purchase）** のキーです。ここを取り違えると、値が正しくても
> Sandboxでも401になります（切り分け方は手順4）。

1. **+** でキーを作成（名前は `teiyomi-verify` など何でもよい）
2. **`.p8` ファイルをダウンロード**
   - ⚠️ **再ダウンロードできない。** 1回きり。無くしたらキーを作り直す
   - ⚠️ **リポジトリの中に置かないこと。** `~/Documents/` などに置く
     （`.gitignore` が `*.p8` を弾いてはいるが、置かないのがいちばん確実）
3. 一覧に出る **キーID**（10桁）を控える
4. 同じ画面の **Issuer ID**（36桁のUUID）を控える

※ WP-3aの時点でJAMは発行済み。手元の `.p8` とキーID・Issuer IDを使う。

## 2. Supabase Secrets に入れる

**この4つ。値はSupabase側にだけ置く**（アプリにもWebにも入れない）。

| Secret | 値 |
|---|---|
| `APPLE_KEY_ID` | 手順1のキーID（10桁） |
| `APPLE_ISSUER_ID` | 手順1のIssuer ID（36桁のUUID） |
| `APPLE_PRIVATE_KEY` | `.p8` の中身を**そのまま**（`-----BEGIN PRIVATE KEY-----` を含む全文） |
| `APPLE_BUNDLE_ID` | `com.mtpworks.teiyomi` |

### CLIから入れる（`<>` の中だけ埋める）

```bash
supabase secrets set \
  APPLE_KEY_ID=<キーID10桁> \
  APPLE_ISSUER_ID=<Issuer ID 36桁> \
  APPLE_BUNDLE_ID=com.mtpworks.teiyomi \
  APPLE_PRIVATE_KEY="$(cat ~/Documents/<AuthKey_XXXXXXXXXX>.p8)" \
  --project-ref vynbhssakpxiikmseoja
```

`$(cat …)` で渡すのは、`.p8` が複数行だから。**手で貼るときは改行を潰さないこと**
（1行に潰すと `failed to sign apple token` になる）。

### ダッシュボードから入れる場合

Supabaseダッシュボード → **Edge Functions** → **Secrets** → 「Add new secret」

`APPLE_PRIVATE_KEY` は `.p8` をテキストエディタで開いて**全文をそのまま貼り付ける**。

## 3. 関数をデプロイする

**ダッシュボードからのデプロイは、この関数では使えない。** `verify-purchase` は
`index.ts` と `logic.ts` の2ファイル構成で、ダッシュボードのエディタは単一ファイルの
編集しか想定していない（`./logic.ts` の import が解決できない）。CLIを使う。

```bash
brew install supabase/tap/supabase   # 未導入なら
supabase login                       # ブラウザが開く。承認する
cd ~/dev/boat-card
supabase functions deploy verify-purchase --project-ref vynbhssakpxiikmseoja
```

> `supabase link` は不要。`functions deploy` は `--project-ref` だけで通る
> （linkするとDBパスワードを聞かれるので、避けたほうが手数が少ない）。

**同じ手順で `delete-account`（WP-2b）も未デプロイなら一緒に出せる。**

```bash
supabase functions deploy delete-account --project-ref vynbhssakpxiikmseoja
```

## 4. 値が正しいかを、Supabaseを通さずに確かめる

デプロイ前でも後でも使える。`tools/apple-jwt-check.mjs` が、同じ4つの値で
Appleを**直接**叩いて、認証が通っているかだけを見る。

```bash
cd ~/dev/boat-card
cp tools/env.local.sample tools/.env.local
open -e tools/.env.local          # キーID・Issuer ID・.p8のパスを書く
node tools/apple-jwt-check.mjs
```

`tools/.env.local` と `*.p8` は `.gitignore` 済み。この道具は**値そのものを一切
表示しない**（桁数・行数・秒数だけ）。

### 正常なら、こう出る

```
--- 設定の形（値そのものは出しません） ---
  実行環境          : Node v22.x.x
  kid の桁数        : 10
  iss の桁数        : 36
  bid               : com.mtpworks.teiyomi
  aud               : appstoreconnect-v1
  exp - iat（秒）   : 1200
  秘密鍵の渡し方    : APPLE_PRIVATE_KEY_FILE（.p8ファイル）
  .p8 の行数        : 4
  .p8 の1行目       : -----BEGIN PRIVATE KEY-----
  .p8 の最終行      : -----END PRIVATE KEY-----
  transactionId桁数 : 16
  署名の実装        : node:crypto (ieee-p1363)

--- Apple Sandbox ---
GET https://api.storekit-sandbox.itunes.apple.com/inApps/v1/transactions/****
  status: 404 Not Found
  errorCode: 4040010

--- Apple 本番 ---
GET https://api.storekit.itunes.apple.com/inApps/v1/transactions/****
  status: 401 Unauthorized

--- 判定 ---
  Sandboxの認証は通っています＝**Secretsの値は正しい**。
  本番だけ401。アプリがApp Storeで公開されるまで本番の
  App Store Server API は401を返す、という既知の挙動と一致します。
```

**Sandboxが404なのは正常。** 存在しないtransactionIdを投げているので「無い」と
返るのが正しく、401でないことが「認証は通った＝値は正しい」の証拠になる。

**本番の401も、公開前は正常。** `verify-purchase` は401でもSandboxへ問い直す作りに
してあるので（`shouldRetryInSandbox`）、この状態でもiOSの購入は検証できる。

### Sandboxでも401だったら

値かキーの種類の問題。次を順に確認する。

- キーは **App内課金** のタブで作ったものか（App Store Connect API のチームキーではないか）
- Issuer ID は、そのキーが載っている画面のものか
- キーIDとIssuer IDを取り違えていないか
- `.p8` はそのキーIDのものか（作り直すと旧鍵は失効する）

## 5. 実機で確かめる

デプロイ後、iPhoneでSandboxの購入を実行する（WP-3b・3cでアプリ側が入ってから）。

Supabaseダッシュボード → Edge Functions → `verify-purchase` → **Logs**

ログには結果だけが出る（トークン本文とAppleの応答は出さない設計）。

```
[verify-purchase] apple api production=401 sandbox=200
[verify-purchase] verified(ios) user=3f2b7c10 product=teiyomi_premium_monthly active=true
```

### つまずいたときの見どころ

| ログ | 意味 | 直し方 |
|---|---|---|
| `APPLE_* secrets not configured` | Secretsが揃っていない | 手順2の4つを確認。1つでも欠けるとここ |
| `failed to sign apple token` | `.p8` の中身が壊れている | 改行を含めて全文が入っているか。BEGIN/END行も要る |
| `apple api production=401 sandbox=401` | キーIDかIssuer IDが違う | 手順4で切り分ける |
| `apple api production=404 sandbox=404` | 本番にもSandboxにも無い | 購入が成立していない。Sandboxテスターでサインインし直す |
| `malformed jws` | アプリが送った値が壊れている | 殻側（WP-3b）の問題。実機のログを見る |
| `apple verdict=bundle mismatch` | `APPLE_BUNDLE_ID` が実物と違う | `com.mtpworks.teiyomi` か確認 |
| `apple verdict=product mismatch` | 商品IDが `teiyomi_premium_monthly` でない | ASCの商品IDと `logic.ts` の `PRODUCT_IDS` を突き合わせる |
| `apple verdict=expired` | 期限切れ | Sandboxの購読は数分で切れる。買い直す |
| `invalid purchase_token for ios` | JWSの形をしていない | 殻側が別の値を送っている |

---

## 設計メモ

### なぜJWSの署名を自前で検証しないのか

クライアントが送ってくるJWSからは **`transactionId` だけを取り出し、その値を
信用せずAppleへ問い合わせる**。Appleの応答が権威。Androidが `purchase_token` を
Google Play Developer APIへ投げるのと同じ形。

署名を自前で検証しようとすると、`x5c` の証明書チェーン（リーフ←中間←ルート）を
X.509までパースして辿る必要がある。**リーフの公開鍵だけで検証するのは危険**で、
攻撃者は自己署名の証明書を `x5c` に入れて好きなペイロードに署名できる。
「ルート証明書の指紋を比べる」を足しても、`x5c` に本物のルートを混ぜるだけで
すり抜ける。連鎖を省いた検証は検証ではない。Appleへ問い合わせるほうが安全かつ簡単。

### 本番とSandboxの順番

**まず本番へ、届かなければSandbox。** Appleの推奨順。Sandboxの取引は本番に存在
しないので、この順で必ず見つかる。逆順にすると、本番の購入がSandboxに無いぶん
全利用者の検証で毎回1往復むだになる。

Sandboxへ回すのは **404+4040010** と **401** の2つだけ。401を足しているのは、
アプリが公開されるまで本番が401を返すため（レジャー帳で実測）。公開後は本番が
200を返すので、Sandboxには回らなくなる。

### memberships に入れる値

| 列 | 値 |
|---|---|
| `status` | `active` / `inactive` |
| `price_id` | 商品ID（`teiyomi_premium_monthly`） |
| `current_period_end` | Appleの `expiresDate` |
| `purchase_token` | **`originalTransactionId`**（JWS本文でも `transactionId` でもない） |
| `platform` | `ios` |

`purchase_token` に `originalTransactionId` を入れるのは、**これが購読の更新を
またいで変わらない唯一の値**だから。JWSも `transactionId` も更新のたびに変わるので、
鍵にすると次回引けず、24時間キャッシュも使い回しの検出も永久に効かなくなる
（レジャー帳で実際にそうなっていた）。

`platform` 列にCHECK制約は無いので、`ios` を足すのにマイグレーションは要らない。
`is_premium()` を含む会員判定の4か所は `status` と `current_period_end` しか
見ていないので、**iOSの行でもそのまま会員として扱われる**。
