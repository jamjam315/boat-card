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
// ## 応答を先に返し、処理はその後(2026-09-14)
//
// TestFlight の自動更新(#7)で、DID_RENEW が Apple の記録で TIMED_OUT になった。
// 止まっていた関数の起動と Apple への問い合わせを待ってから応答していたため(約4.5秒)。
// そこで、**データベースにも Apple にも触れない確認(形・大きさ・bundleId)だけ済ませて
// すぐ 200 を返し**、残り(2〜4)は EdgeRuntime.waitUntil で応答の後に行う。
//
//   ・Apple は 200 を受け取ったら送り直さない。一時的な失敗は、ここで2回までやり直す
//     (logic.ts の RETRY_DELAYS_MS)。それでも駄目なら記録に error を残し、
//     アプリを開いたときの日次の復元(billing-ios.js の autoRestoreIfRenewalDue)で取り直す
//   ・同じ購読の1分のクールダウンは続ける。間隔の内側で届いたものは捨てずに、明けるまで
//     待ってから扱う(logic.ts の RECHECK_COOLDOWN_SECONDS)
//   ・Apple に問い合わせるのは **1つの間隔につき1件だけ**。apple_notifications に確認の行
//     (logic.ts の checkKey)を先に入れられた1件が問い合わせ、同時に待っていた他の通知は
//     その結果を待つ。その1件が失敗していたら、1件だけが代わりに問い合わせる(takeoverKey)。
//     Edge Function は通知ごとに別の実行環境で動くことがあり、メモリ上の印では揃わない
//     (Sandbox の実測で、待っていた2件がそれぞれ問い合わせた)。時刻もデータベースの now() で揃える
//   ・Sandbox の許可リストはクールダウンより先に見る。許可されない購読の通知は記録を残さない
//     (偽の Sandbox 通知で記録を増やし、本番の購読のクールダウンを延ばされないように。
//     security-review 2026-09-14。確認の行も環境ごとに分けてある)

// ## 応答
//
// 受け付けた → 200 accepted。他のアプリの通知 → 200 ignored。
// 形の違う本文 → 400、大きすぎる本文 → 413(Apple からの通知ではない)。
// APPLE_BUNDLE_ID が未設定 → 500(本物の通知を捨てないよう、Apple に送り直してもらう)。
//
// ## URL を知られたときの備え(security-review 2026-09-13)
//
// ・本文は 64KB まで。Content-Length で先に断り、読みながらも数えて打ち切る
// ・種類・サブタイプは Apple の形(英大文字と _)でなければ読まない
// ・記録を残すのは、memberships に行があり Sandbox の許可も通った購読の確認だけ(1分に1行まで)。
//   TEST は環境ごとに1行を上書き
// ・同じ購読について Apple へ問い合わせるのは1分に1回まで(失敗の代わりを入れても2回まで)
//
// ## 起動保護
//
// Apple は Supabase の JWT を持たないので config.toml で verify_jwt = false。
// 共有の秘密も送ってこないので、入口では絞れない。上の「中身を信用しない」がその代わり。
import { createClient } from 'npm:@supabase/supabase-js@^2'
import { createAppleApiToken } from '../_shared/apple_api.ts'
import { appleSecretsConfigured, sandboxAllowedFor } from '../verify-purchase/logic.ts'
import {
  APPLE_FETCH_TIMEOUT_MS,
  checkKey,
  cooldownWaitMs,
  DB_TIMEOUT_MS,
  MAX_BODY_BYTES,
  type ParsedNotification,
  parseNotification,
  retentionCutoff,
  RETRY_DELAYS_MS,
  stateFromSubscriptionStatuses,
  subscriptionsBase,
  TAKEOVER_DEADLINE_MS,
  takeoverKey,
  testRecordKey,
  WINNER_WAIT_MS,
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** データベースの1回の読み書きの打ち切り(logic.ts の DB_TIMEOUT_MS)。 */
const dbTimeout = () => AbortSignal.timeout(DB_TIMEOUT_MS)

/**
 * 応答を返した後も、この処理が終わるまで実行環境を止めないでもらう。
 * Edge Runtime の外(ローカルで動かしたとき等)では、待たずにそのまま流す。
 */
function runAfterResponse(task: Promise<void>): void {
  const safe = task.catch((e) => console.error(TAG, 'background failed:', String(e)))
  const rt = (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime
  rt?.waitUntil(safe)
}

// 実行時間の上限などで処理の途中で止められたら、ログで分かるようにする。
addEventListener('beforeunload', (ev) => {
  const reason = (ev as Event & { detail?: { reason?: string } }).detail?.reason
  console.log(TAG, 'shutdown', reason ?? '')
})

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

type DbResult<T> = { data: T | null; error: { message: string; code?: string } | null }

/**
 * データベースを読む。失敗したら2秒おいて1回だけやり直す(応答はもう返したので、Apple は送り直さない)。
 * supabaseAdmin は主データベースに向いている(読み取り専用の複製ではない)。確認の行を
 * 「まだ無い」と読んだことを、合流の判定の前提にしているため、複製には向けないこと。
 */
async function read<T>(label: string, run: () => PromiseLike<DbResult<T>>): Promise<{ ok: true; data: T | null } | { ok: false }> {
  for (let i = 0; i < 2; i++) {
    const { data, error } = await run()
    if (!error) return { ok: true, data }
    console.error(TAG, label + 'に失敗:', error.message)
    if (i === 0) await sleep(2_000)
  }
  return { ok: false }
}

/** TEST 通知の記録。環境ごとに1行を上書きする(偽の TEST で表を埋められないように・logic.ts の testRecordKey)。 */
async function recordTest(n: ParsedNotification): Promise<void> {
  const { error } = await supabaseAdmin.from('apple_notifications').upsert({
    notification_uuid: testRecordKey(n.environment),
    notification_type: n.notificationType,
    subtype: n.subtype,
    environment: n.environment,
    original_transaction_id: null,
    result: 'test',
    processed_at: new Date().toISOString(),
  }, { onConflict: 'notification_uuid' }).abortSignal(dbTimeout())
  if (error) console.error(TAG, '記録に失敗:', error.message)
}

/**
 * 確認の行を入れる(= この間隔の確認を取る)。主キーが重なれば、先に取った1件がある。
 * received_at はデータベースの now() が入り、次のクールダウンの起点になる。
 */
async function insertCheck(n: ParsedNotification, key: string, otx: string): Promise<'won' | 'taken' | 'failed'> {
  for (let i = 0; i < 2; i++) {
    const { error } = await supabaseAdmin.from('apple_notifications').insert({
      notification_uuid: key,
      notification_type: n.notificationType,
      subtype: n.subtype,
      environment: n.environment,
      original_transaction_id: otx,
      result: 'processing',
    }).abortSignal(dbTimeout())
    if (!error) return 'won'
    if ((error as { code?: string }).code === '23505') return 'taken'
    console.error(TAG, '確認の行の追加に失敗:', error.message)
    // 打ち切りで失敗したときは、実は入っていることがある。やり直して重なれば taken になる
    if (i === 0) await sleep(2_000)
  }
  return 'failed'
}

/** 確認の結果を書き込む。ついでに90日より古い記録を消す(専用の cron は持たない)。 */
async function finishCheck(key: string, result: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from('apple_notifications')
    .update({ result, processed_at: new Date().toISOString() })
    .eq('notification_uuid', key)
    .abortSignal(dbTimeout())
  if (error) console.error(TAG, '記録に失敗:', error.message)

  const { error: purgeErr } = await supabaseAdmin
    .from('apple_notifications')
    .delete()
    .lt('received_at', retentionCutoff(Date.now()))
    .abortSignal(dbTimeout())
  if (purgeErr) console.error(TAG, '古い記録の削除に失敗:', purgeErr.message)
}

/**
 * クールダウンで待っている確認の鍵・結果を見届けている確認の鍵(この実行環境の中だけ)。
 * 同じ鍵を待つ通知が同じ実行環境に来たら、待たずに終える(待っている1本が、その通知が
 * 届いた後に確認するか、別の実行環境の1件の結果を見届け、失敗なら代わりに確認する)。
 * 偽の通知の連打で、待つ処理や読み取りを通知の数だけ増やさないため。
 */
const waiting = new Set<string>()

/** 一時的な失敗(やり直せば直るかもしれない)か、それ以上やっても変わらない結果か。 */
type Attempt = { done: true; result: string } | { done: false; why: string }

/** Apple に今の状態を聞き、memberships を書き換える(1回ぶん)。 */
async function refreshFromApple(
  n: ParsedNotification,
  otx: string,
  userId: string,
  bundleId: string,
  head: string,
): Promise<Attempt> {
  const who = 'user=' + userId.slice(0, 8)
  const keyId = Deno.env.get('APPLE_KEY_ID') ?? ''
  const issuerId = Deno.env.get('APPLE_ISSUER_ID') ?? ''
  const privateKey = Deno.env.get('APPLE_PRIVATE_KEY') ?? ''
  if (!appleSecretsConfigured(keyId, issuerId, privateKey, bundleId)) {
    console.error(TAG, 'APPLE_* secrets not configured')
    return { done: false, why: 'not configured' }
  }

  let res: Response
  try {
    const token = await createAppleApiToken({ keyId, issuerId, privateKey, bundleId })
    res = await fetch(subscriptionsBase(n.environment) + '/' + encodeURIComponent(otx), {
      headers: { authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(APPLE_FETCH_TIMEOUT_MS),
    })
  } catch (e) {
    console.error(TAG, 'apple api call failed:', String(e))
    return { done: false, why: 'apple unreachable' }
  }

  if (res.status === 404) {
    console.log(TAG, 'apple: subscription not found ' + who + ' ' + head)
    return { done: true, result: 'apple not found' }
  }
  if (!res.ok) {
    // 401(鍵)・429・5xx は、やり直せば直る可能性がある。
    console.error(TAG, 'apple api status=' + res.status + ' ' + who + ' ' + head)
    return { done: false, why: 'apple status ' + res.status }
  }

  let statuses: unknown
  try {
    statuses = await res.json()
  } catch {
    return { done: false, why: 'apple response unreadable' }
  }

  const state = stateFromSubscriptionStatuses(statuses, {
    originalTransactionId: otx,
    expectedBundleId: bundleId,
    now: Date.now(),
  })
  if (state.kind !== 'update') {
    const why = state.kind === 'ignore' ? state.reason : 'not in statuses'
    console.log(TAG, 'no update (' + why + ') ' + who + ' ' + head)
    return { done: true, result: 'ignored: ' + why }
  }

  // --- 書き換える(status と期限だけ・その人のその購読の行だけ) ---
  const { error: upErr } = await supabaseAdmin
    .from('memberships')
    .update({
      status: state.update.status,
      current_period_end: state.update.currentPeriodEnd,
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', userId)
    .eq('purchase_token', otx)
    .eq('platform', 'ios')
    .abortSignal(dbTimeout())
  if (upErr) {
    console.error(TAG, 'memberships の更新に失敗:', upErr.message)
    return { done: false, why: 'update failed' }
  }

  console.log(TAG, `updated ${state.update.status} (${state.update.reason}) ${who} ${head}`)
  return { done: true, result: `updated ${state.update.status}: ${state.update.reason}` }
}

/** 確認を取った1件として、Apple に聞いて書き換え、結果を記録する(一時的な失敗は2回までやり直す)。 */
async function runCheck(
  n: ParsedNotification,
  key: string,
  otx: string,
  userId: string,
  bundleId: string,
  head: string,
): Promise<void> {
  const who = 'user=' + userId.slice(0, 8)
  let attempt = await refreshFromApple(n, otx, userId, bundleId, head)
  for (const delay of RETRY_DELAYS_MS) {
    if (attempt.done) break
    console.log(TAG, `retry in ${delay / 1000}s (${attempt.why}) ${who} ${head}`)
    await sleep(delay)
    attempt = await refreshFromApple(n, otx, userId, bundleId, head)
  }
  if (attempt.done) {
    await finishCheck(key, attempt.result)
  } else {
    console.error(TAG, `gave up (${attempt.why}) ${who} ${head}`)
    await finishCheck(key, 'error: ' + attempt.why)
  }
}

/** 先に確認を取った1件の結果を待つ。終われば結果、WINNER_WAIT_MS のうちに終わらなければ null。 */
async function waitForCheck(key: string): Promise<string | null> {
  const until = Date.now() + WINNER_WAIT_MS
  while (Date.now() < until) {
    await sleep(Math.min(4_000, Math.max(0, until - Date.now())))
    const r = await read<{ result: string }[]>('確認の結果の取得', () =>
      supabaseAdmin.from('apple_notifications').select('result').eq('notification_uuid', key).limit(1)
        .abortSignal(dbTimeout()))
    const result = r.ok ? r.data?.[0]?.result : undefined
    if (result && result !== 'processing') return result
  }
  return null
}

/** 応答を返した後の処理。 */
async function processNotification(n: ParsedNotification, bundleId: string): Promise<void> {
  const startedAt = Date.now()
  const head = `type=${n.notificationType}${n.subtype ? '/' + n.subtype : ''} env=${n.environment}`

  // 疎通確認用(ASC の設定後に tools/apple-test-notification.mjs で送る)。
  if (n.notificationType === 'TEST') {
    console.log(TAG, 'test notification received ' + head)
    await recordTest(n)
    return
  }

  const otx = n.originalTransactionId
  if (!otx) {
    console.log(TAG, 'no transaction ' + head)
    return
  }

  // --- 行を探す(作らない) ---
  const rows = await read<{ user_id: string }[]>('memberships の取得', () =>
    supabaseAdmin.from('memberships').select('user_id').eq('purchase_token', otx).eq('platform', 'ios').limit(1)
      .abortSignal(dbTimeout()))
  if (!rows.ok) return
  const row = rows.data?.[0]
  if (!row) {
    // 購入はされたが、まだアプリで検証していない(=誰の購入か分からない)。
    // 記録も残さない(偽の通知で表を埋められないように)。
    console.log(TAG, 'no membership row ' + head)
    return
  }
  const who = 'user=' + row.user_id.slice(0, 8)

  // --- Sandbox は許可リストの人だけ(verify-purchase と同じ基準)。クールダウンより先に見て、記録も残さない ---
  if (
    n.environment === 'Sandbox' &&
    !sandboxAllowedFor(Deno.env.get('APPLE_ALLOW_SANDBOX'), Deno.env.get('APPLE_SANDBOX_USER_IDS'), row.user_id)
  ) {
    console.log(TAG, 'sandbox not allowed ' + who + ' ' + head)
    return
  }

  // --- この間隔の確認を取る(logic.ts の RECHECK_COOLDOWN_SECONDS / checkKey) ---
  const recent = await read<{ received_at: string }[]>('記録の取得', () =>
    supabaseAdmin
      .from('apple_notifications')
      .select('received_at')
      .eq('original_transaction_id', otx)
      .eq('environment', n.environment)
      .like('notification_uuid', 'check:%')
      .order('received_at', { ascending: false })
      .limit(1)
      .abortSignal(dbTimeout()))
  if (!recent.ok) return
  const last = recent.data?.[0]?.received_at ?? null
  const key = checkKey(n.environment, otx, last)
  const wait = last ? cooldownWaitMs(Date.parse(last), Date.now()) : 0
  if (wait > 0) {
    if (waiting.has(key)) {
      console.log(TAG, 'cooldown: merged ' + who + ' ' + head)
      return
    }
    waiting.add(key)
    console.log(TAG, `cooldown: wait ${Math.ceil(wait / 1000)}s ${who} ${head}`)
    try {
      await sleep(wait)
    } finally {
      waiting.delete(key)
    }
  }

  const claim = await insertCheck(n, key, otx)
  if (claim === 'failed') return
  if (claim === 'won') {
    await runCheck(n, key, otx, row.user_id, bundleId, head)
    return
  }

  // 先に取った1件がある。それはこの通知が届いた後に確認を始めたので、結果を見届ければよい。
  // 見届けるのも、この実行環境で同じ鍵につき1本だけ(偽の通知の連打で読み取りを増やさない)。
  const watchKey = 'watch:' + key
  if (waiting.has(watchKey)) {
    console.log(TAG, 'covered (watching) ' + who + ' ' + head)
    return
  }
  waiting.add(watchKey)
  let outcome: string | null
  try {
    outcome = await waitForCheck(key)
  } finally {
    waiting.delete(watchKey)
  }
  if (outcome !== null && !outcome.startsWith('error')) {
    console.log(TAG, 'covered ' + who + ' ' + head)
    return
  }
  // 失敗した(または止まった)ので、1件だけが代わりに確認する。
  // ただし、ここまでに時間を使いすぎていたら代わりはしない(途中で止められるより、日次の復元に任せる)。
  if (Date.now() - startedAt > TAKEOVER_DEADLINE_MS) {
    console.error(TAG, `no takeover (deadline, ${outcome ?? 'no result'}) ${who} ${head}`)
    return
  }
  const alt = takeoverKey(key)
  if (await insertCheck(n, alt, otx) !== 'won') {
    console.log(TAG, 'takeover by another ' + who + ' ' + head)
    return
  }
  console.log(TAG, `takeover (${outcome ?? 'no result'}) ${who} ${head}`)
  await runCheck(n, alt, otx, row.user_id, bundleId, head)
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

    // ここから先(データベース・Apple への問い合わせ)は応答の後に行う。
    runAfterResponse(processNotification(n, bundleId))
    return reply(200, 'accepted')
  },
}
