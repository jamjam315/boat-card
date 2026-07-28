// 自分の購読にだけ、今すぐテスト通知を送る。
//
// 朝の便(send-morning-push)を待たずに「実機にちゃんと届くか」を確かめるための口。
// ログイン(JWT)必須で、送り先は呼び出した本人の購読だけ。他人には送れない。
//
// 使い方(ブラウザのコンソールから。通知をオンにしたページで):
//   const t = await TeiyomiAuth.getAccessToken();
//   await fetch(TeiyomiAuth.getConfig().url + '/functions/v1/send-test-push', {
//     method: 'POST',
//     headers: { Authorization: 'Bearer ' + t, apikey: TeiyomiAuth.getConfig().anonKey }
//   }).then(r => r.json());
import { withSupabase } from 'npm:@supabase/server@^1'
import webPush from 'npm:web-push@^3'
import { createClient } from 'npm:@supabase/supabase-js@^2'

const VAPID_SUBJECT = 'mailto:mtpworks.info@gmail.com'
// 公開鍵は秘密ではないので直書きする(favorites.js・send-morning-pushと同じ値)。
const VAPID_PUBLIC_KEY =
  'BE4DAw7wz7PEwrbNxhXQEtzbsndFFBaoTeVYGAS-RWr3FS1_xkNsHgH2zUxgiJmeOKBuDcz1bbmLSIx-NqnB1zE'

// 購読の取り出しはservice roleで行うが、必ず本人のuser_idで絞る。
const supabaseAdmin = createClient(
  Deno.env.get('SUPABASE_URL') as string,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') as string,
  { auth: { persistSession: false, autoRefreshToken: false } },
)

webPush.setVapidDetails(
  VAPID_SUBJECT,
  VAPID_PUBLIC_KEY,
  Deno.env.get('VAPID_PRIVATE_KEY') as string,
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
      const userId = ctx.userClaims?.id
      if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 })

      const { data: subs, error } = await supabaseAdmin
        .from('push_subscriptions').select('id,endpoint,p256dh,auth').eq('user_id', userId)
      if (error) {
        console.error('[send-test-push] 購読の取得に失敗:', error.message)
        return Response.json({ error: 'lookup_failed' }, { status: 500 })
      }
      if (!subs || subs.length === 0) {
        return Response.json({ error: 'no_subscription' }, { status: 404 })
      }

      const payload = JSON.stringify({
        title: 'テスト通知',
        body: '艇読みからの通知はこのように届きます。朝の本番はお気に入り選手の出走をお知らせします。',
        url: 'https://teiyomi.com/',
      })

      let sent = 0, removed = 0
      for (const s of subs) {
        try {
          await webPush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload,
          )
          sent++
        } catch (err) {
          const code = (err as { statusCode?: number }).statusCode
          if (code === 404 || code === 410) {
            await supabaseAdmin.from('push_subscriptions').delete().eq('id', s.id)
            removed++
          } else {
            console.error(`[send-test-push] 送信失敗 (code=${code}):`, err)
          }
        }
      }
      return Response.json({ sent, removedSubscriptions: removed })
    },
  ),
}
