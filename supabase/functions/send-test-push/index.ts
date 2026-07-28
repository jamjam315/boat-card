// 自分の購読にだけ、今すぐテスト通知を送る。
//
// 朝の便(send-morning-push)を待たずに「実機にちゃんと届くか」「文面がどう見えるか」を
// 確かめるための口。ログイン(JWT)必須で、送り先は呼び出した本人の購読だけ。
// 他人には送れない。
//
// 本番の朝と同じ組み立て(_shared/morning-message.ts)を使うので、届く文面は本番と同じ。
// お気に入りが今日走らない日は、文面の確認ができるようダミーの1件で送る。
//
// 【?premium=1 について】
// プレミアム版の文面(見どころつき)を確認するための上書き。**この関数を明示的に
// 叩いたときだけ**効き、朝のCron便(send-morning-push)には一切影響しない。
// 契約が無い状態でも「プレミアムだとこう見える」を実機で確かめられるようにするため。
//
// 使い方(通知をオンにしたページのコンソールから):
//   const c = TeiyomiAuth.getConfig(), t = await TeiyomiAuth.getAccessToken();
//   await fetch(c.url + '/functions/v1/send-test-push?premium=1', {
//     method: 'POST', headers: { Authorization: 'Bearer ' + t, apikey: c.anonKey }
//   }).then(r => r.json());
import { withSupabase } from 'npm:@supabase/server@^1'
import webPush from 'npm:web-push@^3'
import { createClient } from 'npm:@supabase/supabase-js@^2'
import {
  buildMessage, loadFrames, loadToday, type Entry,
} from '../_shared/morning-message.ts'

const ACTIVE_STATUSES = ['active', 'trialing']
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

/** お気に入りが今日走らないときでも文面を確認できるよう、見本の1件を作る。 */
function sampleEntry(): Entry {
  return {
    toban: '0000', name: '（見本）艇読 太郎', venue: '住之江', race: 5,
    deadline: '11:20', frame: 1, localRate: 6.9, nationalRate: 6.1,
    localStarts: 80, motorRate: 46,
  }
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
    async (req, ctx) => {
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

      // 契約状態は本番と同じ判定を使い、?premium=1 のときだけ上書きする。
      const { data: mem } = await supabaseAdmin
        .from('memberships').select('status').eq('user_id', userId).limit(1)
      const realPremium = ACTIVE_STATUSES.includes(mem?.[0]?.status ?? '')
      const forced = new URL(req.url).searchParams.get('premium') === '1'
      const premium = realPremium || forced

      // 本番と同じ材料で組み立てる。お気に入りが今日走らなければ見本で代用。
      const [today, frames] = await Promise.all([
        loadToday().catch(() => null), loadFrames(),
      ])
      const { data: favs } = await supabaseAdmin
        .from('favorite_players').select('toban,created_at')
        .eq('user_id', userId).order('created_at', { ascending: true })

      const matched: Entry[] = []
      if (today) {
        for (const f of favs ?? []) {
          const e = today.byToban.get(f.toban)
          if (e) matched.push(e)
        }
      }
      const usedSample = matched.length === 0
      if (usedSample) matched.push(sampleEntry())

      const message = buildMessage(matched, { premium, frames })
      const payload = JSON.stringify({
        ...message,
        title: `[テスト] ${message.title}`,
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
      return Response.json({
        sent, removedSubscriptions: removed,
        premium, forcedPremium: forced, usedSampleEntry: usedSample,
        preview: message,
      })
    },
  ),
}
