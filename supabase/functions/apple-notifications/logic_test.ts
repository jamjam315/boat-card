// apple-notifications の判定部分のテスト(WP-6)。
//   deno test --no-check supabase/
import { assertEquals, assertFalse } from 'jsr:@std/assert@1'
import {
  APPLE_STATUS,
  cooldownSince,
  RECHECK_COOLDOWN_SECONDS,
  testRecordKey,
  APPLE_SUBSCRIPTIONS_PRODUCTION,
  APPLE_SUBSCRIPTIONS_SANDBOX,
  decodeJwsPayload,
  NOTIFICATION_RETENTION_DAYS,
  parseNotification,
  retentionCutoff,
  stateFromSubscriptionStatuses,
  subscriptionsBase,
} from './logic.ts'

const BUNDLE = 'com.mtpworks.teiyomi'
const PRODUCT = 'teiyomi_premium_monthly'
const OTX = '2000000123456789'
const NOW = Date.parse('2026-09-13T12:00:00Z')
const DAY = 24 * 3600 * 1000

/** 署名は見ないので、形だけの JWS を作る。 */
function jws(payload: unknown): string {
  const b64url = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return b64url(JSON.stringify({ alg: 'ES256' })) + '.' +
    b64url(unescape(encodeURIComponent(JSON.stringify(payload)))) + '.sig'
}

function notification(over: Record<string, unknown> = {}, data: Record<string, unknown> = {}) {
  return {
    signedPayload: jws({
      notificationType: 'DID_RENEW',
      subtype: null,
      notificationUUID: '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b',
      data: {
        bundleId: BUNDLE,
        environment: 'Production',
        signedTransactionInfo: jws({ originalTransactionId: OTX, transactionId: '2000000999', productId: PRODUCT }),
        ...data,
      },
      ...over,
    }),
  }
}

function tx(over: Record<string, unknown> = {}) {
  return jws({
    originalTransactionId: OTX,
    transactionId: '2000000999',
    bundleId: BUNDLE,
    productId: PRODUCT,
    expiresDate: NOW + 20 * DAY,
    ...over,
  })
}

function statuses(status: number, txOver: Record<string, unknown> = {}, renewal?: Record<string, unknown>) {
  return {
    bundleId: BUNDLE,
    environment: 'Production',
    data: [{
      subscriptionGroupIdentifier: '21000000',
      lastTransactions: [{
        originalTransactionId: OTX,
        status,
        signedTransactionInfo: tx(txOver),
        ...(renewal ? { signedRenewalInfo: jws(renewal) } : {}),
      }],
    }],
  }
}

const opts = { originalTransactionId: OTX, expectedBundleId: BUNDLE, now: NOW }

// ---- 通知を読む ----

Deno.test('通知から「どの購読か」と種類・環境を読む', () => {
  const n = parseNotification(notification())
  assertEquals(n?.notificationType, 'DID_RENEW')
  assertEquals(n?.environment, 'Production')
  assertEquals(n?.bundleId, BUNDLE)
  assertEquals(n?.originalTransactionId, OTX)
  assertEquals(n?.notificationUUID, '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b')
})

Deno.test('取引情報が無ければ更新情報から originalTransactionId を取る', () => {
  const n = parseNotification(notification({}, {
    signedTransactionInfo: undefined,
    signedRenewalInfo: jws({ originalTransactionId: OTX }),
  }))
  assertEquals(n?.originalTransactionId, OTX)
})

Deno.test('Sandbox の通知を見分ける', () => {
  assertEquals(parseNotification(notification({}, { environment: 'Sandbox' }))?.environment, 'Sandbox')
})

Deno.test('TEST 通知は取引が無くても読める', () => {
  const n = parseNotification({
    signedPayload: jws({
      notificationType: 'TEST',
      notificationUUID: '11111111-2222-3333-4444-555555555555',
      data: { bundleId: BUNDLE, environment: 'Sandbox' },
    }),
  })
  assertEquals(n?.notificationType, 'TEST')
  assertEquals(n?.originalTransactionId, null)
  assertEquals(n?.environment, 'Sandbox')
})

Deno.test('形の違う本文は通知として扱わない', () => {
  assertEquals(parseNotification(null), null)
  assertEquals(parseNotification({}), null)
  assertEquals(parseNotification({ signedPayload: 'not-a-jws' }), null)
  assertEquals(parseNotification({ signedPayload: jws({ notificationType: 'DID_RENEW' }) }), null, 'UUID が無い')
  assertEquals(
    parseNotification({ signedPayload: jws({ notificationType: 'DID_RENEW', notificationUUID: 'x' }) }),
    null,
    'UUID の形でない',
  )
  assertEquals(parseNotification({ signedPayload: jws({ notificationUUID: '11111111-2222-3333-4444-555555555555' }) }), null)
})

Deno.test('originalTransactionId が数字の形でなければ使わない(問い合わせ先の URL に入れるため)', () => {
  const n = parseNotification(notification({}, {
    signedTransactionInfo: jws({ originalTransactionId: '../../evil' }),
  }))
  assertEquals(n?.originalTransactionId, null)
})

Deno.test('JWS でないもの・配列は読まない', () => {
  assertEquals(decodeJwsPayload(42), null)
  assertEquals(decodeJwsPayload('a.b'), null)
  assertEquals(decodeJwsPayload(jws([1, 2])), null)
})

Deno.test('問い合わせ先は通知の環境で決める', () => {
  assertEquals(subscriptionsBase('Production'), APPLE_SUBSCRIPTIONS_PRODUCTION)
  assertEquals(subscriptionsBase('Sandbox'), APPLE_SUBSCRIPTIONS_SANDBOX)
})

// ---- Apple の答えから状態を決める ----

Deno.test('有効(1): active・期限は取引の expiresDate', () => {
  const r = stateFromSubscriptionStatuses(statuses(APPLE_STATUS.ACTIVE), opts)
  assertEquals(r, {
    kind: 'update',
    update: { status: 'active', currentPeriodEnd: new Date(NOW + 20 * DAY).toISOString(), reason: 'active' },
  })
})

Deno.test('有効(1)でも返金済みの取引なら inactive', () => {
  const r = stateFromSubscriptionStatuses(statuses(APPLE_STATUS.ACTIVE, { revocationDate: NOW - DAY }), opts)
  assertEquals(r.kind, 'update')
  if (r.kind === 'update') assertEquals(r.update.status, 'inactive')
})

Deno.test('猶予期間(4): 猶予の期限まで active(Billing Grace Period 有効)', () => {
  const grace = NOW + 10 * DAY
  const r = stateFromSubscriptionStatuses(
    statuses(APPLE_STATUS.GRACE_PERIOD, { expiresDate: NOW - DAY }, { gracePeriodExpiresDate: grace }),
    opts,
  )
  assertEquals(r, {
    kind: 'update',
    update: { status: 'active', currentPeriodEnd: new Date(grace).toISOString(), reason: 'grace period' },
  })
})

Deno.test('猶予期間(4)でも、猶予の期限を過ぎていれば inactive', () => {
  const r = stateFromSubscriptionStatuses(
    statuses(APPLE_STATUS.GRACE_PERIOD, { expiresDate: NOW - 20 * DAY }, { gracePeriodExpiresDate: NOW - DAY }),
    opts,
  )
  assertEquals(r.kind, 'update')
  if (r.kind === 'update') assertEquals(r.update.status, 'inactive')
})

Deno.test('期限切れ(2)・支払い再試行中(3)・取り消し(5)は inactive', () => {
  for (const s of [APPLE_STATUS.EXPIRED, APPLE_STATUS.BILLING_RETRY, APPLE_STATUS.REVOKED]) {
    const r = stateFromSubscriptionStatuses(statuses(s, { expiresDate: NOW - DAY }), opts)
    assertEquals(r.kind, 'update', String(s))
    if (r.kind === 'update') assertEquals(r.update.status, 'inactive', String(s))
  }
})

Deno.test('取り消し(5)は期限も消す', () => {
  const r = stateFromSubscriptionStatuses(statuses(APPLE_STATUS.REVOKED), opts)
  if (r.kind === 'update') assertEquals(r.update.currentPeriodEnd, null)
})

Deno.test('他のアプリ・知らない商品の取引なら行に触らない', () => {
  assertEquals(stateFromSubscriptionStatuses({ ...statuses(1), bundleId: 'com.other' }, opts).kind, 'ignore')
  assertEquals(stateFromSubscriptionStatuses(statuses(1, { bundleId: 'com.other' }), opts).kind, 'ignore')
  assertEquals(stateFromSubscriptionStatuses(statuses(1, { productId: 'other_product' }), opts).kind, 'ignore')
})

Deno.test('答えにその購読が無ければ not_found', () => {
  const r = stateFromSubscriptionStatuses(statuses(1), { ...opts, originalTransactionId: '2000000000000001' })
  assertEquals(r.kind, 'not_found')
})

Deno.test('知らない status・読めない答えは行に触らない', () => {
  assertEquals(stateFromSubscriptionStatuses(statuses(9), opts).kind, 'ignore')
  assertEquals(stateFromSubscriptionStatuses(null, opts).kind, 'ignore')
  assertFalse(stateFromSubscriptionStatuses({ data: 'x' }, opts).kind === 'update')
})

// ---- 記録の保持 ----

Deno.test('記録は90日で消す', () => {
  assertEquals(NOTIFICATION_RETENTION_DAYS, 90)
  assertEquals(retentionCutoff(NOW), new Date(NOW - 90 * DAY).toISOString())
})

// ---- security-review 2026-09-13 ----

Deno.test('種類・サブタイプが Apple の形でなければ通知として扱わない(表やログに長い文字列を書かせない)', () => {
  const uuid = '11111111-2222-3333-4444-555555555555'
  assertEquals(parseNotification({ signedPayload: jws({ notificationUUID: uuid, notificationType: 'TEST', subtype: 'A'.repeat(47000) }) }), null)
  assertEquals(parseNotification({ signedPayload: jws({ notificationUUID: uuid, notificationType: 'TEST\nupdated active' }) }), null)
  assertEquals(parseNotification({ signedPayload: jws({ notificationUUID: uuid, notificationType: 'did_renew' }) }), null)
  assertEquals(parseNotification({ signedPayload: jws({ notificationUUID: uuid, notificationType: 'DID_RENEW', subtype: 42 }) }), null)
  // Apple の実際の値は通る。
  assertEquals(parseNotification(notification({ notificationType: 'DID_FAIL_TO_RENEW', subtype: 'GRACE_PERIOD' }))?.subtype, 'GRACE_PERIOD')
  assertEquals(parseNotification(notification({ notificationType: 'EXPIRED', subtype: 'BILLING_RETRY' }))?.notificationType, 'EXPIRED')
})

Deno.test('TEST 通知の記録は環境ごとに1行(UUID ごとに増やさない)', () => {
  assertEquals(testRecordKey('Production'), 'test-production')
  assertEquals(testRecordKey('Sandbox'), 'test-sandbox')
})

Deno.test('同じ購読を問い合わせ直さない間隔は1分', () => {
  assertEquals(RECHECK_COOLDOWN_SECONDS, 60)
  assertEquals(cooldownSince(NOW), new Date(NOW - 60 * 1000).toISOString())
})
