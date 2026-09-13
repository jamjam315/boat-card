// App Store Server Notifications V2 の受け口(WP-6)。
//
// ## 何の穴を塞ぐか
//
// これまで memberships の iOS の行は、アプリで購入・復元したとき(起動時の日次の
// restore を含む)にしか書き換わらなかった。自動更新されてもアプリを開かなければ
// current_period_end が古いままで、期限を過ぎると Web・朝の通知でプレミアムが外れる。
// 逆に返金されても、アプリを開かなければ期限まで有効のまま。
// Apple が更新・失敗・期限切れ・返金のたびに送ってくる通知で、それを取り直す。
//
// ## 通知は「確かめ直すきっかけ」(案B・logic.ts の冒頭)
//
//   1. 本文から originalTransactionId を読む(署名は見ない・値は信用しない)
//   2. memberships の iOS の行を探す。**無ければ何もしない(行は作らない)**
//      ── 行を作るのは verify-purchase だけ。購入時にアカウントの印
//         (appAccountToken)を付けていないので、通知だけでは誰の購入か分からない
//   3. Sandbox の通知は、APPLE_ALLOW_SANDBOX と許可リスト(その行の user_id)を通るときだけ
//   4. App Store Server API で今の状態を取り、status と current_period_end だけを書き換える
//      (user_id は変えない・手動付与の行には触らない)
//
// ## 応答
//
// 扱った・無視した → 200。Apple や DB の一時的な失敗 → 500(Apple が時間をおいて送り直す)。
// 同じ購読を1分以内に扱ったばかり → 503(同じく送り直してもらう)。
// 形の違う本文 → 400、大きすぎる本文 → 413(Apple からの通知ではない)。
//
// ## URL を知られたときの備え(security-review 2026-09-13)
//
// ・本文は 64KB まで。Content-Length で先に断り、読みながらも数えて打ち切る
// ・種類・サブタイプは Apple の形(英大文字と _)でなければ読まない
// ・記録を残すのは、memberships に行がある購読の通知だけ。TEST は環境ごとに1行を上書き
// ・同じ購読について Apple へ問い合わせるのは1分に1回まで
//
// ## 起動保護
//
// Apple は Supabase の JWT を持たないので config.toml で verify_jwt = false。
// 共有の秘密も送ってこないので、入口では絞れない。上の「中身を信用しない」がその代わり。
import { createClient } from 'npm:@supabase/supabase-js@^2'
import { createAppleApiToken } from '../_shared/apple_api.ts'
import { appleSecretsConfigured, sandboxAllowedFor } from '../verify-purchase/logic.ts'
import {
  cooldownSince,
  MAX_BODY_BYTES,
  type ParsedNotification,
  parseNotification,
  retentionCutoff,
  stateFromSubscriptionStatuses,
  subscriptionsBase,
  testRecordKey,
} from './logic.ts'

const TAG = '[apple-notifications]'

const supabaseAdmin = createClient(
  Deno.env.get('SUPABASE_URL') as string,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') as string,
  { auth: { persistSession: false, autoRefreshToken: false } },
)

function reply(status: number, result: string): Response {
  return Response.json({ result }, { status })
}

/**
 * 本文を上限まで読む。上限を超えたら読むのをやめて null。
 *
 * req.text() は全部を読み切ってから長さが分かるので、巨大な本文でも最後まで
 * 受け取ってしまう(security-review 2026-09-13)。Content-Length で先に断り、
 * 送られてこない・偽っている場合も、読みながら数えて途中で打ち切る。
 */
async function readBodyCapped(req: Request, max: number): Promise<string | null> {
  const declared = Number(req.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > max) return null
  if (!req.body) return ''
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const all = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    all.set(c, off)
    off += c.byteLength
  }
  return new TextDecoder().decode(all)
}

/** 記録を残す。失敗しても通知の処理そのものは止めない(記録は控え)。 */
async function record(n: ParsedNotification, result: string, key = n.notificationUUID): Promise<void> {
  const { error } = await supabaseAdmin.from('apple_notifications').upsert({
    notification_uuid: key,
    notification_type: n.notificationType,
    subtype: n.subtype,
    environment: n.environment,
    original_transaction_id: n.originalTransactionId,
    result,
    processed_at: new Date().toISOString(),
  }, { onConflict: 'notification_uuid' })
  if (error) console.error(TAG, '記録に失敗:', error.message)

  // 90日より古い記録を消す(この関数が動いたついで。専用の cron は持たない)。
  const { error: purgeErr } = await supabaseAdmin
    .from('apple_notifications')
    .delete()
    .lt('received_at', retentionCutoff(Date.now()))
  if (purgeErr) console.error(TAG, '古い記録の削除に失敗:', purgeErr.message)
}

export default {
  async fetch(req: Request): Promise<Response> {
    if (req.method !== 'POST') return reply(405, 'method not allowed')

    const raw = await readBodyCapped(req, MAX_BODY_BYTES)
    if (raw === null) return reply(413, 'too large')
    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch {
      return reply(400, 'invalid json')
    }

    const n = parseNotification(body)
    if (!n) return reply(400, 'not a notification')

    const bundleId = Deno.env.get('APPLE_BUNDLE_ID') ?? ''
    // 設定が抜けていると、本物の通知まで「他のアプリ」として 200 で捨て、Apple が
    // 送り直さなくなる。500 にして送り直してもらう(security-review の付記)。
    if (!bundleId) {
      console.error(TAG, 'APPLE_BUNDLE_ID not configured')
      return reply(500, 'not configured')
    }
    // 他のアプリの通知(または偽物)。記録も残さない(表を埋められないように)。
    // bundleId が入っていない通知も、TEST 以外は同じく捨てる。
    if (n.bundleId !== bundleId && !(n.notificationType === 'TEST' && n.bundleId === null)) {
      console.log(TAG, 'bundle mismatch type=' + n.notificationType)
      return reply(200, 'ignored')
    }

    const head = `type=${n.notificationType}${n.subtype ? '/' + n.subtype : ''} env=${n.environment}`

    // 疎通確認用(ASC の設定後に tools/apple-test-notification.mjs で送る)。
    if (n.notificationType === 'TEST') {
      console.log(TAG, 'test notification received ' + head)
      // UUID ごとには記録しない(偽の TEST で表を埋められないように・logic.ts の testRecordKey)。
      await record(n, 'test', testRecordKey(n.environment))
      return reply(200, 'test')
    }

    if (!n.originalTransactionId) {
      console.log(TAG, 'no transaction ' + head)
      return reply(200, 'ignored')
    }

    // 同じ通知を2回扱わない(Apple は失敗したと思ったときに送り直す)。
    const { data: seen } = await supabaseAdmin
      .from('apple_notifications')
      .select('result')
      .eq('notification_uuid', n.notificationUUID)
      .limit(1)
    if (seen && seen.length > 0 && String(seen[0].result).startsWith('updated')) {
      return reply(200, 'duplicate')
    }

    // --- 行を探す(作らない) ---
    const { data: rows, error: rowErr } = await supabaseAdmin
      .from('memberships')
      .select('user_id')
      .eq('purchase_token', n.originalTransactionId)
      .eq('platform', 'ios')
      .limit(1)
    if (rowErr) {
      console.error(TAG, 'memberships の取得に失敗:', rowErr.message)
      return reply(500, 'lookup failed')
    }
    const row = rows?.[0] as { user_id: string } | undefined
    if (!row) {
      // 購入はされたが、まだアプリで検証していない(=誰の購入か分からない)。
      // 記録も残さない(偽の通知で表を埋められないように)。
      console.log(TAG, 'no membership row ' + head)
      return reply(200, 'no row')
    }
    const who = 'user=' + row.user_id.slice(0, 8)

    // --- 同じ購読を短い間に何度も問い合わせない(logic.ts の RECHECK_COOLDOWN_SECONDS) ---
    // 偽の通知を連打されても、Apple への問い合わせ・書き込み・記録は1分に1回まで。
    // 本物の通知なら 503 で Apple が送り直してくるので、取りこぼさない。
    const { data: recent, error: recentErr } = await supabaseAdmin
      .from('apple_notifications')
      .select('notification_uuid')
      .eq('original_transaction_id', n.originalTransactionId)
      .gte('processed_at', cooldownSince(Date.now()))
      .limit(1)
    if (recentErr) {
      console.error(TAG, '記録の取得に失敗:', recentErr.message)
      return reply(500, 'lookup failed')
    }
    if (recent && recent.length > 0) {
      console.log(TAG, 'cooldown ' + who + ' ' + head)
      return reply(503, 'cooldown')
    }

    // --- Sandbox は許可リストの人だけ(verify-purchase と同じ基準) ---
    if (
      n.environment === 'Sandbox' &&
      !sandboxAllowedFor(Deno.env.get('APPLE_ALLOW_SANDBOX'), Deno.env.get('APPLE_SANDBOX_USER_IDS'), row.user_id)
    ) {
      console.log(TAG, 'sandbox not allowed ' + who + ' ' + head)
      await record(n, 'sandbox not allowed')
      return reply(200, 'ignored')
    }

    // --- Apple に今の状態を聞く ---
    const keyId = Deno.env.get('APPLE_KEY_ID') ?? ''
    const issuerId = Deno.env.get('APPLE_ISSUER_ID') ?? ''
    const privateKey = Deno.env.get('APPLE_PRIVATE_KEY') ?? ''
    if (!appleSecretsConfigured(keyId, issuerId, privateKey, bundleId)) {
      console.error(TAG, 'APPLE_* secrets not configured')
      return reply(500, 'not configured')
    }

    let res: Response
    try {
      const token = await createAppleApiToken({ keyId, issuerId, privateKey, bundleId })
      res = await fetch(
        subscriptionsBase(n.environment) + '/' + encodeURIComponent(n.originalTransactionId),
        { headers: { authorization: 'Bearer ' + token } },
      )
    } catch (e) {
      console.error(TAG, 'apple api call failed:', String(e))
      return reply(500, 'apple unreachable')
    }

    if (res.status === 404) {
      console.log(TAG, 'apple: subscription not found ' + who + ' ' + head)
      await record(n, 'apple not found')
      return reply(200, 'not found')
    }
    if (!res.ok) {
      // 401(鍵)・429・5xx は、送り直してもらえば直る可能性がある。
      console.error(TAG, 'apple api status=' + res.status + ' ' + who + ' ' + head)
      return reply(500, 'apple status ' + res.status)
    }

    let statuses: unknown
    try {
      statuses = await res.json()
    } catch {
      return reply(500, 'apple response unreadable')
    }

    const state = stateFromSubscriptionStatuses(statuses, {
      originalTransactionId: n.originalTransactionId,
      expectedBundleId: bundleId,
      now: Date.now(),
    })
    if (state.kind !== 'update') {
      const why = state.kind === 'ignore' ? state.reason : 'not in statuses'
      console.log(TAG, 'no update (' + why + ') ' + who + ' ' + head)
      await record(n, 'ignored: ' + why)
      return reply(200, 'ignored')
    }

    // --- 書き換える(status と期限だけ・その人のその購読の行だけ) ---
    const { error: upErr } = await supabaseAdmin
      .from('memberships')
      .update({
        status: state.update.status,
        current_period_end: state.update.currentPeriodEnd,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', row.user_id)
      .eq('purchase_token', n.originalTransactionId)
      .eq('platform', 'ios')
    if (upErr) {
      console.error(TAG, 'memberships の更新に失敗:', upErr.message)
      return reply(500, 'update failed')
    }

    console.log(TAG, `updated ${state.update.status} (${state.update.reason}) ${who} ${head}`)
    await record(n, `updated ${state.update.status}: ${state.update.reason}`)
    return reply(200, 'updated')
  },
}
