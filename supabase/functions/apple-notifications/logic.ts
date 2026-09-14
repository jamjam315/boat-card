// apple-notifications の判定部分(WP-6)。Deno の API に触れない純粋な関数だけを置く。
//
// ## 通知は「確かめ直すきっかけ」としてだけ使う(案B)
//
// Apple の通知(signedPayload)は JWS で、本来は x5c の証明書チェーンを Apple の
// ルート証明書まで辿って検証しないと中身を信用できない。verify-purchase と同じ理由で
// (logic.ts の payloadFromJws の注記)、**その検証はしない代わりに中身も信用しない**。
//
//   1. 中身からは「どの購読のことか」(originalTransactionId)だけを取り出す
//   2. **App Store Server API に今の状態を問い合わせ**、その答えで memberships を書き換える
//
// 偽の通知を送られても、既にある行を Apple の答えどおりに取り直すだけで、
// 誰かを勝手にプレミアムにすることはできない。
import {
  type AppleTransaction,
  entitlementFromAppleTransaction,
  isKnownProduct,
} from '../verify-purchase/logic.ts'

export const APPLE_SUBSCRIPTIONS_PRODUCTION =
  'https://api.storekit.itunes.apple.com/inApps/v1/subscriptions'
export const APPLE_SUBSCRIPTIONS_SANDBOX =
  'https://api.storekit-sandbox.itunes.apple.com/inApps/v1/subscriptions'

/** 記録(apple_notifications)を残す日数。これより古い行は消す。 */
export const NOTIFICATION_RETENTION_DAYS = 90

/**
 * 同じ購読について、この秒数のあいだは Apple へ問い合わせ直さない。
 *
 * 自分の購入の originalTransactionId を1つ持っていれば、UUID だけを変えた偽の通知を
 * 送り続けて、Apple への問い合わせ・memberships の書き込み・記録の追加を無制限に
 * 起こせた(security-review 2026-09-13)。Apple の本物の通知は1つの購読について
 * 数分に1回も来ない(Sandbox の月額でも更新は約5分おき)。
 *
 * 間隔の内側で届いたものは**捨てずに、間隔が明けるまで待ってから**扱う(2026-09-14)。
 * 応答はもう 200 を返してあるので、以前のように 503 で Apple に送り直してもらうことは
 * できない。
 *
 * 間隔が明けたときに Apple へ問い合わせるのは、**その間隔につき1件だけ**(checkKey の行を
 * 先に入れられた1件)。同時に待っていた他の通知は、その1件が自分の届いた後に
 * 今の状態を取り直すので、扱わずに終える。Edge Function は通知ごとに別の実行環境で
 * 動くことがあり、メモリ上の印だけでは揃わなかった(Sandbox の実測で2件とも問い合わせた)。
 */
export const RECHECK_COOLDOWN_SECONDS = 60

/** クールダウンの境目(これより後に処理した記録があれば、問い合わせ直さない)。 */
export function cooldownSince(now: number, seconds = RECHECK_COOLDOWN_SECONDS): string {
  return new Date(now - seconds * 1000).toISOString()
}

/**
 * 「この購読の、この間隔の確認」を表す記録の鍵。apple_notifications の主キーに入れる。
 *
 * 直前の確認の時刻(lastProcessedAt。記録が無ければ null)が同じ通知どうしは同じ鍵になり、
 * 先に行を入れられた1件だけが Apple に問い合わせる(残りは主キーの重複で入れられない)。
 * 問い合わせた1件の記録が次の「直前の確認」になるので、1つの購読につき1分に1行までしか増えない。
 */
export function checkKey(
  env: AppleEnvironment,
  originalTransactionId: string,
  lastProcessedAt: string | null,
): string {
  return 'check:' + env.toLowerCase() + ':' + originalTransactionId + ':' + (lastProcessedAt ?? 'none')
}

/**
 * 先に確認を取った1件が失敗したとき(error で終わった・実行環境ごと止まって processing の
 * まま)に、待っていた側が1回だけ代わりに確認するための鍵。これも先に入れた1件だけ。
 * クールダウンは待たない(失敗した確認の代わりなので、Apple への問い合わせは1間隔に2回まで)。
 */
export function takeoverKey(key: string): string {
  return key + ':takeover'
}

/**
 * 待っていた側が、先に確認を取った1件の結果を待つ長さ。その1件がやり直しを使い切っても
 * 終わる長さ(下の RETRY_DELAYS_MS と APPLE_FETCH_TIMEOUT_MS から)より長くしておく。
 */
export const WINNER_WAIT_MS = 38_000

/** データベースへの1回の読み書きを諦めるまでの時間(応答の後の処理を上限の時間に収めるため)。 */
export const DB_TIMEOUT_MS = 5_000

/**
 * 代わりの確認を始めてよい、処理の開始からの経過時間の上限。これを過ぎていたら代わりはしない
 * (代わりの確認そのものが実行時間の上限に掛かって途中で止められるくらいなら、日次の復元に任せる)。
 */
export const TAKEOVER_DEADLINE_MS = 108_000

/**
 * 直前の確認(lastProcessedAt)から間隔が明けるまで、あと何ミリ秒待つか。
 * 明けていれば 0。時計のずれで未来の時刻が入っていても、間隔ぶんより長くは待たない。
 */
export function cooldownWaitMs(
  lastProcessedAt: number,
  now: number,
  seconds = RECHECK_COOLDOWN_SECONDS,
): number {
  const wait = lastProcessedAt + seconds * 1000 - now
  return Math.max(0, Math.min(wait, seconds * 1000))
}

/**
 * Apple への問い合わせ・memberships の更新が一時的に失敗したときに、やり直すまでの待ち時間。
 *
 * 通知には応答を返し終えてから処理する(Apple が待ちきれずに TIMED_OUT にしないため)。
 * そのぶん失敗しても Apple は送り直さないので、ここで2回までやり直す。
 * クールダウンの待ち(最長60秒)・先に確認を取った1件の結果待ち(WINNER_WAIT_MS)と合わせても、
 * Edge Function の実行時間の上限(150秒)に収まる長さ。ただし上限は実行環境ごとなので、
 * その環境が他の処理で長く動いていれば途中で止められることはある(そのときも日次の復元で拾う)。
 * それでも駄目なときは、アプリを開いたときの日次の復元(billing-ios.js)で取り直す。
 */
export const RETRY_DELAYS_MS = [2_000, 6_000]

/** Apple への1回の問い合わせを諦めるまでの時間。上のやり直しと合わせて実行時間の上限に収める。 */
export const APPLE_FETCH_TIMEOUT_MS = 8_000

/** 受け付ける本文の上限。本物の通知は数KB。これを超えるものは読まない。 */
export const MAX_BODY_BYTES = 64 * 1024

/**
 * TEST 通知の記録に使う固定の鍵。**通知ごとの UUID では記録しない。**
 *
 * TEST は購読に紐づかず、Apple にも確かめようがないので、UUID ごとに行を作ると
 * 偽の TEST で表をいくらでも埋められる(security-review 2026-09-13)。環境ごとに
 * 1行だけを上書きし、「最後にテスト通知を受け取った時刻」だけが分かるようにする。
 */
export function testRecordKey(env: AppleEnvironment): string {
  return 'test-' + env.toLowerCase()
}

/**
 * JWS のペイロードを**署名検証せずに**取り出す。
 * 使うのは「どの購読か」を知るためだけで、値は信用しない(冒頭の注記)。
 */
export function decodeJwsPayload(jws: unknown): Record<string, unknown> | null {
  if (typeof jws !== 'string') return null
  const parts = jws.split('.')
  if (parts.length !== 3) return null
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4))
    const json = JSON.parse(atob(b64 + pad))
    return typeof json === 'object' && json !== null && !Array.isArray(json) ? json : null
  } catch {
    return null
  }
}

export type AppleEnvironment = 'Production' | 'Sandbox'

export type ParsedNotification = {
  notificationUUID: string
  notificationType: string
  subtype: string | null
  environment: AppleEnvironment
  bundleId: string | null
  /** TEST 通知には無い。 */
  originalTransactionId: string | null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * 通知の種類・サブタイプの形。Apple の値はすべて英大文字と _ (DID_RENEW・GRACE_PERIOD 等)。
 *
 * **この形でなければ通知として扱わない**(security-review 2026-09-13)。
 * 以前は種類を64字まで・サブタイプを長さ無制限で受けていて、偽の本文で数十KBの
 * 文字列を記録の表やログへ書き込めた。
 */
const TYPE_RE = /^[A-Z][A-Z_]{0,39}$/

/**
 * 届いた本文 `{ signedPayload }` を読む。形が違えば null(Apple からの通知ではない)。
 *
 * originalTransactionId は signedTransactionInfo を優先し、無ければ signedRenewalInfo から取る。
 */
export function parseNotification(body: unknown): ParsedNotification | null {
  if (typeof body !== 'object' || body === null) return null
  const payload = decodeJwsPayload((body as { signedPayload?: unknown }).signedPayload)
  if (!payload) return null

  const uuid = payload.notificationUUID
  const type = payload.notificationType
  if (typeof uuid !== 'string' || !UUID_RE.test(uuid)) return null
  if (typeof type !== 'string' || !TYPE_RE.test(type)) return null
  const subtype = payload.subtype
  if (subtype !== undefined && subtype !== null && (typeof subtype !== 'string' || !TYPE_RE.test(subtype))) {
    return null
  }

  const data = (typeof payload.data === 'object' && payload.data !== null)
    ? payload.data as Record<string, unknown>
    : {}
  // TEST 通知は data を持たないことがあるので、環境は data → summary → 本体の順に探す。
  const envRaw = data.environment ?? (payload.summary as Record<string, unknown> | undefined)?.environment
  const environment: AppleEnvironment = envRaw === 'Sandbox' ? 'Sandbox' : 'Production'

  const tx = decodeJwsPayload(data.signedTransactionInfo)
  const renewal = decodeJwsPayload(data.signedRenewalInfo)
  const original = tx?.originalTransactionId ?? renewal?.originalTransactionId

  return {
    notificationUUID: uuid.toLowerCase(),
    notificationType: type,
    subtype: typeof subtype === 'string' ? subtype : null,
    environment,
    bundleId: typeof data.bundleId === 'string' ? data.bundleId : null,
    originalTransactionId: typeof original === 'string' && /^\d{1,32}$/.test(original)
      ? original
      : null,
  }
}

/** 問い合わせ先。**通知の environment で決める**(Sandbox の購読は本番に無い)。 */
export function subscriptionsBase(env: AppleEnvironment): string {
  return env === 'Sandbox' ? APPLE_SUBSCRIPTIONS_SANDBOX : APPLE_SUBSCRIPTIONS_PRODUCTION
}

/**
 * Get All Subscription Statuses の status。
 * https://developer.apple.com/documentation/appstoreserverapi/status
 */
export const APPLE_STATUS = {
  ACTIVE: 1,
  EXPIRED: 2,
  BILLING_RETRY: 3,
  GRACE_PERIOD: 4,
  REVOKED: 5,
} as const

export type MembershipUpdate = {
  status: 'active' | 'inactive'
  currentPeriodEnd: string | null
  /** ログ・記録用の短い理由。 */
  reason: string
}

export type StateResult =
  | { kind: 'update'; update: MembershipUpdate }
  | { kind: 'not_found' }
  | { kind: 'ignore'; reason: string }

/**
 * Apple の答え(Get All Subscription Statuses)から、memberships に書く状態を決める。
 *
 * | status | 書くもの |
 * |---|---|
 * | 1 有効 | 取引が有効なら active・期限は取引の expiresDate(返金済みなら inactive) |
 * | 4 猶予期間 | active・期限は更新情報の gracePeriodExpiresDate(過ぎていれば inactive) |
 * | 2 期限切れ / 3 支払い再試行中 / 5 取り消し | inactive |
 *
 * **猶予期間(Billing Grace Period)は ASC で有効にしてある**(2026-09-13 JAM判断)。
 * カードの失敗中もその期間は使える、が Apple の推奨。
 *
 * 他のアプリ・他の商品の取引なら ignore(行に触らない)。
 */
export function stateFromSubscriptionStatuses(
  body: unknown,
  opts: { originalTransactionId: string; expectedBundleId: string; now: number },
): StateResult {
  if (typeof body !== 'object' || body === null) return { kind: 'ignore', reason: 'unreadable' }
  const b = body as { bundleId?: unknown; data?: unknown }
  if (typeof b.bundleId === 'string' && b.bundleId !== opts.expectedBundleId) {
    return { kind: 'ignore', reason: 'bundle mismatch' }
  }
  const groups = Array.isArray(b.data) ? b.data : []
  for (const g of groups) {
    const last = Array.isArray((g as { lastTransactions?: unknown })?.lastTransactions)
      ? (g as { lastTransactions: unknown[] }).lastTransactions
      : []
    for (const item of last) {
      const it = item as { originalTransactionId?: unknown; status?: unknown; signedTransactionInfo?: unknown; signedRenewalInfo?: unknown }
      if (it?.originalTransactionId !== opts.originalTransactionId) continue

      const tx = decodeJwsPayload(it.signedTransactionInfo) as AppleTransaction | null
      if (!tx) return { kind: 'ignore', reason: 'no transaction info' }
      if (tx.bundleId !== opts.expectedBundleId) return { kind: 'ignore', reason: 'bundle mismatch' }
      if (typeof tx.productId !== 'string' || !isKnownProduct(tx.productId)) {
        return { kind: 'ignore', reason: 'unknown product' }
      }
      const verdict = entitlementFromAppleTransaction(tx, {
        expectedProductId: tx.productId,
        expectedBundleId: opts.expectedBundleId,
        now: opts.now,
      })

      switch (it.status) {
        case APPLE_STATUS.ACTIVE:
          return {
            kind: 'update',
            update: {
              status: verdict.isActive ? 'active' : 'inactive',
              currentPeriodEnd: verdict.expiry,
              reason: verdict.isActive ? 'active' : 'active status but ' + verdict.reason,
            },
          }
        case APPLE_STATUS.GRACE_PERIOD: {
          if (typeof tx.revocationDate === 'number') {
            return { kind: 'update', update: { status: 'inactive', currentPeriodEnd: null, reason: 'revoked' } }
          }
          const renewal = decodeJwsPayload(it.signedRenewalInfo)
          const grace = renewal?.gracePeriodExpiresDate
          if (typeof grace === 'number' && grace > opts.now) {
            return {
              kind: 'update',
              update: { status: 'active', currentPeriodEnd: new Date(grace).toISOString(), reason: 'grace period' },
            }
          }
          return {
            kind: 'update',
            update: { status: 'inactive', currentPeriodEnd: verdict.expiry, reason: 'grace period over' },
          }
        }
        case APPLE_STATUS.EXPIRED:
          return { kind: 'update', update: { status: 'inactive', currentPeriodEnd: verdict.expiry, reason: 'expired' } }
        case APPLE_STATUS.BILLING_RETRY:
          return {
            kind: 'update',
            update: { status: 'inactive', currentPeriodEnd: verdict.expiry, reason: 'billing retry' },
          }
        case APPLE_STATUS.REVOKED:
          return { kind: 'update', update: { status: 'inactive', currentPeriodEnd: null, reason: 'revoked' } }
        default:
          return { kind: 'ignore', reason: 'unknown status ' + String(it.status) }
      }
    }
  }
  return { kind: 'not_found' }
}

/** 記録を消す境目(これより前に受け取った行を消す)。 */
export function retentionCutoff(now: number, days = NOTIFICATION_RETENTION_DAYS): string {
  return new Date(now - days * 24 * 3600 * 1000).toISOString()
}
