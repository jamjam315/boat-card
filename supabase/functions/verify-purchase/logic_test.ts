// verify-purchase の判断部分のテスト。
//   deno test supabase/functions/verify-purchase/logic_test.ts
//
// ここで守りたいのは1点だけ:「有効と答えるのは、有効だと確かめられたときだけ」。
// 分からない・読めない・欠けている、はすべて無効側に倒れること。
import { assert, assertEquals, assertFalse } from 'jsr:@std/assert@^1'
import {
  APPLE_API_PRODUCTION,
  APPLE_API_SANDBOX,
  APPLE_TRANSACTION_NOT_FOUND,
  appleSecretsConfigured,
  CACHE_TTL_MS,
  canUseCache,
  entitlementFromAppleTransaction,
  type AppleTransaction,
  appleRowKey,
  appleSourceAllowed,
  appleTransactionMatches,
  fetchAppleTransaction,
  isAcceptableToken,
  isKnownProduct,
  isRowActive,
  looksLikeJws,
  MAX_APPLE_JWS_LENGTH,
  membershipRowKey,
  parsePlatform,
  parseSubscription,
  PRODUCT_IDS,
  secretsConfigured,
  sandboxAllowed,
  shouldRetryInSandbox,
  tokenTakenByOther,
  transactionIdFromJws,
} from './logic.ts'

const NOW = Date.parse('2026-08-20T12:00:00Z')
const HOUR = 3600 * 1000
const DAY = 24 * HOUR
const iso = (ms: number) => new Date(ms).toISOString()

// ---- 商品ID ----

Deno.test('商品IDは登録済みのものだけ通す', () => {
  assertEquals(isKnownProduct('teiyomi_premium_monthly'), true)
  assertFalse(isKnownProduct('teiyomi_premium_yearly'))   // まだ作っていない
  assertFalse(isKnownProduct('pro_monthly'))              // レジャー帳の商品
  assertFalse(isKnownProduct(''))
})

Deno.test('商品IDを増やすときは PRODUCT_IDS だけを直せばよい', () => {
  // 優待価格の別商品を足す将来を見越して、判定側は商品IDを知らない作りにしてある。
  assertEquals(PRODUCT_IDS.size, 1)
  assertEquals([...PRODUCT_IDS], ['teiyomi_premium_monthly'])
})

// ---- Googleの応答の読み取り ----

Deno.test('ACTIVE かつ期限が先なら有効', () => {
  const s = parseSubscription({
    subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
    lineItems: [{ expiryTime: iso(NOW + 30 * DAY) }],
  }, NOW)
  assertEquals(s.active, true)
  assertEquals(s.expiry, iso(NOW + 30 * DAY))
})

Deno.test('支払い再試行中(IN_GRACE_PERIOD)も有効', () => {
  const s = parseSubscription({
    subscriptionState: 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD',
    lineItems: [{ expiryTime: iso(NOW + DAY) }],
  }, NOW)
  assertEquals(s.active, true)
})

Deno.test('Googleが有効と言っていても、期限を過ぎていれば無効', () => {
  const s = parseSubscription({
    subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
    lineItems: [{ expiryTime: iso(NOW - 1000) }],
  }, NOW)
  assertFalse(s.active)
})

Deno.test('解約済み・保留・期限切れ・知らない状態はすべて無効', () => {
  for (
    const st of [
      'SUBSCRIPTION_STATE_CANCELED',
      'SUBSCRIPTION_STATE_ON_HOLD',
      'SUBSCRIPTION_STATE_EXPIRED',
      'SUBSCRIPTION_STATE_PAUSED',
      'SUBSCRIPTION_STATE_UNSPECIFIED',
      'なにか未知の値',
    ]
  ) {
    const s = parseSubscription({
      subscriptionState: st,
      lineItems: [{ expiryTime: iso(NOW + 30 * DAY) }],
    }, NOW)
    assertFalse(s.active, st + ' が有効になってしまっている')
  }
})

Deno.test('応答が壊れていても落ちず、無効を返す', () => {
  for (const bad of [null, undefined, {}, [], 'ok', 42, { lineItems: 'x' }]) {
    const s = parseSubscription(bad, NOW)
    assertFalse(s.active)
    assertEquals(s.expiry, null)
  }
})

Deno.test('読めない期限は無効に倒す', () => {
  const s = parseSubscription({
    subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
    lineItems: [{ expiryTime: 'こわれた日付' }],
  }, NOW)
  assertFalse(s.active)
})

Deno.test('lineItemsが無ければトップレベルのexpiryTimeを見る', () => {
  const s = parseSubscription({
    subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
    expiryTime: iso(NOW + DAY),
  }, NOW)
  assertEquals(s.active, true)
  assertEquals(s.expiry, iso(NOW + DAY))
})

Deno.test('acknowledgeが必要かどうかを読む(3日ルール)', () => {
  const pending = parseSubscription({
    subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
    acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
    lineItems: [{ expiryTime: iso(NOW + DAY) }],
  }, NOW)
  assertEquals(pending.needsAcknowledge, true)

  const done = parseSubscription({
    subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
    acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
    lineItems: [{ expiryTime: iso(NOW + DAY) }],
  }, NOW)
  assertFalse(done.needsAcknowledge)

  // 状態が読めないときは「済んでいない」とは断定しない(二重に叩かない)。
  assertFalse(parseSubscription({}, NOW).needsAcknowledge)
})

// ---- キャッシュ ----

Deno.test('新しい検証結果は使い回す(Googleへの問い合わせ回数の上限も兼ねる)', () => {
  assertEquals(canUseCache({ updated_at: iso(NOW - HOUR) }, NOW), true)
  assertEquals(canUseCache({ updated_at: iso(NOW - CACHE_TTL_MS + 1000) }, NOW), true)
})

Deno.test('古い・無い・壊れている・未来の記録はキャッシュとして使わない', () => {
  assertFalse(canUseCache({ updated_at: iso(NOW - CACHE_TTL_MS - 1000) }, NOW))
  assertFalse(canUseCache(null, NOW))
  assertFalse(canUseCache({}, NOW))
  assertFalse(canUseCache({ updated_at: 'こわれた日付' }, NOW))
  assertFalse(canUseCache({ updated_at: iso(NOW + HOUR) }, NOW))
})

Deno.test('期限を過ぎた記録はキャッシュとして使わない(更新日の締め出しを防ぐ)', () => {
  // **購読は更新されてもトークンが変わらない。** 期限切れの記録を返し続けると、
  // ストア側では更新済みなのに最大24時間「無効」と答える＝毎月の更新日に
  // 払っている人が締め出される(レジャー帳で2026-08-11に実際に起きた)。
  assertFalse(canUseCache(
    { updated_at: iso(NOW - HOUR), current_period_end: iso(NOW - 1000) },
    NOW,
  ))
  // ちょうど期限のときも聞き直す(境界)。
  assertFalse(canUseCache(
    { updated_at: iso(NOW - HOUR), current_period_end: iso(NOW) },
    NOW,
  ))
  // 期限が先ならこれまでどおり使い回す。
  assertEquals(canUseCache(
    { updated_at: iso(NOW - HOUR), current_period_end: iso(NOW + DAY) },
    NOW,
  ), true)
  // 期限の記録が無い行は従来どおり(判断材料が無いだけ)。
  assertEquals(canUseCache({ updated_at: iso(NOW - HOUR) }, NOW), true)
  // 読めない日付は判断材料にならないので聞き直す。
  assertFalse(canUseCache(
    { updated_at: iso(NOW - HOUR), current_period_end: 'いつか' },
    NOW,
  ))
})

Deno.test('この条件が緩む方向には働かない(無効を有効に変えない)', () => {
  // canUseCache が false になっても、起きるのは「ストアに聞き直す」だけ。
  // 有効かどうかを決めるのは isRowActive とストアの答えのほう。
  assertFalse(isRowActive({ status: 'active', current_period_end: iso(NOW - 1) }, NOW))
})

// ---- 保存済みの行から見た有効性(4か所と同じ条件) ----

Deno.test('保存済みの行の判定は membership.js / is_premium() と同じ', () => {
  assertEquals(isRowActive({ status: 'active', current_period_end: iso(NOW + DAY) }, NOW), true)
  assertEquals(isRowActive({ status: 'trialing', current_period_end: iso(NOW + DAY) }, NOW), true)
  assertEquals(isRowActive({ status: 'active', current_period_end: null }, NOW), true)
  assertFalse(isRowActive({ status: 'active', current_period_end: iso(NOW - 1000) }, NOW))
  assertFalse(isRowActive({ status: 'inactive', current_period_end: iso(NOW + DAY) }, NOW))
  assertFalse(isRowActive({ status: 'canceled', current_period_end: iso(NOW + DAY) }, NOW))
  assertFalse(isRowActive(null, NOW))
  assertFalse(isRowActive({}, NOW))
})

// ---- 使い回しの防止 ----

Deno.test('他人が使っているトークンは弾く', () => {
  const rows = [{ user_id: 'ほかの人', purchase_token: 't' }]
  assertEquals(tokenTakenByOther(rows, 'わたし'), true)
})

Deno.test('自分のトークンなら通す(再検証・更新のたびに呼ばれるため)', () => {
  const rows = [{ user_id: 'わたし', purchase_token: 't' }]
  assertFalse(tokenTakenByOther(rows, 'わたし'))
  assertFalse(tokenTakenByOther([], 'わたし'))
  assertFalse(tokenTakenByOther(null, 'わたし'))
})

// ---- Secretsの有無(いちばん大事な分岐) ----

Deno.test('Secretsが揃っていなければ検証できない＝無効に倒す', () => {
  // 今の本番はこの状態。GOOGLE_PLAY_SA_KEY を入れるまで誰もプレミアムにならない。
  assertFalse(secretsConfigured(undefined, undefined))
  assertFalse(secretsConfigured(undefined, 'com.mtpworks.teiyomi'))
  assertFalse(secretsConfigured('{"private_key":"..."}', undefined))
  // 空文字も未設定と同じ(secrets set で空を入れた事故を通さない)
  assertFalse(secretsConfigured('', 'com.mtpworks.teiyomi'))
  assertFalse(secretsConfigured('{"private_key":"..."}', ''))
  // 両方あって初めて先へ進む
  assertEquals(secretsConfigured('{"private_key":"..."}', 'com.mtpworks.teiyomi'), true)
})

// ===========================================================================
// iOS(App Store Server API)
//
// ここでも守りたいことは1つ:「有効と答えるのは、Appleが有効だと答えたときだけ」。
// ===========================================================================

/** テスト用のJWSを組み立てる(署名は検証しないので中身は何でもよい)。 */
const b64url = (s: string) =>
  btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const jws = (payload: Record<string, unknown>) =>
  b64url('{"alg":"ES256"}') + '.' + b64url(JSON.stringify(payload)) + '.' + b64url('sig')

const BUNDLE_ID = 'com.mtpworks.teiyomi'
const PRODUCT_ID = 'teiyomi_premium_monthly'

// ---- どのストアの話か ----

Deno.test('platform: 未指定はandroid(出回っているbilling.jsは送らない)', () => {
  assertEquals(parsePlatform(undefined), 'android')
  assertEquals(parsePlatform(null), 'android')
  assertEquals(parsePlatform('android'), 'android')
})

Deno.test('platform: iosはios', () => {
  assertEquals(parsePlatform('ios'), 'ios')
})

Deno.test('platform: 知らない値はandroidに倒さず拒否する', () => {
  // ここをandroidに倒すと、新しいiOSクライアントの綴り違い1つで
  // AppleのJWSがGoogleへ飛ぶ。判断できないものは拒否(フェイルクローズ)。
  assertEquals(parsePlatform('web'), null)
  assertEquals(parsePlatform('iOS'), null)
  assertEquals(parsePlatform('IOS'), null)
  assertEquals(parsePlatform(''), null)
  assertEquals(parsePlatform(123), null)
  assertEquals(parsePlatform({}), null)
})

// ---- 証跡の形(ストアの取り違えを入口で止める) ----

Deno.test('PlayのトークンはiOS経路に流れない', () => {
  // 実物のPlayトークンはドットを含まない不透明な文字列。
  const playToken = 'abcdefghijklmnop.AO-J1Ox' + 'y'.repeat(100)
  assertFalse(isAcceptableToken(playToken, 'ios'))
  assertEquals(isAcceptableToken(playToken, 'android'), true)
})

Deno.test('AppleのJWSはPlay経路の上限(4096)を超えても通る', () => {
  // x5c(証明書3枚)を含むので実測5〜8KB。4096で共通にしていると入口で弾かれる。
  const big = jws({ transactionId: '1', originalTransactionId: '1' }) +
    ''.padEnd(0, '')
  const padded = big.split('.')[0] + '.' + big.split('.')[1] + '.' +
    'A'.repeat(6000)
  assert(padded.length > 4096)
  assertEquals(isAcceptableToken(padded, 'ios'), true)
  // Play経路では長すぎて弾かれる(同じ上限で受けていない証拠)。
  assertFalse(isAcceptableToken(padded, 'android'))
})

Deno.test('JWSの形をしていないものはiOS経路で弾く', () => {
  assertFalse(looksLikeJws(''))
  assertFalse(looksLikeJws('aaa.bbb'))          // 2パート
  assertFalse(looksLikeJws('aaa.bbb.ccc.ddd'))  // 4パート
  assertFalse(looksLikeJws('aaa..ccc'))         // 空のパート
  assertFalse(looksLikeJws('aaa.b+b.ccc'))      // base64urlに無い文字
  assertFalse(looksLikeJws('aaa.b/b.ccc'))
  assertFalse(looksLikeJws('aaa.b=b.ccc'))
  assertEquals(looksLikeJws('aaa.bbb.ccc'), true)
  assertEquals(looksLikeJws('a-a.b_b.c0c'), true)
})

Deno.test('JWSにも上限はある(長い入力を握らせない)', () => {
  const ok = 'a.b.' + 'c'.repeat(MAX_APPLE_JWS_LENGTH - 4)
  assertEquals(ok.length, MAX_APPLE_JWS_LENGTH)
  assertEquals(looksLikeJws(ok), true)
  assertFalse(looksLikeJws(ok + 'c'))
})

// ---- 本番とSandboxの切り替え ----

Deno.test('本番に無い(404+4040010)ならSandboxへ問い直す', () => {
  assertEquals(
    shouldRetryInSandbox(404, { errorCode: APPLE_TRANSACTION_NOT_FOUND }, true),
    true,
  )
})

Deno.test('本番401でもSandboxへ問い直す(公開前は本番が401を返す)', () => {
  // これが無いと、App Storeで公開されるまでiOSの購入を一度も検証できない。
  // 401は「無効」ではなく「答えを聞けていない」。有効/無効の判断は
  // entitlementFromAppleTransaction が応答の中身を見て下す。
  assertEquals(shouldRetryInSandbox(401, null, true), true)
})

Deno.test('それ以外はSandboxへ回さない(二重に叩くだけで結果が変わらない)', () => {
  assertFalse(shouldRetryInSandbox(404, { errorCode: 4040005 }, true))
  assertFalse(shouldRetryInSandbox(404, null, true))
  assertFalse(shouldRetryInSandbox(500, null, true))
  assertFalse(shouldRetryInSandbox(503, null, true))
  assertFalse(shouldRetryInSandbox(400, null, true))
})

/** fetchAppleTransaction に渡す偽の応答。 */
const reply = (status: number, body: unknown = null) => ({
  ok: status >= 200 && status < 300,
  status,
  json: () => Promise.resolve(body),
})

Deno.test('本番が答えたらSandboxは叩かない(全利用者の1往復を無駄にしない)', async () => {
  const called: string[] = []
  const r = await fetchAppleTransaction((base) => {
    called.push(base)
    return Promise.resolve(reply(200, { signedTransactionInfo: 'x' }))
  }, { allowSandbox: true })
  assertEquals(called, [APPLE_API_PRODUCTION])
  assertEquals(r.productionStatus, 200)
  assertEquals(r.sandboxStatus, null)
  assertEquals(r.trace, 'production=200 sandbox=-')
})

Deno.test('本番401→Sandbox200で成功する(公開前の経路)', async () => {
  const called: string[] = []
  const r = await fetchAppleTransaction((base) => {
    called.push(base)
    return Promise.resolve(
      base === APPLE_API_PRODUCTION
        ? reply(401)
        : reply(200, { signedTransactionInfo: 'x' }),
    )
  }, { allowSandbox: true })
  assertEquals(called, [APPLE_API_PRODUCTION, APPLE_API_SANDBOX])
  assertEquals(r.res.status, 200)
  assertEquals(r.res.ok, true)
  // **両方のステータスが1行に残ること。** 片方だと切り分けができない。
  assertEquals(r.trace, 'production=401 sandbox=200')
})

Deno.test('本番404(4040010)→Sandboxへ回る(審査員のSandbox購入)', async () => {
  const called: string[] = []
  const r = await fetchAppleTransaction((base) => {
    called.push(base)
    return Promise.resolve(
      base === APPLE_API_PRODUCTION
        ? reply(404, { errorCode: APPLE_TRANSACTION_NOT_FOUND })
        : reply(200, { signedTransactionInfo: 'x' }),
    )
  }, { allowSandbox: true })
  assertEquals(called.length, 2)
  assertEquals(r.trace, 'production=404 sandbox=200')
})

Deno.test('本番5xxではSandboxへ回らない', async () => {
  const called: string[] = []
  const r = await fetchAppleTransaction((base) => {
    called.push(base)
    return Promise.resolve(reply(500))
  }, { allowSandbox: true })
  assertEquals(called, [APPLE_API_PRODUCTION])
  assertEquals(r.res.ok, false)
  assertEquals(r.trace, 'production=500 sandbox=-')
})

Deno.test('本番の本文が読めなくても判断は続く(404の本文欠落で落ちない)', async () => {
  const r = await fetchAppleTransaction((base) =>
    Promise.resolve(
      base === APPLE_API_PRODUCTION
        ? { ok: false, status: 404, json: () => Promise.reject(new Error('empty')) }
        : reply(200),
    ), { allowSandbox: true })
  // 404で本文が読めなければ 4040010 とは確認できない＝回さない。
  assertEquals(r.trace, 'production=404 sandbox=-')
})

// ---- Appleの答えの読み取り(4条件すべて) ----

const okTx = (over: Record<string, unknown> = {}) => ({
  bundleId: BUNDLE_ID,
  productId: PRODUCT_ID,
  expiresDate: NOW + 30 * DAY,
  ...over,
})
const opts = { expectedProductId: PRODUCT_ID, expectedBundleId: BUNDLE_ID, now: NOW }

Deno.test('4条件すべて満たせば有効', () => {
  const v = entitlementFromAppleTransaction(okTx(), opts)
  assertEquals(v.isActive, true)
  assertEquals(v.reason, 'ok')
  assertEquals(v.expiry, iso(NOW + 30 * DAY))
})

Deno.test('他アプリの購入では権利を主張できない(bundleId不一致)', () => {
  const v = entitlementFromAppleTransaction(
    okTx({ bundleId: 'com.leisurecho.app' }),
    opts,
  )
  assertFalse(v.isActive)
  assertEquals(v.reason, 'bundle mismatch')
  // 期限は返さない(不一致の取引の中身を手がかりにさせない)。
  assertEquals(v.expiry, null)
})

Deno.test('bundleIdが無い応答も無効', () => {
  assertFalse(entitlementFromAppleTransaction(okTx({ bundleId: undefined }), opts).isActive)
})

Deno.test('別の商品を買って権利を主張できない(productId不一致)', () => {
  const v = entitlementFromAppleTransaction(
    okTx({ productId: 'teiyomi_premium_yearly' }),
    opts,
  )
  assertFalse(v.isActive)
  assertEquals(v.reason, 'product mismatch')
})

Deno.test('返金・取り消し済みは無効(revocationDate)', () => {
  const v = entitlementFromAppleTransaction(
    okTx({ revocationDate: NOW - DAY }),
    opts,
  )
  assertFalse(v.isActive)
  assertEquals(v.reason, 'revoked')
})

Deno.test('期限が無いもの(買い切り・消耗型)は購読ではないので無効', () => {
  const v = entitlementFromAppleTransaction(okTx({ expiresDate: undefined }), opts)
  assertFalse(v.isActive)
  assertEquals(v.reason, 'no expiry')
})

Deno.test('期限を過ぎていれば無効', () => {
  const v = entitlementFromAppleTransaction(okTx({ expiresDate: NOW - 1000 }), opts)
  assertFalse(v.isActive)
  assertEquals(v.reason, 'expired')
  // ここは期限を返す(自分の購読が切れたことは本人に分かってよい)。
  assertEquals(v.expiry, iso(NOW - 1000))
})

Deno.test('期限ちょうどは無効(境界)', () => {
  assertFalse(entitlementFromAppleTransaction(okTx({ expiresDate: NOW }), opts).isActive)
})

// ---- 行の鍵(ここを間違えるとキャッシュも使い回し検出も効かない) ----

Deno.test('Androidの鍵はトークンそのもの(更新しても変わらない)', () => {
  assertEquals(membershipRowKey('play-token-123', 'android'), 'play-token-123')
  assertEquals(membershipRowKey('', 'android'), null)
})

Deno.test('iOSの鍵は originalTransactionId(更新をまたいで変わらない)', () => {
  const token = jws({ transactionId: '2000000999', originalTransactionId: '2000000111' })
  // **transactionId ではない。** あちらは更新のたびに変わるので、鍵にすると
  // 毎月「別人のトークン」になり、一意索引による使い回し検出が意味を失う。
  assertEquals(membershipRowKey(token, 'ios'), '2000000111')
})

Deno.test('originalTransactionId が無ければ transactionId に落とす', () => {
  assertEquals(membershipRowKey(jws({ transactionId: '2000000999' }), 'ios'), '2000000999')
})

Deno.test('IDが読めないJWSは鍵にできない(無効に倒す)', () => {
  assertEquals(membershipRowKey(jws({}), 'ios'), null)
  assertEquals(membershipRowKey(jws({ originalTransactionId: '' }), 'ios'), null)
  assertEquals(membershipRowKey(jws({ originalTransactionId: 12345 }), 'ios'), null)
  assertEquals(membershipRowKey('not.a.jws', 'ios'), null)
  assertEquals(membershipRowKey('aaa', 'ios'), null)
})

Deno.test('Appleに問い合わせるIDは transactionId(鍵とは別物)', () => {
  const token = jws({ transactionId: '2000000999', originalTransactionId: '2000000111' })
  // originalTransactionId を投げると初回期間の expiresDate が返り、
  // 有効な購読者が expired で締め出される。
  assertEquals(transactionIdFromJws(token), '2000000999')
  assertEquals(membershipRowKey(token, 'ios'), '2000000111')
  assertEquals(transactionIdFromJws('not.a.jws'), null)
})

// ---- Secretsの有無(いちばん大事な分岐・iOS側) ----

Deno.test('APPLE_* が揃っていなければ検証できない＝無効に倒す', () => {
  // キー登録前の本番はこの状態。iOSでは誰もプレミアムにならない。
  assertFalse(appleSecretsConfigured(undefined, undefined, undefined, undefined))
  assertFalse(appleSecretsConfigured('KID', 'ISS', 'PEM', undefined))
  assertFalse(appleSecretsConfigured('KID', 'ISS', undefined, BUNDLE_ID))
  assertFalse(appleSecretsConfigured('KID', undefined, 'PEM', BUNDLE_ID))
  assertFalse(appleSecretsConfigured(undefined, 'ISS', 'PEM', BUNDLE_ID))
  // 空文字も未設定と同じ(secrets set で空を入れた事故を通さない)
  assertFalse(appleSecretsConfigured('', 'ISS', 'PEM', BUNDLE_ID))
  assertFalse(appleSecretsConfigured('KID', 'ISS', '', BUNDLE_ID))
  // 4つ揃って初めて先へ進む
  assertEquals(appleSecretsConfigured('KID', 'ISS', 'PEM', BUNDLE_ID), true)
})

// ---- iOSの行でも会員判定はそのまま効く ----

Deno.test('iOSで書いた行でも is_premium() と同じ条件で有効になる', () => {
  // platform 列は「あとから見分けるため」だけの記録で、判定には使われない。
  // is_premium() / membership.js / send-morning-push / send-test-push の4か所は
  // status と current_period_end しか見ないので、iOSの行にも変更は要らない。
  const iosRow = {
    status: 'active',
    price_id: PRODUCT_ID,
    current_period_end: iso(NOW + 30 * DAY),
    purchase_token: '2000000111',
  }
  assertEquals(isRowActive(iosRow, NOW), true)
  assertFalse(isRowActive({ ...iosRow, current_period_end: iso(NOW - 1000) }, NOW))
  assertFalse(isRowActive({ ...iosRow, status: 'inactive' }, NOW))
})

Deno.test('使い回しの検出は鍵の形に依らない(iOSの鍵でも効く)', () => {
  const rows = [{ user_id: 'ほかの人', purchase_token: '2000000111' }]
  assertEquals(tokenTakenByOther(rows, 'わたし'), true)
})

// ===========================================================================
// WP-3f: セキュリティ点検(2026-09-11)で見つかった穴を塞ぐ
// ===========================================================================

// ---- Vuln 1: 行の鍵はAppleの答えから作る ----

Deno.test('行の鍵はAppleの originalTransactionId', () => {
  assertEquals(
    appleRowKey({ transactionId: '2000000999', originalTransactionId: '2000000111' }),
    '2000000111',
  )
})

Deno.test('originalTransactionId が無ければ transactionId に落とす', () => {
  assertEquals(appleRowKey({ transactionId: '2000000999' }), '2000000999')
})

Deno.test('Appleの答えにIDが無ければ鍵にできない(無効に倒す)', () => {
  assertEquals(appleRowKey({}), null)
  assertEquals(appleRowKey({ originalTransactionId: '' }), null)
  // 型の外から来た値(応答は Record<string, unknown> のまま渡される)。
  assertEquals(appleRowKey({ originalTransactionId: 12345 } as unknown as AppleTransaction), null)
})

Deno.test('偽造ペイロードの鍵は採用されない(Vuln 1)', () => {
  // 攻撃者のJWS: transactionId は本物、originalTransactionId だけ任意の値。
  const forged = jws({
    transactionId: '2000000999',
    originalTransactionId: 'ATTACKER-RANDOM-1',
  })
  // 入口の下見はその偽の値を拾う（ここは早期409のためだけ）。
  assertEquals(membershipRowKey(forged, 'ios'), 'ATTACKER-RANDOM-1')

  // **Appleが答えた取引から作る鍵は、本物の originalTransactionId。**
  // 攻撃者が毎回違う鍵で行を作ることはできない＝使い回しの検出が効く。
  const fromApple = appleRowKey({
    transactionId: '2000000999',
    originalTransactionId: '2000000111',
  })
  assertEquals(fromApple, '2000000111')
  assertFalse(fromApple === 'ATTACKER-RANDOM-1')

  // 同じ本物の取引を何度使い回しても鍵は変わらないので、
  // 2人目以降は tokenTakenByOther で止まる。
  const rows = [{ user_id: 'さきに登録した人', purchase_token: fromApple }]
  assertEquals(tokenTakenByOther(rows, 'あとから来た人'), true)
})

// ---- Vuln 1: 聞いた取引と答えた取引の一致 ----

Deno.test('Appleが答えたのが、こちらの聞いた取引であること', () => {
  assertEquals(appleTransactionMatches({ transactionId: '2000000999' }, '2000000999'), true)
})

Deno.test('IDが違う・入っていない応答は採用しない', () => {
  assertFalse(appleTransactionMatches({ transactionId: '2000000111' }, '2000000999'))
  assertFalse(appleTransactionMatches({}, '2000000999'))
  assertFalse(appleTransactionMatches({ transactionId: '' }, ''))
  assertFalse(
    appleTransactionMatches(
      { transactionId: 2000000999 } as unknown as AppleTransaction,
      '2000000999',
    ),
  )
})

// ---- Vuln 2: Sandbox の許可制 ----

Deno.test('Sandboxを許すのは "true" のときだけ', () => {
  assertEquals(sandboxAllowed('true'), true)
  // 設定を忘れたら「本番だけを見る」に倒れる。
  assertFalse(sandboxAllowed(undefined))
  assertFalse(sandboxAllowed(null))
  assertFalse(sandboxAllowed(''))
  assertFalse(sandboxAllowed('false'))
  assertFalse(sandboxAllowed('TRUE'))
  assertFalse(sandboxAllowed('1'))
  assertFalse(sandboxAllowed('yes'))
})

Deno.test('許可されていなければ、そもそもSandboxへ問い直さない', () => {
  assertFalse(shouldRetryInSandbox(404, { errorCode: APPLE_TRANSACTION_NOT_FOUND }, false))
  assertFalse(shouldRetryInSandbox(401, null, false))
})

Deno.test('許可されていなければ、本番で止まる(Sandboxを叩かない)', async () => {
  const called: string[] = []
  const r = await fetchAppleTransaction((base) => {
    called.push(base)
    return Promise.resolve(reply(404, { errorCode: APPLE_TRANSACTION_NOT_FOUND }))
  }, { allowSandbox: false })

  assertEquals(called, [APPLE_API_PRODUCTION])
  assertEquals(r.sandboxStatus, null)
  assertEquals(r.res.ok, false)
})

Deno.test('Sandboxが答えた取引は、許可が無ければ権利にしない', () => {
  const v = appleSourceAllowed({ environment: 'Sandbox' }, {
    fromSandbox: true,
    allowSandbox: false,
  })
  assertFalse(v.ok)
  assertEquals(v.reason, 'sandbox response not allowed')
})

Deno.test('本番のエンドポイントが答えても、取引がSandboxなら権利にしない', () => {
  // 二重の守りの2枚目。エンドポイントだけ見ていると取りこぼす形。
  const v = appleSourceAllowed({ environment: 'Sandbox' }, {
    fromSandbox: false,
    allowSandbox: false,
  })
  assertFalse(v.ok)
  assertEquals(v.reason, 'sandbox transaction not allowed')
})

Deno.test('許可されていればSandboxでも通る(審査・公開前)', () => {
  assertEquals(
    appleSourceAllowed({ environment: 'Sandbox' }, { fromSandbox: true, allowSandbox: true }).ok,
    true,
  )
})

Deno.test('本番の取引はそのまま通る', () => {
  assertEquals(
    appleSourceAllowed({ environment: 'Production' }, {
      fromSandbox: false,
      allowSandbox: false,
    }).ok,
    true,
  )
  // environment が入っていない応答は、エンドポイントのほうで決める。
  assertEquals(
    appleSourceAllowed({}, { fromSandbox: false, allowSandbox: false }).ok,
    true,
  )
})
