# App Store 提出手順（艇読み iOS・WP-5 step4）

App Store Connect（以下 ASC）で入れるものを、画面の順に並べた。`<>` の中だけ JAM が埋める。
提出の直前確認（TestFlight）は step5、その前に WP-6（App Store Server Notifications）を終えること。

## 0. 済んでいるもの（触らない）

| 項目 | 状態 |
|---|---|
| 殻の設定 | iPhone専用・`ITSAppUsesNonExemptEncryption = NO`・通知の entitlement（WP-5 step1） |
| verify-purchase | デプロイ済み。`APPLE_ALLOW_SANDBOX=true`＋`APPLE_SANDBOX_USER_IDS`（審査用・テスト用） |
| 審査用アカウント | `mtpworks.info+applereview@gmail.com`（UID `b23c6fb5-…`・契約なし）。パスワードは `review-account-password.md` |
| APNs | Secrets 4つ・送信関数デプロイ済み。実機で受信確認済み |
| サポートページ | https://teiyomi.com/support.html |

## 1. ビルドを上げる

1. `cd ~/dev/teiyomi-ios && git pull && flutter build ipa --release --build-number=2`
   （TestFlight に 1.0 (1) を上げ済み。**同じ番号は上げられない**ので、上げるたびに `--build-number` を1つ増やす）
2. `open ~/dev/teiyomi-ios/build/ios/archive/Runner.xcarchive`（Xcode の Organizer が開く）
3. 右の「Distribute App」→「App Store Connect」→「Upload」。署名は「Automatically manage signing」のまま
4. 数分〜数十分で ASC の「TestFlight」にビルドが出る。**輸出コンプライアンスの質問は出ない**（Info.plist で宣言済み）

## 2. App 情報（左メニュー「一般」→「App 情報」）

| 項目 | 入れる値 |
|---|---|
| 名前 | 艇読み |
| サブタイトル（30字以内） | ボートレースの公式データを自分で読む |
| カテゴリ | プライマリ：スポーツ／セカンダリ：`<任意。無しでよい>` |
| プライバシーポリシー URL | https://teiyomi.com/privacy.html |
| 年齢区分 | 下の「年齢区分」 |
| コンテンツ配信権 | 第三者のコンテンツを表示：**はい**／必要な権利：**はい**（下の理由） |

### 年齢区分

質問票は「賭けの機能は持たないが、実在する公営競技（舟券）の情報を扱う」として**正直に答える**（step0 0-5）。
賭博に関する質問が「シミュレーション」と「実際の賭け」に分かれている場合、艇読みはどちらの機能も
持たない。そのうえで、ギャンブルに関連する情報を含むかを尋ねる項目があれば「含む」と答える。
その他の項目（暴力・性的表現など）はすべて「なし」。「無制限の Web アクセス」は**なし**
（アプリ内で開けるのは teiyomi.com だけで、外部サイトは確認画面を通して Safari で開く）。

### コンテンツ配信権（Guideline 5.2.2）：「はい／はい」

- 理由：表示しているのは公式に配布されている番組表・競走成績（od2）とレーサー期別成績の**数値データを整形したもの**で、配布ページに利用条件の定めは無く、サイトポリシーが保護を明記しているのは文書・画像・ソフトウェア等であるため（2026-09-13 JAM判断）。
- あわせて、サイトポリシーがリンクに事前の届け出を求め営利目的のリンクを断っているため、**iOSアプリの中では boatrace.jp へのリンクをやめ、出典は文字表記のみ**にした（殻の許可リストから除外・`ios.js` がリンクを文字に置き換える）。

## 3. 価格および配信状況

| 項目 | 値 |
|---|---|
| 価格 | 無料（課金はサブスクリプションのみ） |
| 配信国・地域 | **日本のみ**（step0 0-5） |

## 4. App のプライバシー

「データを収集する」→ 以下を選ぶ。**すべて「ユーザーに関連付けられる」「トラッキングに使用しない」、
目的は「App の機能」**。

| 種類 | 項目 | 中身 |
|---|---|---|
| 連絡先情報 | メールアドレス | ログイン・契約の管理 |
| ID | ユーザ ID | アカウントの識別子 |
| ID | デバイス ID | 通知用のデバイストークン（迷ったので申告する側に倒す） |
| 購入 | 購入履歴 | App Store の取引の識別番号と有効期限 |
| ユーザコンテンツ | その他のユーザコンテンツ | お気に入り・条件アラート・検証ノート。AI講評は同意したときだけ OpenAI に送る |

トラッキング：**なし**（広告・解析のタグを使っていない）。

## 5. サブスクリプション（左メニュー「収益化」→「サブスクリプション」）

| 項目 | 値 |
|---|---|
| 製品 ID | `teiyomi_premium_monthly`（作成済み・変えない） |
| 期間 / 価格 | 1か月 / ¥480 |
| 表示名（日本語） | 艇読みプレミアム |
| 説明（日本語） | 条件アラート・検証ノート・条件指定バックテストなど、すべての機能が使えます |
| 審査用スクリーンショット | teiyomi-ios `store/app-store/raw/05-purchase.png`（実機の購入画面。Sandbox の $2.99 のまま撮ったもの） |
| 審査メモ | 下の「審査メモ」と同じ内容でよい |

グループ・製品とも「提出準備完了」になっていること。**初めてのサブスクリプションはアプリのバージョンと一緒に
しか審査に出せない**ので、手順6でバージョンに添付する。
「契約／税金／口座情報」の有料 App 契約が有効であること（商品が実機で取れているので有効のはず）。

## 6. バージョン（「iOS App」→「1.0 提出準備中」）

| 項目 | 値 |
|---|---|
| スクリーンショット | teiyomi-ios `store/app-store/6.9/` の5枚（1320×2868）を **01→05 の順に**ドラッグ。Play 用の枠に iOS の画面をはめ込んだもの（作り方は同じフォルダの README） |
| プロモーションテキスト | 公式データを、読める形に。お気に入り選手の出走を毎朝お知らせします。 |
| 概要 | 下の「概要」 |
| キーワード（100字以内） | ボートレース,競艇,出走表,番組表,選手,モーター,データ,バックテスト,艇読み |
| サポート URL | https://teiyomi.com/support.html |
| マーケティング URL | https://teiyomi.com/ |
| 著作権 | 2026 MTP Works |
| ビルド | 手順1で上げたもの |
| App 内課金とサブスクリプション | 「＋」から `teiyomi_premium_monthly` を追加 |
| バージョンのリリース | `<手動／承認後に自動>`（初回は「手動でリリース」を推奨。公開の時刻を自分で選べる） |

### 概要

```
艇読みは、ボートレースの公式データを「自分で読む」ためのアプリです。予想印は出しません。見て、自分で決めるための道具です。

■ 無料でできること
・出走表を読みやすく整理（勝率・モーター2連対率・会場のコース傾向・スタートの傾向）
・お気に入り選手の本日の出走をまとめて表示、毎朝の出走通知（3名まで）
・選手図鑑（直近3年の成績・勝ち方）と二つ名殿堂
・固定メニューのバックテスト

■ 艇読みプレミアム（月額・自動更新）
・条件アラート：保存した条件に当てはまる出走がある朝だけお知らせ
・条件を指定してのバックテストと検証ノート
・選手のキャリアの全年表示と、勝ち方の詳しい内訳
・毎朝の出走通知をお気に入り全員に、データの見どころつきで

プレミアムは1か月ごとに自動更新されるサブスクリプションです。お支払いはお使いの Apple アカウントに請求され、期間終了の24時間前までに解約しない限り自動的に更新されます。解約は iPhone の「設定」→ ご自身の名前 →「サブスクリプション」から行えます。

利用規約：https://teiyomi.com/terms.html
プライバシーポリシー：https://teiyomi.com/privacy.html

舟券の購入は20歳になってから。のめり込みに注意し、余裕資金の範囲で楽しみましょう。
```

利用規約のリンクは概要に入れておく（Guideline 3.1.2 は、自動更新サブスクリプションの
利用規約へのリンクをメタデータにも求める）。

## 7. App Review に関する情報

| 項目 | 値 |
|---|---|
| サインインが必要 | ✅ |
| ユーザ名 | mtpworks.info+applereview@gmail.com |
| パスワード | `<「パスワード」アプリに保存した値>` |
| 連絡先 | `<氏名・電話番号>`・mtpworks.info@gmail.com |
| メモ | 下の「審査メモ」を貼る |

### 審査メモ（そのまま貼る）

```
Thank you for reviewing Teiyomi (艇読み).

WHAT THE APP IS
Teiyomi is a data viewer for Japanese public boat racing (BOAT RACE). It reorganizes the official race programs and results so that users can read races by themselves. The app does not sell betting tickets, does not accept wagers, and does not show predictions. The data source (the official BOAT RACE website) is credited as text only, without a link. The only external links are the Consumer Affairs Agency's page on gambling addiction (a Japanese government page), sharing to X, OpenAI's privacy policy, and Apple's subscription management page; each opens in Safari after a confirmation sheet. The in-app notice states that betting is limited to people aged 20 and over in Japan.

SIGN IN (demo account)
Regular users sign in with a 6-digit code sent by email. Because you cannot receive that email, the demo account has a password.
1. Tap the "マイページ" (My Page) tab at the bottom.
2. Tap "🔑 ログイン" (Log in).
3. Tap "パスワードでログイン" (Log in with password), below the email field.
4. Enter the email and password provided above, then tap "ログイン".

IN-APP PURCHASE (auto-renewable subscription)
Product: 艇読みプレミアム / teiyomi_premium_monthly / ¥480 per month.
The demo account has no subscription, so the purchase flow is available.
1. After signing in, on My Page tap "プレミアムを見る" (See Premium).
2. Tap "¥480 / 月で登録する" (Subscribe for ¥480/month) and complete the purchase with a Sandbox account.
3. Premium features unlock right away (for example "条件アラート" and "検証ノート" on My Page).
"以前の購入を復元する" restores purchases. "サブスクリプションを管理" opens Apple's subscription management page.

WHY SIGN-IN IS REQUIRED BEFORE PURCHASE (Guideline 5.1.1(v))
Premium is an account-based service. The subscription is attached to the user's account so that it works on all of the user's devices and on our website, and premium features are delivered from our server to that account: the daily push notifications are composed on the server according to the account's subscription, and saved alert conditions and backtest notes are stored on the server. All free features (race data, favorites, fixed backtests) are available without signing in.

PUSH NOTIFICATIONS
My Page → "🔔 出走のお知らせ" (Race notifications) → "オンにする" (Turn on). The permission prompt appears only when this button is tapped. Notifications are sent each morning for the user's favorite racers.

NATIVE iOS FEATURES
- Push notifications via APNs (also shown while the app is in the foreground)
- StoreKit purchase, restore, and subscription management
- Native tab bar, an offline screen, and a confirmation sheet before any external link is opened in Safari

AI REVIEW
The optional AI review feature sends the user's answer to OpenAI only after the user confirms what will be sent and agrees in the app.

ACCOUNT DELETION (Guideline 5.1.1(v))
My Page (signed in) → bottom of the page → "アカウントを削除する" (Delete account) → type "削除" → "アカウントを削除". If you test this with the demo account, it will be deleted; we will create a new one for future reviews.

CONTACT
mtpworks.info@gmail.com
```

## 7.5 WP-6（通知の受け口）の設定

提出の前に `apple-server-notifications.md` の手順を済ませる（App Store Server Notifications の URL・
Billing Grace Period の有効化・テスト通知）。Google Play 側の同じ穴（RTDN）は別 WP の候補として同じ文書に記載。

## 8. 提出

WP-6 と step5（TestFlight での通知・購入・ログイン直後の表示・削除の確認）が終わってから、
バージョンのページ右上「審査に追加」→「審査へ提出」。

## JAM が入力・判断するものだけの一覧

ほかの項目は、この文書の値をそのまま写せばよい。

| 画面 | 項目 | 中身 |
|---|---|---|
| App 情報 | 年齢区分の質問票 | 実際に質問に答える（方針は「年齢区分」の節） |
| App 情報 | カテゴリのセカンダリ | 任意（無しでよい） |
| バージョン | バージョンのリリース | 手動／承認後に自動 |
| バージョン | ビルド | TestFlight に上がった 1.0 (2) を選ぶ |
| サブスクリプション | 審査用スクリーンショット | `raw/05-purchase.png` でよいか（描き直す前の実物） |
| App Review に関する情報 | パスワード | 「パスワード」アプリに保存した審査用の値 |
| App Review に関する情報 | 連絡先（姓・名・電話番号） | 審査で連絡がつく人 |
| 契約／税金／口座情報 | 有料 App 契約 | 「有効」になっているかを見るだけ |

## 提出後のバックログ（提出を止めないもの）

| 項目 | 中身 | 見つけた経緯 |
|---|---|---|
| 匿名ユーザーの重複 | アプリを入れ直した直後、4つのタブが同時にページを読み、それぞれが匿名ログインを始めて匿名ユーザーが同時に複数できる（2026-09-13 22:59 に同じ秒で4人）。実害は使われない匿名ユーザーが増えるだけ。殻で最初のタブの読み込みを待ってから他を読む、または favorites.js で匿名ログインをタブ間で1本にする | step5 の DB 確認 |
| 猶予期間中に inactive へ戻る | 通知で猶予期間中（active・期限＝猶予の期限）にした行を、アプリの復元などで verify-purchase が走ると、Get Transaction Info の期限切れの答えで inactive に上書きしうる。自動の restore は有効な行では動かないので起きにくい。verify-purchase でも Get All Subscription Statuses を使う（apple-notifications の `stateFromSubscriptionStatuses` を共有）のが直し方 | WP-6 の security-review |
| Google Play 側の RTDN | Android も更新・解約・返金がアプリを開くまで反映されない。iOS と同じ形で塞げる（`apple-server-notifications.md` の末尾） | WP-6 の step0 |

## 却下されたときの予備案

- **5.1.1(v)「購入の前に登録を求めている」で却下されたら**：匿名のまま購入できるようにし（取引は匿名ユーザーの行に保存）、あとからメールでログインしたときに、その取引を本会員のアカウントへ紐づけ直す形に変える（step3 F2。verify-purchase の匿名拒否と、Sandbox 許可リストの扱いも合わせて見直す）。
- **審査員がアカウントを削除していたら**：審査用アカウントを作り直し、`node tools/set-review-password.mjs` でパスワードを入れ、新しい UID を `APPLE_SANDBOX_USER_IDS` に入れ直す。
