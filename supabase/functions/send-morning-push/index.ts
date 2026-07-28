// 毎朝、お気に入り選手が本日出走する人にだけ通知を1通送る。
//
// 【起動方法】Supabase Cron(pg_cron + pg_net)から、1日2回叩かれる。
//   22:45 UTC = 07:45 JST … 本便(daily.ymlが07:30にdata.jsを作った直後)
//   23:45 UTC = 08:45 JST … 再挑戦便(1回目が失敗したとき用)
// 2回目で二重に届かないよう、送信できた人を push_send_log に記録し、
// 同じ日に既に記録がある人は飛ばす。
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
// 【なぜGitHub ActionsではなくEdge Functionなのか】
// 送信には全ユーザーの購読・お気に入り・契約状態を読む必要があり、
// service roleキーが要る。GitHub側にもその鍵を置くと、いちばん強い鍵の
// 置き場所が増えてしまう。data.jsは公開URLなのでSupabase内から取れる。
import webPush from 'npm:web-push@^3'
import { createClient } from 'npm:@supabase/supabase-js@^2'

const DATA_URL = 'https://teiyomi.com/data.js'
const SITE_URL = 'https://teiyomi.com/'
const FREE_LIMIT = 3                       // 無料プランで通知する人数の上限
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

/** 今日(JST)の YYYY-MM-DD。端末やサーバーのタイムゾーンに依存させない。 */
function todayJst(): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
}

/** data.js の "2026年7月28日" を "2026-07-28" にする。読めなければnull。 */
function parseDataDate(label: unknown): string | null {
  if (typeof label !== 'string') return null
  const m = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(label.trim())
  if (!m) return null
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
}

type Entry = { name: string; venue: string; race: number; deadline: string }

/** data.js を取ってきて、登番 → 本日の出走(いちばん早いレース) の対応表にする。 */
async function loadToday(): Promise<{ date: string | null; byToban: Map<string, Entry> }> {
  const res = await fetch(DATA_URL, { cache: 'no-store' })
  if (!res.ok) throw new Error(`data.js fetch failed: HTTP ${res.status}`)
  const text = await res.text()
  const json = text.slice(text.indexOf('=') + 1).trim().replace(/;\s*$/, '')
  const data = JSON.parse(json)

  const byToban = new Map<string, Entry>()
  for (const venue of data.venues ?? []) {
    for (const race of venue.races ?? []) {
      for (const boat of race.boats ?? []) {
        const cur = byToban.get(boat.t)
        // 同じ日に複数走る場合(節またぎ等)は、いちばん早い締切のレースを載せる。
        if (!cur || (race.dl && cur.deadline && race.dl < cur.deadline)) {
          byToban.set(boat.t, {
            name: boat.name, venue: venue.name, race: race.no, deadline: race.dl,
          })
        }
      }
    }
  }
  return { date: parseDataDate(data.date), byToban }
}

/** 通知の本文を組み立てる。無料プランで載せきれない分は末尾に人数だけ添える。 */
function buildMessage(entries: Entry[], hiddenCount: number) {
  const body = entries
    .map((e) => `${e.name}（${e.venue}${e.race}R 締切${e.deadline}）`)
    .join('／')
  return {
    title: `本日の出走（${entries.length + hiddenCount}名）`,
    body: hiddenCount > 0
      ? `${body}／他${hiddenCount}名（プレミアムで全員通知）`
      : body,
    url: SITE_URL,
  }
}

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
    const [favRes, memRes, logRes] = await Promise.all([
      supabaseAdmin.from('favorite_players').select('user_id,toban,created_at')
        .in('user_id', userIds).order('created_at', { ascending: true }),
      supabaseAdmin.from('memberships').select('user_id,status').in('user_id', userIds),
      supabaseAdmin.from('push_send_log').select('user_id').eq('send_date', today),
    ])
    if (favRes.error || memRes.error || logRes.error) {
      console.error('[send-morning-push] 取得に失敗:',
        favRes.error?.message, memRes.error?.message, logRes.error?.message)
      return Response.json({ error: 'lookup_failed' }, { status: 500 })
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

    const subsByUser = new Map<string, typeof subs>()
    for (const s of subs) {
      const list = subsByUser.get(s.user_id) ?? []
      list.push(s)
      subsByUser.set(s.user_id, list)
    }

    // ---- 送信 ----
    let sentUsers = 0, sentPush = 0, removed = 0, skippedNoRace = 0, skippedDone = 0

    for (const userId of userIds) {
      if (alreadySent.has(userId)) { skippedDone++; continue }

      const matched: Entry[] = []
      for (const toban of favByUser.get(userId) ?? []) {
        const entry = todayData.byToban.get(toban)
        if (entry) matched.push(entry)
      }
      // 出走が無い日は送らない。毎朝「今日はいません」が届くほうが煩わしい。
      if (matched.length === 0) { skippedNoRace++; continue }

      const isPremium = premium.has(userId)
      const shown = isPremium ? matched : matched.slice(0, FREE_LIMIT)
      const hidden = isPremium ? 0 : matched.length - shown.length
      const payload = JSON.stringify(buildMessage(shown, hidden))

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
    }
    console.log('[send-morning-push]', JSON.stringify(summary))
    return Response.json(summary)
  },
}
