// verify-purchase の判断部分のテスト。
//   deno test supabase/functions/verify-purchase/logic_test.ts
//
// ここで守りたいのは1点だけ:「有効と答えるのは、有効だと確かめられたときだけ」。
// 分からない・読めない・欠けている、はすべて無効側に倒れること。
import { assertEquals, assertFalse } from 'jsr:@std/assert@^1'
import {
  CACHE_TTL_MS,
  canUseCache,
  isKnownProduct,
  isRowActive,
  parseSubscription,
  PRODUCT_IDS,
  secretsConfigured,
  tokenTakenByOther,
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
