// 「本日のデータ更新が遅れている」ことを1通だけ知らせる。
//
// 【なぜ要るのか】
// 朝の通知(send-morning-push)は、data.jsの日付が今日でなければ1通も送らない。
// 間違った情報を届けるよりは黙るほうがまし、という判断で入れた日付ガードだが、
// その結果「更新が遅れた日は何も起きない」ことになる。利用者から見ると
// 出走が無かったのか、届かなかったのかが区別できない。ここを埋める。
//
// 【起動方法】Supabase Cron(pg_cron + pg_net)から 01:15 UTC = 10:15 JST に
// 1日1回叩かれる。朝の便(07:45 / 08:45 / 09:45 JST)とdaily.yml連動便が
// すべて終わったあとの時刻。
//
// 【送る条件】
//   1. その時点で data.js の日付がまだ今日(JST)ではない
//   2. かつ、その日まだこの告知を送っていない(push_notice_log)
// 条件1だけで「朝の便がすべてスキップされた日」を言い表せる。09:50に
// データが届いてCI便が送れていたなら、10:15には日付が今日になっているので
// 条件1が偽になり、告知は出ない。
//
// data.js の取得自体に失敗した場合も「遅れている」として扱う。サイトごと
// 落ちている時に無言になるのが一番困るため。ただし誤報を避けるため、
// 30秒かけて3回試してから判断する。
//
// 【宛先】お気に入りが1件以上、または有効な条件アラートが1件以上ある購読者。
// 無料・プレミアムの区別はしない(これは機能ではなく状況説明のため)。
// お気に入りが0件の人は普段から朝の通知が届かないので、送っても
// 何のことか分からない。だから購読者全員ではなく絞る。
//
// 【起動保護】JWTを持たないCronから叩くため config.toml で verify_jwt = false。
// 代わりに x-cron-secret ヘッダーが CRON_SECRET と一致しなければ401を返す。
// send-morning-push と同じ仕組み・同じ鍵。
import webPush from 'npm:web-push@^3'
import { createClient } from 'npm:@supabase/supabase-js@^2'
import { loadToday, todayJst } from '../_shared/morning-message.ts'

const KIND = 'data_delay'

// 通知の置き換え単位。朝の便(teiyomi-morning)とは別にして、
// 片方が届いたときにもう片方を消してしまわないようにする。
// sw.js 側が payload.tag を見るようになっている必要がある。
const TAG = 'teiyomi-delay'

const TITLE = 'データ更新の遅れ'
const BODY = '本日の出走データがまだ届いていません。今朝のお知らせは送れませんでした。'
// トップページには、データが古いときに出る警告帯(#staleWarn)がある。
// そのまま状況の説明になるので、タップ先はトップにする。
const TAP_URL = 'https://teiyomi.com/'

const VAPID_SUBJECT = 'mailto:mtpworks.info@gmail.com'
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * data.js の日付を読む。読めた場合はその日付、3回試しても読めなければ null。
 * null は「サイトごと落ちている」= 遅れている扱いにする。
 */
async function readDataDate(): Promise<string | null> {
  for (let i = 0; i < 3; i++) {
    try {
      const { date } = await loadToday()
      return date
    } catch (err) {
      console.warn(`[send-delay-notice] data.js を読めませんでした (${i + 1}/3):`, err)
      if (i < 2) await sleep(15_000)
    }
  }
  return null
}

export default {
  async fetch(req: Request): Promise<Response> {
    // ---- 起動保護 ----
    const secret = Deno.env.get('CRON_SECRET')
    if (!secret || req.headers.get('x-cron-secret') !== secret) {
      return new Response('unauthorized', { status: 401 })
    }

    const today = todayJst()

    // ---- 条件1: データがまだ今日のものになっていないか ----
    const dataDate = await readDataDate()
    if (dataDate === today) {
      return Response.json({ sent: 0, skipped: 'data_is_fresh', dataDate })
    }

    // ---- 送り先の組み立て ----
    const { data: subs, error: subErr } = await supabaseAdmin
      .from('push_subscriptions').select('id,user_id,endpoint,p256dh,auth')
    if (subErr) {
      console.error('[send-delay-notice] 購読の取得に失敗:', subErr.message)
      return Response.json({ error: 'subscriptions_failed' }, { status: 500 })
    }
    if (!subs || subs.length === 0) return Response.json({ sent: 0, users: 0, dataDate })

    const userIds = [...new Set(subs.map((s) => s.user_id))]

    const [favRes, alertRes, logRes] = await Promise.all([
      supabaseAdmin.from('favorite_players').select('user_id').in('user_id', userIds),
      supabaseAdmin.from('race_alerts').select('user_id').in('user_id', userIds).eq('enabled', true),
      supabaseAdmin.from('push_notice_log').select('user_id')
        .eq('send_date', today).eq('kind', KIND),
    ])
    if (favRes.error || logRes.error) {
      console.error('[send-delay-notice] 取得に失敗:', favRes.error?.message, logRes.error?.message)
      return Response.json({ error: 'lookup_failed' }, { status: 500 })
    }
    // 条件アラートは無くても告知は出す(お気に入りだけで宛先は決まる)。
    if (alertRes.error) {
      console.warn('[send-delay-notice] 条件アラートを取得できませんでした:', alertRes.error.message)
    }

    // 「朝の通知が届くはずだった人」= お気に入りか条件アラートを持っている人。
    const expecting = new Set<string>()
    for (const f of favRes.data ?? []) expecting.add(f.user_id)
    for (const a of alertRes.data ?? []) expecting.add(a.user_id)

    // ---- 条件2: その日まだ送っていない人だけ ----
    const alreadySent = new Set((logRes.data ?? []).map((r) => r.user_id))

    const subsByUser = new Map<string, typeof subs>()
    for (const s of subs) {
      const list = subsByUser.get(s.user_id) ?? []
      list.push(s)
      subsByUser.set(s.user_id, list)
    }

    const payload = JSON.stringify({ title: TITLE, body: BODY, url: TAP_URL, tag: TAG })

    // ---- 送信 ----
    let sentUsers = 0, sentPush = 0, removed = 0, skippedNoFav = 0, skippedDone = 0

    for (const userId of userIds) {
      if (!expecting.has(userId)) { skippedNoFav++; continue }
      if (alreadySent.has(userId)) { skippedDone++; continue }

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
            // 購読が失効・解除された。残しておくと毎回失敗し続けるので消す。
            await supabaseAdmin.from('push_subscriptions').delete().eq('id', s.id)
            removed++
          } else {
            console.error(`[send-delay-notice] 送信失敗 (user=${userId}, code=${code}):`, err)
          }
        }
      }

      if (ok) {
        sentUsers++
        const { error } = await supabaseAdmin.from('push_notice_log')
          .upsert({ send_date: today, kind: KIND, user_id: userId },
                  { onConflict: 'send_date,kind,user_id' })
        if (error) {
          console.error(`[send-delay-notice] 送信記録に失敗 (user=${userId}):`, error.message)
        }
      }
    }

    const summary = {
      date: today, dataDate, users: userIds.length, sentUsers, sentPush,
      removedSubscriptions: removed, skippedNoFavorites: skippedNoFav,
      skippedAlreadySent: skippedDone,
    }
    console.log('[send-delay-notice]', JSON.stringify(summary))
    return Response.json(summary)
  },
}
