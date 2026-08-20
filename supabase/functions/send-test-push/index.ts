// 自分の購読にだけ、今すぐテスト通知を送る。
//
// 朝の便(send-morning-push)を待たずに「実機にちゃんと届くか」「文面がどう見えるか」を
// 確かめるための口。ログイン(JWT)必須で、送り先は呼び出した本人の購読だけ。
// 他人には送れない。
//
// 本番の朝と同じ組み立て(_shared/morning-message.ts)を使うので、届く文面は本番と同じ。
// お気に入りが今日走らない日は、文面の確認ができるようダミーの1件で送る。
//
// 【?free=1 について】
// 契約者が「無料プランだとこう見える」を確かめるための口。**この関数を明示的に
// 叩いたときだけ**効き、朝のCron便(send-morning-push)には一切影響しない。
// もらえるものが減る方向にしか働かないので、有料機能の迂回には使えない。
// (以前あった ?premium=1 は、未契約でもプレミアムの文面と条件アラートの照合結果を
//  取れてしまうため、2026-08-01の監査を受けて廃止した)
//
// 使い方(通知をオンにしたページのコンソールから):
//   const c = TeiyomiAuth.getConfig(), t = await TeiyomiAuth.getAccessToken();
//   await fetch(c.url + '/functions/v1/send-test-push', {
//     method: 'POST', headers: { Authorization: 'Bearer ' + t, apikey: c.anonKey }
//   }).then(r => r.json());
//   // 無料プランの文面を見たいときは URL の末尾に ?free=1 を付ける
import { withSupabase } from 'npm:@supabase/server@^1'
import webPush from 'npm:web-push@^3'
import { createClient } from 'npm:@supabase/supabase-js@^2'
import {
  buildMessage, loadFrames, loadNightVenues, loadToday, matchAlerts, todayJst,
  type Alert, type Entry,
} from '../_shared/morning-message.ts'

const ACTIVE_STATUSES = ['active', 'trialing']

/**
 * 契約中かどうか。statusだけでなく期限も見る。
 *
 * statusを書き戻す担当が止まっても、current_period_endを過ぎれば自動的に
 * 権利が切れるようにしておくための保険(緩む側ではなく締まる側に倒す)。
 * 期限がnullのときは「切れている」ではなく「記録が無い」なので有効扱いにする。
 *
 * 同じ判定が is_premium()(RLS)・membership.js・send-morning-push にもある。
 * 直すときは4か所そろえること。
 */
function isActive(m: { status?: string | null; current_period_end?: string | null }): boolean {
  if (!ACTIVE_STATUSES.includes(m.status ?? '')) return false
  if (!m.current_period_end) return true
  const t = new Date(m.current_period_end).getTime()
  if (Number.isNaN(t)) return true
  return t > Date.now()
}
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

      // 契約状態は本番とまったく同じ判定を使う。上書きの余地は残さない。
      //
      // 【?premium=1 を廃止した理由(2026-08-01の監査)】
      // 以前は ?premium=1 で契約が無くてもプレミアムの文面を作れるようにしていた。
      // 「プレミアムだとこう見える」を実機で確かめるための口だったが、この関数は
      // ログインしていれば誰でも呼べるため、未契約の人がプレミアムの文面と
      // 条件アラートの照合結果を取れる状態になっていた(有料機能の実質的な迂回)。
      // 呼び出し方はこのファイルの冒頭コメントに手順まで書いてある。
      //
      // 逆向きの ?free=1 は残す。これは「上を見る」ではなく「下を見る」ための口で、
      // 契約者が無料プランの文面を確認するのに使う。もらえるものが減るだけなので
      // 迂回にはならない。
      const { data: mem } = await supabaseAdmin
        .from('memberships').select('status,current_period_end')
        .eq('user_id', userId).limit(1)
      const realPremium = isActive(mem?.[0] ?? {})
      const asFree = new URL(req.url).searchParams.get('free') === '1'
      const premium = realPremium && !asFree

      // 本番と同じ材料で組み立てる。お気に入りが今日走らなければ見本で代用。
      const [today, frames, nightVenues] = await Promise.all([
        loadToday().catch(() => null), loadFrames(), loadNightVenues(),
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
      // 条件アラートも本番と同じ関数で照合する(文面のズレを作らないため)。
      // 未契約のときは照合そのものを行わない。buildMessage 側でも弾いているが、
      // この関数は照合結果を戻り値(alertRaces)でも返すため、ここで止めないと
      // 通知に出ないだけで中身は取れてしまう。
      const alerts = premium
        ? (await supabaseAdmin
            .from('race_alerts').select('id,user_id,toban,cond,label')
            .eq('user_id', userId).eq('enabled', true)).data
        : null
      const hits = (premium && today)
        ? matchAlerts((alerts ?? []) as Alert[], today.allByToban, todayJst(), nightVenues)
        : []

      const usedSample = matched.length === 0
      if (usedSample) matched.push(sampleEntry())

      const message = buildMessage(matched, { premium, frames, alerts: hits })
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
        premium, realPremium, viewedAsFree: asFree, usedSampleEntry: usedSample,
        alerts: (alerts ?? []).length, alertHits: hits.length,
        alertRaces: hits.map((e) => `${e.venue}${e.race}R ${e.deadline} ${e.name}`),
        preview: message,
      })
    },
  ),
}
