// Stripeの「カスタマーポータル」へのセッションを作成する。
// 解約・カードの変更・請求書の確認はすべてStripe側の画面に任せ、
// 艇読み側では一切実装しない(自作するほど事故が増えるため)。
//
// フロントエンド(premium/index.html)は、Supabaseのアクセストークンを
// Authorizationヘッダーに付けてこのFunctionをfetchし、返ってきたurlへ
// リダイレクトするだけでよい。
import { withSupabase } from 'npm:@supabase/server@^1'
import { createClient } from 'npm:@supabase/supabase-js@^2'
import Stripe from 'npm:stripe@^22'

const RETURN_URL = 'https://teiyomi.com/premium/'

// 秘密鍵はSupabase管理画面の環境変数に登録する。コード・リポジトリには書かない。
const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') as string)

// membershipsの読み取りは、service roleの管理者クライアントで
// 「user_idが本人の行」だけを明示的に引く。
// (RLS任せのユーザースコープclientでも読めるが、そちらはpublishableキーの
//  環境変数に依存するため、キー名の違いで動かなくなる余地を残さない。
//  本人のuser_idで絞っているので、他人の行が返ることはない。)
const supabaseAdmin = createClient(
  Deno.env.get('SUPABASE_URL') as string,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') as string,
  { auth: { persistSession: false, autoRefreshToken: false } },
)

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
      // auth: 'user' により、ここに来た時点でJWTの検証は済んでいる。
      const userId = ctx.userClaims?.id
      if (!userId) {
        return Response.json({ error: 'unauthorized' }, { status: 401 })
      }

      const { data, error } = await supabaseAdmin
        .from('memberships')
        .select('stripe_customer_id')
        .eq('user_id', userId)
        .limit(1)

      if (error) {
        console.error('[create-portal-session] memberships select failed:', error.message)
        return Response.json({ error: 'membership_lookup_failed' }, { status: 500 })
      }

      const customerId = data?.[0]?.stripe_customer_id
      if (!customerId) {
        // 一度も決済していない/Webhookがまだ届いていない。
        return Response.json({ error: 'membership_not_found' }, { status: 404 })
      }

      try {
        const session = await stripe.billingPortal.sessions.create({
          customer: customerId,
          return_url: RETURN_URL,
        })
        return Response.json({ url: session.url })
      } catch (err) {
        console.error('[create-portal-session] Stripe error:', err)
        return Response.json({ error: 'portal_session_failed' }, { status: 500 })
      }
    },
  ),
}
