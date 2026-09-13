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
// 形の違う本文 → 400(Apple からの通知ではない)。
//
// ## 起動保護
//
// Apple は Supabase の JWT を持たないので config.toml で verify_jwt = false。
// 共有の秘密も送ってこないので、入口では絞れない。上の「中身を信用しない」がその代わり。
import { createClient } from 'npm:@supabase/supabase-js@^2'
import { createAppleApiToken } from '../_shared/apple_api.ts'
import { appleSecretsConfigured, sandboxAllowedFor } from '../verify-purchase/logic.ts'
import {
  MAX_BODY_BYTES,
  type ParsedNotification,
  parseNotification,
  retentionCutoff,
  stateFromSubscriptionStatuses,
  subscriptionsBase,
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

/** 記録を残す。失敗しても通知の処理そのものは止めない(記録は控え)。 */
async function record(n: ParsedNotification, result: string): Promise<void> {
  const { error } = await supabaseAdmin.from('apple_notifications').upsert({
    notification_uuid: n.notificationUUID,
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

    const raw = await req.text()
    if (raw.length > MAX_BODY_BYTES) return reply(400, 'too large')
    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch {
      return reply(400, 'invalid json')
    }

    const n = parseNotification(body)
    if (!n) return reply(400, 'not a notification')

    const bundleId = Deno.env.get('APPLE_BUNDLE_ID') ?? ''
    // 他のアプリの通知(または偽物)。記録も残さない(表を埋められないように)。
    if (n.bundleId !== null && n.bundleId !== bundleId) {
      console.log(TAG, 'bundle mismatch type=' + n.notificationType)
      return reply(200, 'ignored')
    }

    const head = `type=${n.notificationType}${n.subtype ? '/' + n.subtype : ''} env=${n.environment}`

    // 疎通確認用(ASC の設定後に tools/apple-test-notification.mjs で送る)。
    if (n.notificationType === 'TEST') {
      console.log(TAG, 'test notification received ' + head)
      await record(n, 'test')
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
