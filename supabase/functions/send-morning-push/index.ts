// 毎朝、お気に入り選手が本日出走する人にだけ通知を1通送る。
//
// 【起動方法】Supabase Cron(pg_cron + pg_net)から、1日3回叩かれる。
//   22:45 UTC = 07:45 JST … 本便(daily.ymlが07:30にdata.jsを作った直後の想定)
//   23:45 UTC = 08:45 JST … 再挑戦便
//   00:45 UTC = 09:45 JST … 再挑戦便(2026-07-29に追加)
// 2回目以降で二重に届かないよう、送信できた人を push_send_log に記録し、
// 同じ日に既に記録がある人は飛ばす。
//
// 【なぜ再挑戦便が要るのか】
// data.jsを作るGitHub Actionsのスケジュールは遅延・欠落する(実測で1時間遅れる日がある)。
// 07:45の時点で前日のdata.jsしか無い日が常態化しており、実質は08:45便が本番として
// 効いている。ここを直す本筋は「データ公開後にCI側から叩く」形にすること。
//
// 【起動保護】この関数はJWTを持たないCronから叩くため、config.tomlで
// verify_jwt = false にしている。代わりに x-cron-secret ヘッダーが
// CRON_SECRET と一致しなければ何もせず401を返す。
//
// 【日付ガード(重要)】
// 出走情報は https://teiyomi.com/data.js から取る。毎朝07:30の更新が
// 失敗・遅延すると前日のdata.jsが残るため、そのまま送ると「昨日の出走表」を
// 今日の予定として通知してしまう。データの日付が今日(JST)でなければ
// 1通も送らずに終了する。届かないことより、間違った情報が届くことのほうが
// 害が大きい、という判断。
//
// 【文面】組み立ては _shared/morning-message.ts に集約している
// (テスト送信と同じ文面を使うため)。プレミアムの人だけ、選手ごとに
// 「見どころ」を最大1つ添える。
import webPush from 'npm:web-push@^3'
import { createClient } from 'npm:@supabase/supabase-js@^2'
import {
  buildMessage, loadFrames, loadNightVenues, loadToday, matchAlerts, todayJst,
  type Alert, type Entry,
} from '../_shared/morning-message.ts'

const ACTIVE_STATUSES = ['active', 'trialing']
const VAPID_SUBJECT = 'mailto:mtpworks.info@gmail.com'
// 公開鍵は秘密ではないので直書きする。環境変数にすると、フロント(favorites.js)と
// 食い違ったときに「購読はできるのに届かない」という原因の分かりにくい壊れ方を
// するため、両方に同じ値を書いて突き合わせやすくしておく。
const VAPID_PUBLIC_KEY =
  'BE4DAw7wz7PEwrbNxhXQEtzbsndFFBaoTeVYGAS-RWr3FS1_xkNsHgH2zUxgiJmeOKBuDcz1bbmLSIx-NqnB1zE'

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
  async fetch(req: Request): Promise<Response> {
    // ---- 起動保護 ----
    const secret = Deno.env.get('CRON_SECRET')
    if (!secret || req.headers.get('x-cron-secret') !== secret) {
      return new Response('unauthorized', { status: 401 })
    }

    const today = todayJst()

    // ---- 日付ガード ----
    let todayData
    try {
      todayData = await loadToday()
    } catch (err) {
      console.error('[send-morning-push] data.js を読めませんでした:', err)
      return Response.json({ sent: 0, skipped: 'data_unavailable' }, { status: 500 })
    }
    if (todayData.date !== today) {
      console.warn(
        `[send-morning-push] data.jsの日付(${todayData.date})が今日(${today})ではないため送信しません。`,
      )
      return Response.json({ sent: 0, skipped: 'stale_data', dataDate: todayData.date })
    }

    // 枠の見どころ用。読めなくても通知自体は出す(その材料を使わないだけ)。
    // ナイター/デイの区分は5bと同じ判定(meta.json)を使う。読めなければ
    // 開催区分を指定した条件だけが一致しなくなる(他の条件は普通に効く)。
    const [frames, nightVenues] = await Promise.all([loadFrames(), loadNightVenues()])

    // ---- 送り先の組み立て ----
    const { data: subs, error: subErr } = await supabaseAdmin
      .from('push_subscriptions').select('id,user_id,endpoint,p256dh,auth')
    if (subErr) {
      console.error('[send-morning-push] 購読の取得に失敗:', subErr.message)
      return Response.json({ error: 'subscriptions_failed' }, { status: 500 })
    }
    if (!subs || subs.length === 0) return Response.json({ sent: 0, users: 0 })

    const userIds = [...new Set(subs.map((s) => s.user_id))]

    // 購読者ぶんだけまとめて引く(利用者が数千規模になったら分割が必要)。
    const [favRes, memRes, logRes, alertRes] = await Promise.all([
      supabaseAdmin.from('favorite_players').select('user_id,toban,created_at')
        .in('user_id', userIds).order('created_at', { ascending: true }),
      supabaseAdmin.from('memberships').select('user_id,status').in('user_id', userIds),
      supabaseAdmin.from('push_send_log').select('user_id').eq('send_date', today),
      // 条件アラート。有効なものだけ。テーブルがまだ無い環境でも朝の便を
      // 止めないよう、ここのエラーは致命的に扱わない(下でnull扱いにする)。
      supabaseAdmin.from('race_alerts').select('id,user_id,toban,cond,label')
        .in('user_id', userIds).eq('enabled', true),
    ])
    if (favRes.error || memRes.error || logRes.error) {
      console.error('[send-morning-push] 取得に失敗:',
        favRes.error?.message, memRes.error?.message, logRes.error?.message)
      return Response.json({ error: 'lookup_failed' }, { status: 500 })
    }
    if (alertRes.error) {
      console.warn('[send-morning-push] 条件アラートを取得できませんでした:', alertRes.error.message)
    }

    const premium = new Set(
      (memRes.data ?? []).filter((m) => ACTIVE_STATUSES.includes(m.status)).map((m) => m.user_id),
    )
    const alreadySent = new Set((logRes.data ?? []).map((r) => r.user_id))

    // お気に入りは created_at の昇順で来ているので、無料プランの「先頭3名」は
    // 登録が古い順になる(利用者から見て理由が分かる並び)。
    const favByUser = new Map<string, string[]>()
    for (const f of favRes.data ?? []) {
      const list = favByUser.get(f.user_id) ?? []
      list.push(f.toban)
      favByUser.set(f.user_id, list)
    }

    const alertsByUser = new Map<string, Alert[]>()
    for (const a of (alertRes.data ?? []) as Alert[]) {
      const list = alertsByUser.get(a.user_id) ?? []
      list.push(a)
      alertsByUser.set(a.user_id, list)
    }

    const subsByUser = new Map<string, typeof subs>()
    for (const s of subs) {
      const list = subsByUser.get(s.user_id) ?? []
      list.push(s)
      subsByUser.set(s.user_id, list)
    }

    // ---- 送信 ----
    let sentUsers = 0, sentPush = 0, removed = 0, skippedNoRace = 0, skippedDone = 0
    let alertUsers = 0   // 条件アラートが1件以上当たった人数(効きを見るための記録)

    for (const userId of userIds) {
      if (alreadySent.has(userId)) { skippedDone++; continue }

      const matched: Entry[] = []
      for (const toban of favByUser.get(userId) ?? []) {
        const entry = todayData.byToban.get(toban)
        if (entry) matched.push(entry)
      }

      // 保存した条件に当てはまる本日の出走(プレミアムのみ)。
      const isPremium = premium.has(userId)
      const hits = isPremium
        ? matchAlerts(alertsByUser.get(userId) ?? [], todayData.allByToban, today, nightVenues)
        : []
      if (hits.length > 0) alertUsers++

      // 出走が無い日は送らない。毎朝「今日はいません」が届くほうが煩わしい。
      // 条件に一致していれば、お気に入りの出走が無くても知らせる。
      if (matched.length === 0 && hits.length === 0) { skippedNoRace++; continue }

      const payload = JSON.stringify(
        buildMessage(matched, { premium: isPremium, frames, alerts: hits }),
      )

      let ok = false
      for (const s of subsByUser.get(userId) ?? []) {
        try {
          await webPush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            payload,
          )
          ok = true
          sentPush++
        } catch (err) {
          const code = (err as { statusCode?: number }).statusCode
          if (code === 404 || code === 410) {
            // 購読が失効・解除された。残しておくと毎朝失敗し続けるので消す。
            await supabaseAdmin.from('push_subscriptions').delete().eq('id', s.id)
            removed++
          } else {
            console.error(`[send-morning-push] 送信失敗 (user=${userId}, code=${code}):`, err)
          }
        }
      }

      if (ok) {
        sentUsers++
        const { error } = await supabaseAdmin.from('push_send_log')
          .upsert({ send_date: today, user_id: userId }, { onConflict: 'send_date,user_id' })
        if (error) {
          // ここで書けないと2回目の便で重複して届く。落ちはしないが記録は残す。
          console.error(`[send-morning-push] 送信記録に失敗 (user=${userId}):`, error.message)
        }
      }
    }

    const summary = {
      date: today, users: userIds.length, sentUsers, sentPush,
      removedSubscriptions: removed, skippedNoRace, skippedAlreadySent: skippedDone,
      framesLoaded: !!frames,
      alerts: (alertRes.data ?? []).length, alertUsers, nightVenuesLoaded: !!nightVenues,
    }
    console.log('[send-morning-push]', JSON.stringify(summary))
    return Response.json(summary)
  },
}
