// Google Play の定期購入を検証して、memberships を書き換える(タスク③)。
//
// アプリ(TWA)内で購入すると purchaseToken が手に入る。それをこの関数に渡し、
// Google Play Developer API で「本当に買われていて、いま有効か」を確かめてから
// memberships に書き込む。クライアントが言ってきた内容は一切信用しない。
//
// ## フェイルクローズ
// 「有効」と答えるのは、Googleが明示的に有効と答えた場合だけ。それ以外
// (Secrets未設定・認証不備・Google照会失敗・応答が読めない・例外)は
// **すべて is_active:false を返す**。疑わしきは無効。
// GOOGLE_PLAY_SA_KEY を設定するまで、この関数は誰もプレミアムにしない。
// 商品登録前の今はそれが正しい挙動。
//
// ## なぜ呼び出し元チェックが共有キーではなくJWTなのか
// レジャー帳の同名関数は X-Client-Key(アプリの.envに載る値)で入口を絞っている。
// あれはアカウントを持たないアプリなので、それ以上の手が無かった。
// 艇読みはSupabaseのアカウントがあるので、**JWTそのものを認証に使う**。
// 誰が呼んだかが確実に分かるうえ、書き込む先も必ずその本人の行だけになる。
// 共有キーのようにAPKから抜き出せる値でもない。
//
// ## デプロイ
//   supabase functions deploy verify-purchase
//   supabase secrets set GOOGLE_PLAY_SA_KEY="$(cat service-account.json)"
//   supabase secrets set ANDROID_PACKAGE_NAME=com.mtpworks.teiyomi
// サービスアカウントのJSONは絶対にこのリポジトリに置かないこと
// (mainがGitHub Pagesでそのまま公開されるため)。
import { withSupabase } from 'npm:@supabase/server@^1'
import { createClient } from 'npm:@supabase/supabase-js@^2'
import {
  canUseCache,
  isKnownProduct,
  isRowActive,
  parseSubscription,
  secretsConfigured,
  tokenTakenByOther,
} from './logic.ts'

const JSON_HEADERS = { 'content-type': 'application/json' }
const API_BASE = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications'

const supabaseAdmin = createClient(
  Deno.env.get('SUPABASE_URL') as string,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') as string,
  { auth: { persistSession: false } },
)

/** 無効を返す。理由はログにだけ出し、呼び出し元には返さない(手がかりを与えない)。 */
function denied(reason: string, status = 200): Response {
  console.log('[verify-purchase] denied: ' + reason)
  return new Response(JSON.stringify({ is_active: false }), {
    status,
    headers: JSON_HEADERS,
  })
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
    async (req: Request, ctx: { userClaims?: Record<string, unknown> }) => {
      try {
        if (req.method !== 'POST') return denied('method not allowed', 405)

        const userId = ctx.userClaims?.id as string | undefined
        if (!userId) return denied('unauthorized', 401)

        // 匿名アカウントには課金させない。購入はメールで本人確認済みの
        // アカウントに紐づける(端末を変えたときに引き継げるようにするため)。
        if (ctx.userClaims?.is_anonymous) return denied('anonymous user', 403)

        let body: Record<string, unknown>
        try {
          body = await req.json()
        } catch {
          return denied('invalid json', 400)
        }
        const purchaseToken = body.purchase_token
        const productId = body.product_id

        if (
          typeof purchaseToken !== 'string' || purchaseToken.length === 0 ||
          purchaseToken.length > 4096 || typeof productId !== 'string'
        ) {
          return denied('invalid parameters', 400)
        }
        // 身に覚えのない商品IDはGoogleに問い合わせもしない。
        if (!isKnownProduct(productId)) {
          return denied('unknown product_id: ' + productId, 400)
        }

        // --- このトークンを他の人が使っていないか ---
        const { data: tokenRows, error: tokenErr } = await supabaseAdmin
          .from('memberships')
          .select('user_id,status,price_id,current_period_end,purchase_token,updated_at')
          .eq('purchase_token', purchaseToken)
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
        // Googleへの問い合わせ回数の上限も兼ねている。期限は is_premium() 側でも
        // 見ているので、キャッシュを返しても期限切れの人が通ることはない。
        if (canUseCache(mine, nowMs)) {
          const active = isRowActive(mine, nowMs)
          console.log(
            '[verify-purchase] cache hit user=' + userId.slice(0, 8) + ' active=' + active,
          )
          return ok(active, productId, mine?.current_period_end ?? null)
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
            purchase_token: purchaseToken,
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
