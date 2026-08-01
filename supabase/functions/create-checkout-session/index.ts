// Stripeの月額課金(サブスクリプション)を開始するためのCheckout Sessionを作成する。
// 価格は必ずサーバー側(このFunction)で決定し、クライアントからは受け取らない
// (価格改ざん防止)。フロントエンドはSupabaseのアクセストークンを
// Authorizationヘッダーに付けてこのFunctionをfetchし、返ってきたurlへ
// リダイレクトするだけでよい。
import { withSupabase } from 'npm:@supabase/server@^1'
import { createClient } from 'npm:@supabase/supabase-js@^2'
import Stripe from 'npm:stripe@^22'

// 早期割引の締切(価格はprice_1Tx6aLFQRHrvqUlHax6dWnD6=¥300)。
// TODO: 公開日確定後に正式な日付へ設定する。
const EARLY_BIRD_UNTIL = '2027-01-31'

const EARLY_BIRD_PRICE_ID = 'price_1Tx6aLFQRHrvqUlHax6dWnD6' // ¥300/月
const REGULAR_PRICE_ID = 'price_1Tx6WWFQRHrvqUlHuUizm74o' // ¥500/月

const SUCCESS_URL = 'https://teiyomi.com/premium/success.html?session_id={CHECKOUT_SESSION_ID}'
const CANCEL_URL = 'https://teiyomi.com/premium/'

// 秘密鍵はSupabase管理画面の環境変数に登録する(工程4)。コード・リポジトリには書かない。
const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') as string)

// 有料機能を使える状態(membership.jsのACTIVE_STATUSESと同じ定義)。
// この状態の人に新しい支払い手続きを始めさせない = 二重契約・二重請求を防ぐ。
const ACTIVE_STATUSES = ['active', 'trialing']

// membershipsの読み取りは、service roleの管理者クライアントで
// 「user_idが本人の行」だけを明示的に引く(create-portal-sessionと同じ方針)。
const supabaseAdmin = createClient(
  Deno.env.get('SUPABASE_URL') as string,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') as string,
  { auth: { persistSession: false, autoRefreshToken: false } },
)

/** 現在時刻がEARLY_BIRD_UNTIL(JSTの日付・終日まで)以前かどうかで価格を決める。 */
function resolvePriceId(now: Date): string {
  const cutoff = new Date(`${EARLY_BIRD_UNTIL}T23:59:59+09:00`)
  return now.getTime() <= cutoff.getTime() ? EARLY_BIRD_PRICE_ID : REGULAR_PRICE_ID
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
    async (_req, ctx) => {
      // auth: 'user' により、ここに来た時点でJWTの検証は済んでいる(未認証は
      // withSupabaseが自動的に401を返し、このハンドラは呼ばれない)。
      const { userClaims } = ctx

      // 匿名アカウント(お気に入りローカル利用のみ等)はemailを持たない。
      // 課金にはメール送付先が必須のため、先にログイン(メールアドレス登録)を促す。
      if (!userClaims?.email) {
        return Response.json({ error: 'email_required' }, { status: 403 })
      }

      // 既に契約中の人に、新しい支払い手続きを始めさせない。
      // 画面側でも「ご契約中」を出して隠しているが、画面の出し分けは
      // 見た目の話でしかなく、直接このFunctionを叩けば素通りしてしまう。
      // 二重請求は取り返しがつかないので、サーバー側でも必ず確かめる。
      const { data: rows, error: lookupError } = await supabaseAdmin
        .from('memberships')
        .select('status,stripe_customer_id')
        .eq('user_id', userClaims.id)
        .limit(1)

      if (lookupError) {
        // 確かめられないまま進めると二重契約になりうるため、ここは止める側に倒す。
        console.error('[create-checkout-session] memberships select failed:', lookupError.message)
        return Response.json({ error: 'membership_lookup_failed' }, { status: 500 })
      }

      const membership = rows?.[0]
      if (membership && ACTIVE_STATUSES.includes(membership.status)) {
        return Response.json({ error: 'already_subscribed' }, { status: 409 })
      }

      const priceId = resolvePriceId(new Date())

      // 解約後に再契約する人は、Stripe側の顧客を作り直さず前と同じものを使う
      // (支払い履歴が1人に紐づいたままになり、管理画面で追いやすい)。
      const customerId = membership?.stripe_customer_id || null

      try {
        const session = await stripe.checkout.sessions.create({
          mode: 'subscription',
          line_items: [{ price: priceId, quantity: 1 }],
          client_reference_id: userClaims.id,
          metadata: { user_id: userClaims.id },
          // customerとcustomer_emailは同時に渡せない。既存の顧客がいればそちらを優先する。
          ...(customerId ? { customer: customerId } : { customer_email: userClaims.email }),
          success_url: SUCCESS_URL,
          cancel_url: CANCEL_URL,
        })

        return Response.json({ url: session.url })
      } catch (err) {
        console.error('[create-checkout-session] Stripe error:', err)
        return Response.json({ error: 'checkout_session_failed' }, { status: 500 })
      }
    },
  ),
}
