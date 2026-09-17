// ストアの定期購入を検証して、memberships を書き換える(タスク③ / WP-3a)。
//
// アプリ内で購入すると購入の証跡が手に入る。それをこの関数に渡し、**ストアの
// サーバーに問い合わせて**「本当に買われていて、いま有効か」を確かめてから
// memberships に書き込む。クライアントが言ってきた内容は一切信用しない。
//
// ## 2つのストア
//
//   Android(TWA) … purchaseToken を Google Play Developer API へ
//   iOS(殻)      … 購入のJWSから取り出したIDを App Store Server API へ
//
// **構図は同じ。** どちらもクライアントが送ってきたものは信用せず、権威の
// サーバーの答えだけを採用する。違いは問い合わせ先と証跡の形だけなので、
// 入口(認証・使い回しの検出・キャッシュ)と出口(memberships への書き戻し)は
// 1本にまとめてある。
//
// どちらのストアかは body の platform で決まる。**未指定は android**——
// 出回っている billing.js は platform を送らないため(logic.ts の parsePlatform)。
//
// ## フェイルクローズ
// 「有効」と答えるのは、**ストアが明示的に有効と答えた場合だけ**。それ以外
// (Secrets未設定・認証不備・照会失敗・応答が読めない・例外)は
// **すべて is_active:false を返す**。疑わしきは無効。
// GOOGLE_PLAY_SA_KEY を設定するまでAndroidでは、APPLE_* を設定するまでiOSでは、
// この関数は誰もプレミアムにしない。設定前はそれが正しい挙動。
// **片方のSecretsが欠けても、もう片方のストアには影響しない**(判定が別々のため)。
//
// ## なぜ呼び出し元チェックが共有キーではなくJWTなのか
// レジャー帳の同名関数は X-Client-Key(アプリの.envに載る値)で入口を絞っている。
// あれはアカウントを持たないアプリなので、それ以上の手が無かった。
// 艇読みはSupabaseのアカウントがあるので、**JWTそのものを認証に使う**。
// 誰が呼んだかが確実に分かるうえ、書き込む先も必ずその本人の行だけになる。
// 共有キーのようにAPKから抜き出せる値でもない。
//
// ## デプロイ
//   supabase functions deploy verify-purchase --project-ref <PROJECT_REF>
//
// Secrets(Android):
//   GOOGLE_PLAY_SA_KEY / ANDROID_PACKAGE_NAME
// Secrets(iOS):
//   APPLE_KEY_ID / APPLE_ISSUER_ID / APPLE_PRIVATE_KEY / APPLE_BUNDLE_ID
//
// 手順は docs/ops/appstore-verify-deploy.md に全部書いてある。
// **鍵の現物は絶対にこのリポジトリに置かないこと**
// (mainがGitHub Pagesでそのまま公開されるため。.gitignore が *.p8 と
//  service-account*.json を名前の時点で弾いているが、頼り切らない)。
//
// APPLE_* が未設定のあいだ、iOSの購入は常に is_active:false(フェイルクローズ)。
// Androidの経路には影響しない。
import { withSupabase } from 'npm:@supabase/server@^1'
import { createClient } from 'npm:@supabase/supabase-js@^2'
import { createAppleApiToken } from '../_shared/apple_api.ts'
// 購読としての今の状態は、apple-notifications と**同じ判定**を使う(公開後バックログ1)。
// 片方だけ直すと、通知が active にした行をアプリの検証が inactive に戻す、という
// 食い違いがまた起きる。
import {
  APPLE_FETCH_TIMEOUT_MS,
  stateFromSubscriptionStatuses,
  subscriptionsBase,
} from '../apple-notifications/logic.ts'
import {
  appleRowKey,
  appleSecretsConfigured,
  appleSourceAllowed,
  appleTransactionMatches,
  canUseCache,
  entitlementFromAppleTransaction,
  finalAppleEntitlement,
  shouldAskSubscriptionStatus,
  fetchAppleTransaction,
  isAcceptableToken,
  isKnownProduct,
  isRowActive,
  keepsManualGrant,
  membershipRowKey,
  parsePlatform,
  parseSubscription,
  sandboxAllowed,
  sandboxAllowedFor,
  secretsConfigured,
  tokenTakenByOther,
  transactionIdFromJws,
  isAnonymousJwt,
} from './logic.ts'
import type { MembershipRow } from './logic.ts'

const JSON_HEADERS = { 'content-type': 'application/json' }
const API_BASE = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications'

const supabaseAdmin = createClient(
  Deno.env.get('SUPABASE_URL') as string,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') as string,
  { auth: { persistSession: false } },
)

/**
 * 無効を返す。理由はログにだけ出し、呼び出し元には返さない(手がかりを与えない)。
 *
 * ## retryable が付く意味(WP-3f)
 *
 * **これは「確かめられなかった」であって「無効だと確かめた」ではない。**
 * 判定を返すのは [ok] だけで、そちらに retryable は付かない。
 *
 * 区別が要るのは、iOSの殻が返事を見て取引を完了させるため。「確かめられなかった」を
 * 拒否と読むと、支払い済みの取引がストアの待ち行列から消え、再配送で拾い直せなく
 * なる(billing-ios.js の verify を参照)。Secrets未設定・Apple照会失敗・応答が
 * 読めない、はすべてこちら側。
 *
 * 使い回しの検出(409)だけは**確定的な拒否**で、HTTPステータスで見分けられる。
 */
function denied(reason: string, status = 200, code?: string): Response {
  console.log('[verify-purchase] denied: ' + reason)
  // code は画面の文言を分けるためだけの短い符丁(内部の事情は出さない)。
  return new Response(JSON.stringify({ is_active: false, retryable: true, ...(code ? { code } : {}) }), {
    status,
    headers: JSON_HEADERS,
  })
}

/**
 * この人に、運営が手で付けた有効な権利(manual)があるか(logic.ts の keepsManualGrant)。
 * あれば、その行を返す。書き戻しの直前に呼び、あれば**書かずに**その権利を答える。
 *
 * ストアへの照会・使い回しの検出・Playの受領(acknowledge)はこの前に済ませてあり、
 * 飛ばすのは memberships への書き戻しだけ。読めなかったときは書かずに無効を返す
 * (手の権利を消してしまう側には倒さない)。
 */
async function readManualGrant(
  userId: string,
): Promise<{ ok: true; row: MembershipRow | null } | { ok: false; error: string }> {
  const { data, error } = await supabaseAdmin
    .from('memberships')
    .select('user_id,status,price_id,current_period_end,platform')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  return { ok: true, row: keepsManualGrant(data, Date.now()) ? data : null }
}

function ok(active: boolean, productId: string, expiry: string | null): Response {
  return new Response(
    JSON.stringify({ is_active: active, product_id: productId, expiry }),
    { status: 200, headers: JSON_HEADERS },
  )
}

export default {
  fetch: withSupabase(
    {
      auth: 'user',
      cors: {
        headers: {
          'Access-Control-Allow-Origin': 'https://teiyomi.com',
          'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
        },
      },
    },
    async (
      req: Request,
      ctx: { userClaims?: Record<string, unknown>; jwtClaims?: Record<string, unknown> | null },
    ) => {
      try {
        if (req.method !== 'POST') return denied('method not allowed', 405)

        const userId = ctx.userClaims?.id as string | undefined
        if (!userId) return denied('unauthorized', 401)

        // 匿名アカウントには課金させない。購入はメールで本人確認済みの
        // アカウントに紐づける(端末を変えたときに引き継げるようにするため)。
        // 判定は検証済みJWT(jwtClaims)で見る。userClaims は is_anonymous を持たない(logic.ts)。
        if (isAnonymousJwt(ctx.jwtClaims)) return denied('anonymous user', 403)

        let body: Record<string, unknown>
        try {
          body = await req.json()
        } catch {
          return denied('invalid json', 400)
        }
        const purchaseToken = body.purchase_token
        const productId = body.product_id

        // どのストアの話か。知らない値は android に倒さず拒否する(logic.ts)。
        const platform = parsePlatform(body.platform)
        if (platform === null) return denied('unknown platform', 400)

        if (typeof purchaseToken !== 'string' || typeof productId !== 'string') {
          return denied('invalid parameters', 400)
        }
        // 証跡の形はストアごとに違う。**同じ上限で受けない。**
        // Playのトークンは100〜200文字だが、AppleのJWSは x5c(証明書3枚)を含んで
        // 5〜8KBある。4096で共通にしていたレジャー帳では、Sandboxの購入が
        // 入口の `invalid parameters` で弾かれていた(2026-08-25)。
        if (!isAcceptableToken(purchaseToken, platform)) {
          return denied('invalid purchase_token for ' + platform, 400)
        }
        // 身に覚えのない商品IDはストアに問い合わせもしない。
        if (!isKnownProduct(productId)) {
          return denied('unknown product_id: ' + productId, 400)
        }

        // --- この購読を指す行の鍵を決める ---
        //
        // **クライアントが送ってきた証跡をそのまま鍵にしない。** Playのトークンは
        // 更新しても変わらないのでそのままでよいが、AppleのJWSは更新のたびに
        // 丸ごと変わる。iOSでは originalTransactionId を鍵にする(logic.ts の
        // membershipRowKey に、これを間違えたときに何が壊れるかを書いた)。
        //
        // ここから下は鍵しか見ない。**引くときと入れるときで値が食い違わない**のが
        // 大事で、食い違うとキャッシュも使い回しの検出も永久に効かない。
        //
        // ## iOSでは、ここはまだ関門ではない(WP-3f)
        //
        // この鍵はクライアントのJWSを**署名検証せずに**復号したもので、偽造できる。
        // 早い段階で409を返してAppleへの往復を省くための下見にすぎない。
        // **本当の関門はApple照会のあと**——Appleが答えたIDで鍵を作り直し、
        // そこでもう一度使い回しを見る([verifyWithApple])。
        const rowKey = membershipRowKey(purchaseToken, platform)
        if (rowKey === null) return denied('malformed jws', 400)

        // --- このトークンを他の人が使っていないか ---
        const { data: tokenRows, error: tokenErr } = await supabaseAdmin
          .from('memberships')
          .select('user_id,status,price_id,current_period_end,purchase_token,updated_at')
          .eq('purchase_token', rowKey)
        if (tokenErr) return denied('token lookup failed: ' + tokenErr.message, 500)
        if (tokenTakenByOther(tokenRows, userId)) {
          // 使い回しの防止。正規の乗り換えもここで止まるが、自動で前の
          // アカウントから剥がすことはしない(他人のトークンを申告して奪えてしまう)。
          return denied('purchase token belongs to another account', 409)
        }

        const nowMs = Date.now()
        const mine =
          (tokenRows ?? []).find((r: { user_id?: string | null }) => r.user_id === userId) ??
            null

        // --- 前回の検証が新しければ、それをそのまま返す ---
        // ストア(Google/Apple)への問い合わせ回数の上限も兼ねている。
        // **期限を過ぎた記録はキャッシュにしない**ので、更新日にストア側で
        // 期限が伸びていれば、ここは素通りして聞き直しに行く(logic.ts)。
        if (canUseCache(mine, nowMs)) {
          const active = isRowActive(mine, nowMs)
          console.log(
            '[verify-purchase] cache hit user=' + userId.slice(0, 8) + ' active=' + active,
          )
          return ok(active, productId, mine?.current_period_end ?? null)
        }

        // --- iOS: App Store Server API で照会 ---
        //
        // **Androidと同じ形。** クライアントが送ってきたものは信用せず、権威の
        // サーバー(Apple)に問い合わせて、その答えだけを採用する。
        if (platform === 'ios') {
          return await verifyWithApple({
            userId,
            jws: purchaseToken,
            rowKey,
            productId,
          })
        }

        // --- Google Play Developer API で照会 ---
        // 未設定は空文字に寄せる。secretsConfigured が空も未設定と同じに扱うので、
        // ここから先は「値が入っている」ことが型でも保証される。
        const saKeyRaw = Deno.env.get('GOOGLE_PLAY_SA_KEY') ?? ''
        const packageName = Deno.env.get('ANDROID_PACKAGE_NAME') ?? ''
        // Secrets未設定＝検証できない＝無効。設定を忘れたら素通り、にはしない。
        if (!secretsConfigured(saKeyRaw, packageName)) {
          return denied('GOOGLE_PLAY_SA_KEY/ANDROID_PACKAGE_NAME not configured')
        }

        let accessToken: string
        try {
          accessToken = await getGoogleAccessToken(saKeyRaw)
        } catch (e) {
          return denied('failed to get google token: ' + e)
        }

        const url = API_BASE + '/' + encodeURIComponent(packageName) +
          '/purchases/subscriptionsv2/tokens/' + encodeURIComponent(purchaseToken)
        const googleRes = await fetch(url, {
          headers: { authorization: 'Bearer ' + accessToken },
        })
        if (!googleRes.ok) return denied('google api ' + googleRes.status)

        const sub = await googleRes.json()
        const state = parseSubscription(sub, nowMs)

        // --- acknowledge(3日ルール) ---
        // 購入から3日以内に受領を返さないと、Googleが自動で返金する。
        // クライアントの完了処理に任せると通信断で取りこぼすので、
        // 照会が成功したこの場で済ませる。
        // 失敗しても利用者の権利は落とさない(お金は払われている)。次回の検証で
        // もう一度試される。ログには必ず残す。
        if (state.active && state.needsAcknowledge) {
          await acknowledge(packageName, productId, purchaseToken, accessToken, userId)
        }

        // --- 手で付けた権利があれば、書き戻さない(keepsManualGrant) ---
        const manualPlay = await readManualGrant(userId)
        if (!manualPlay.ok) return denied('manual grant lookup failed: ' + manualPlay.error, 500)
        if (manualPlay.row) {
          console.log('[verify-purchase] manual grant kept user=' + userId.slice(0, 8) +
            ' store_active=' + state.active)
          return ok(true, productId, manualPlay.row.current_period_end ?? null)
        }

        // --- memberships に書き戻す ---
        // status の語彙は既存のまま(active / inactive)。price_id には商品IDを、
        // current_period_end にはGoogleの expiryTime をそのまま入れる。
        const { error: upsertErr } = await supabaseAdmin
          .from('memberships')
          .upsert({
            user_id: userId,
            status: state.active ? 'active' : 'inactive',
            price_id: productId,
            current_period_end: state.expiry,
            // Androidでは rowKey === purchaseToken(logic.ts の membershipRowKey)。
            // 鍵に統一しておくと、引くときと入れるときが構造的に一致する。
            purchase_token: rowKey,
            platform: 'play',
            updated_at: new Date().toISOString(),
          }, { onConflict: 'user_id' })
        if (upsertErr) {
          // 書けなかったのに有効と答えると、次の画面で「非会員」に見える。
          // 保存できないなら無効を返して、状態を食い違わせない。
          return denied('upsert failed: ' + upsertErr.message, 500)
        }

        console.log(
          '[verify-purchase] verified user=' + userId.slice(0, 8) +
            ' product=' + productId + ' active=' + state.active,
        )
        return ok(state.active, productId, state.expiry)
      } catch (e) {
        // 想定外は必ず無効。
        return denied('unexpected error: ' + e)
      }
    },
  ),
}

/**
 * 購入の受領をGoogleに返す。
 *
 * subscriptionsv2 には acknowledge が無いので、v3の定期購入エンドポイント側を叩く
 * (商品IDが要る点だけが照会と違う)。
 * 失敗しても投げない。呼び出し側で権利を落とさないため。
 */
async function acknowledge(
  packageName: string,
  productId: string,
  purchaseToken: string,
  accessToken: string,
  userId: string,
): Promise<void> {
  const ackUrl = API_BASE + '/' + encodeURIComponent(packageName) +
    '/purchases/subscriptions/' + encodeURIComponent(productId) +
    '/tokens/' + encodeURIComponent(purchaseToken) + ':acknowledge'
  try {
    const res = await fetch(ackUrl, {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + accessToken,
        'content-type': 'application/json',
      },
      body: '{}',
    })
    if (!res.ok) {
      console.error(
        '[verify-purchase] acknowledge failed (' + res.status + ') user=' +
          userId.slice(0, 8) + ' — 3日以内に受領されないとGoogleが自動返金する',
      )
      return
    }
    console.log('[verify-purchase] acknowledged user=' + userId.slice(0, 8))
  } catch (e) {
    console.error('[verify-purchase] acknowledge error: ' + e)
  }
}

/**
 * サービスアカウントJSONから、androidpublisher用のアクセストークンを得る。
 * 外部ライブラリを増やさないよう、WebCryptoでRS256署名を自前で作る
 * (レジャー帳の verify-purchase と同じ作り)。
 */
async function getGoogleAccessToken(saKeyRaw: string): Promise<string> {
  const sa = JSON.parse(saKeyRaw)
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'RS256', typ: 'JWT' }
  const claim = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/androidpublisher',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }

  const b64url = (s: string) =>
    btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const unsigned = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(claim))

  const pem = (sa.private_key as string)
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '')
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0))
  const key = await crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sigBuf = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(unsigned),
  )
  const sig = btoa(String.fromCharCode(...new Uint8Array(sigBuf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: unsigned + '.' + sig,
    }),
  })
  if (!res.ok) throw new Error('token endpoint ' + res.status)
  const json = await res.json()
  if (typeof json.access_token !== 'string') throw new Error('no access_token')
  return json.access_token
}

/**
 * App Store Server API で購入を確かめて、memberships に書き戻す。
 *
 * ## Androidと同じ形にしてある
 *
 * クライアントが送ってきたJWSは**信用しない**。そこから transactionId だけを
 * 取り出してAppleへ問い合わせ、**Appleの答えだけを採用する**。
 * Google Play Developer API に purchase_token を投げるのと同じ構図で、
 * フェイルクローズも同じ——Secrets未設定・照会失敗・応答が読めない、はすべて無効。
 *
 * ## acknowledge が無い
 *
 * Playには「3日以内に受領を返さないと自動返金」という決まりがあるが、
 * App Storeにこれに当たるものは無い。だからこの経路には acknowledge 相当の
 * 後始末が要らない(Play側の acknowledge() と対にならないのは、そのため)。
 */
async function verifyWithApple(args: {
  userId: string
  jws: string
  /**
   * 呼び出し元が**クライアントの復号値から**作った鍵。入口の早期409に使った
   * もので、偽造されうる。**保存にも最終判定にも使わない**——この関数は
   * Appleの答えから鍵を作り直す(WP-3f)。ログの突き合わせ用にだけ受け取る。
   */
  rowKey: string
  productId: string
}): Promise<Response> {
  const { userId, jws, rowKey, productId } = args

  const keyId = Deno.env.get('APPLE_KEY_ID') ?? ''
  const issuerId = Deno.env.get('APPLE_ISSUER_ID') ?? ''
  const privateKey = Deno.env.get('APPLE_PRIVATE_KEY') ?? ''
  const bundleId = Deno.env.get('APPLE_BUNDLE_ID') ?? ''
  // Secrets未設定＝検証できない＝無効。Play側とまったく同じ構え。
  if (!appleSecretsConfigured(keyId, issuerId, privateKey, bundleId)) {
    return denied('APPLE_* secrets not configured')
  }

  // **問い合わせるのは transactionId。** originalTransactionId を渡すと初回期間の
  // expiresDate が返り、有効な購読者が expired で締め出される(logic.ts に詳述)。
  const transactionId = transactionIdFromJws(jws)
  if (transactionId === null) return denied('malformed jws', 400)

  let apiToken: string
  try {
    apiToken = await createAppleApiToken({ keyId, issuerId, privateKey, bundleId })
  } catch (e) {
    return denied('failed to sign apple token: ' + e)
  }

  const fetchTx = (base: string) =>
    fetch(base + '/' + encodeURIComponent(transactionId), {
      headers: { authorization: 'Bearer ' + apiToken },
    })

  // 本番 → 届かなければSandbox(並び順の理由は logic.ts に書いた)。
  // **Sandboxへ回るのは APPLE_ALLOW_SANDBOX="true" で、かつこの人が
  // APPLE_SANDBOX_USER_IDS に載っているときだけ**(WP-3f → WP-5で人を絞った)。
  // 載っていない人には、Sandboxを叩きもしない。
  const allowRaw = Deno.env.get('APPLE_ALLOW_SANDBOX')
  const allowSandbox = sandboxAllowedFor(
    allowRaw,
    Deno.env.get('APPLE_SANDBOX_USER_IDS'),
    userId,
  )
  if (sandboxAllowed(allowRaw) && !allowSandbox) {
    // 設定は true なのに、この人はリストに無い。TestFlightのテスターが
    // 買ったのか、審査用アカウントの登録漏れか、をログから見分けられるように残す。
    console.log('[verify-purchase] sandbox not allowed for user=' + userId.slice(0, 8))
  }
  const { res, trace, sandboxStatus } = await fetchAppleTransaction(fetchTx, {
    allowSandbox,
  })
  // **両方のステータスを必ず1行残す。** 片方しか出ないと「本番で止まったのか、
  // Sandboxまで行って駄目だったのか」が分からない。
  console.log('[verify-purchase] apple api ' + trace)
  if (!res.ok) {
    // 本番に無い取引で、この人は Sandbox を見に行けない = TestFlight での購入
    // (公開後バックログ2)。「時間をおいて」と案内しても直らないので、画面で
    // 分けられるように符丁を返す。許可リストへの足しかたは手順書に書いた。
    // 設定として Sandbox を許していて、この人だけが載っていない場合に限る。
    // (設定ごと切っているときは、テスターに足せばよい話ではないので符丁を出さない)
    const sandboxOnly = sandboxAllowed(allowRaw) && !allowSandbox && res.status === 404
    if (sandboxOnly) {
      console.log('[verify-purchase] likely sandbox purchase (not allowlisted) user=' + userId.slice(0, 8))
    }
    return denied('apple api ' + trace, 200, sandboxOnly ? 'sandbox_not_allowed' : undefined)
  }

  // 応答の signedTransactionInfo もJWS。**ここは署名を見なくてよい**——
  // TLSでApple自身から受け取っており、経路が権威を担保している。
  let tx: Record<string, unknown>
  try {
    const payload = await res.json() as { signedTransactionInfo?: unknown } | null
    const signed = payload?.signedTransactionInfo
    if (typeof signed !== 'string') return denied('no signedTransactionInfo')
    const parts = signed.split('.')
    if (parts.length !== 3) return denied('malformed apple jws')
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4))
    tx = JSON.parse(atob(b64 + pad))
  } catch (e) {
    return denied('apple response unreadable: ' + e)
  }

  // --- Appleの答えが、こちらの聞いた取引か ---
  //
  // **ここから先はAppleが言ったことしか使わない。** クライアントが送ってきた
  // JWSは署名を見ていないので、中の値はどれも偽造できる(logic.ts の appleRowKey)。
  if (!appleTransactionMatches(tx, transactionId)) {
    return denied('apple transaction id mismatch')
  }

  // --- Sandbox由来を本番の権利にしない ---
  const source = appleSourceAllowed(tx, {
    fromSandbox: sandboxStatus !== null,
    allowSandbox,
  })
  if (!source.ok) return denied('apple source: ' + source.reason)

  const verdict = entitlementFromAppleTransaction(tx, {
    expectedProductId: productId,
    expectedBundleId: bundleId,
    now: Date.now(),
  })
  // **なぜ無効になったかを残す。** 可否だけだと、bundleIdの取り違えなのか
  // 期限切れなのかがログから分からず、切り分けに実機を往復することになる。
  // 出すのは reason の短い文字列だけで、トークン本文とAppleの応答本体は出さない。
  if (!verdict.isActive) {
    console.log('[verify-purchase] apple verdict=' + verdict.reason)
  }

  // --- 購読としての今の状態を聞く(猶予期間・更新直後のため。公開後バックログ1) ---
  //
  // **聞くのは、取引だけでは無効に見えるときだけ**(security-review 2026-09-17 M2)。
  // この問い合わせは無効を救うためのもので、有効な取引に足すことは無い。毎回聞くと
  // Apple への往復が1回の検証で2回になり、偽の取引を送り続けられると割り当てを削られる。
  //
  // 取引そのものが信用できないとき(他のアプリ・他の商品・返金済み)は聞かない。
  const otxForStatus = appleRowKey(tx)   // = Apple が答えた originalTransactionId
  const askSubscription = otxForStatus !== null && shouldAskSubscriptionStatus(verdict)
  let subscription: { status: 'active' | 'inactive'; currentPeriodEnd: string | null; reason: string } | null = null
  let subscriptionAskFailed = false
  if (askSubscription) {
    const base = subscriptionsBase(sandboxStatus !== null ? 'Sandbox' : 'Production')
    try {
      const statusRes = await fetch(base + '/' + encodeURIComponent(otxForStatus as string), {
        headers: { authorization: 'Bearer ' + apiToken },
        signal: AbortSignal.timeout(APPLE_FETCH_TIMEOUT_MS),
      })
      if (statusRes.ok) {
        const state = stateFromSubscriptionStatuses(await statusRes.json(), {
          originalTransactionId: otxForStatus as string,
          expectedBundleId: bundleId,
          expectedProductId: productId,
          now: Date.now(),
        })
        // 答えは読めたが、その購読の話が無い(not_found)・他のアプリや商品(ignore)。
        // Apple が「無い」と言っているので、取引の判定(無効)のままでよい。
        if (state.kind === 'update') subscription = state.update
        else console.log('[verify-purchase] subscription status not used: ' + state.kind)
      } else {
        subscriptionAskFailed = true
        console.log('[verify-purchase] subscription status ' + statusRes.status)
      }
    } catch (e) {
      subscriptionAskFailed = true
      console.log('[verify-purchase] subscription status failed: ' + String(e))
    }
  }

  // **聞きに行って答えが得られなかったときは、書かない**(security-review 2026-09-17 M1)。
  // ここへ来るのは取引が期限切れに見えているときで、猶予期間かもしれない。
  // 分からないまま inactive を書くと、通知が猶予の期限まで有効にした行を潰してしまう。
  // retryable を返せば、殻は取引を完了させず、次の起動でもう一度検証される。
  if (subscriptionAskFailed && subscription === null) {
    return denied('subscription status unavailable (kept row as is)')
  }

  const entitlement = finalAppleEntitlement(verdict, subscription)
  if (entitlement.source === 'subscription' && entitlement.isActive !== verdict.isActive) {
    // 猶予期間・更新直後など、取引だけを見ていたら取り違えていた場面。
    console.log('[verify-purchase] subscription state wins: ' + verdict.reason + ' -> ' + entitlement.reason)
  }

  // --- 行の鍵を、Appleの答えから作り直す(WP-3f・Vuln 1) ---
  //
  // 呼び出し元が持ってきた rowKey はクライアントの復号値で、偽造できる。
  // **保存するのも、使い回しを見るのも、ここで作った鍵のほう。**
  const appleKey = appleRowKey(tx)
  if (appleKey === null) return denied('apple response has no transaction id')

  // --- その鍵を他の人が使っていないか(**これが本当の関門**) ---
  //
  // 入口でも同じことを見ているが、あちらはクライアントの申告した鍵。
  // 偽の鍵で入口を素通りしてきたものは、ここで初めて本物の鍵と突き合わされる。
  const { data: keyRows, error: keyErr } = await supabaseAdmin
    .from('memberships')
    .select('user_id,purchase_token')
    .eq('purchase_token', appleKey)
  if (keyErr) return denied('apple key lookup failed: ' + keyErr.message, 500)
  if (tokenTakenByOther(keyRows, userId)) {
    return denied('purchase token belongs to another account', 409)
  }

  // --- 手で付けた権利があれば、書き戻さない(Play経路と同じ) ---
  const manualApple = await readManualGrant(userId)
  if (!manualApple.ok) return denied('manual grant lookup failed: ' + manualApple.error, 500)
  if (manualApple.row) {
    console.log('[verify-purchase] manual grant kept(ios) user=' + userId.slice(0, 8) +
      ' store_active=' + entitlement.isActive)
    return ok(true, productId, manualApple.row.current_period_end ?? null)
  }

  // --- memberships に書き戻す(Play経路とまったく同じ形) ---
  const { error: upsertErr } = await supabaseAdmin
    .from('memberships')
    .upsert({
      user_id: userId,
      status: entitlement.isActive ? 'active' : 'inactive',
      price_id: productId,
      current_period_end: entitlement.expiry,
      // **JWS本文も transactionId も入れない。** 前者は長いうえに再取得のたびに
      // 変わり、後者は更新のたびに変わるので、どちらも鍵にすると次回引けない。
      // 入れるのは**Appleが答えた** originalTransactionId(appleKey)。
      purchase_token: appleKey,
      platform: 'ios',
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' })
  if (upsertErr) {
    // 書けなかったのに有効と答えると、次の画面で「非会員」に見える。
    return denied('upsert failed: ' + upsertErr.message, 500)
  }

  if (appleKey !== rowKey) {
    // 正常な利用では一致する。ずれたということは、送られてきたJWSの中身と
    // Appleの答えが食い違っている——偽造の疑いがあるので記録に残す。
    console.log('[verify-purchase] apple key differs from claimed key')
  }
  console.log(
    '[verify-purchase] verified(ios) user=' + userId.slice(0, 8) +
      ' product=' + productId + ' active=' + entitlement.isActive +
      ' by=' + entitlement.source,
  )
  return ok(entitlement.isActive, productId, entitlement.expiry)
}
