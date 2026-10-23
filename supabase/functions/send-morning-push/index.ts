// 毎朝、お気に入り選手が本日出走する人にだけ通知を1通送る。
//
// 【起動方法】2系統から叩かれる。どちらから来たかは x-trigger ヘッダーで
// 区別し、記録に残す(既定は 'cron'、daily.ymlからは 'ci')。
//   ・本便 … daily.yml が data.js をpushし、GitHub Pagesへの反映を見届けてから叩く
//   ・保険 … Supabase Cron(pg_cron + pg_net)から1日3回
//       22:45 UTC = 07:45 JST / 23:45 UTC = 08:45 JST / 00:45 UTC = 09:45 JST
// 二重に届かないよう、送信できた人を push_send_log に記録し、
// 同じ日に既に記録がある人は飛ばす。
//
// 【なぜCI側から叩くのが本便なのか】
// data.jsを作るGitHub Actionsのスケジュールは遅延・欠落する(実測で1時間遅れる日がある)。
// 決め打ちの時刻では「まだ前日のdata.jsしか無い」ことが常態化していたため、
// データを公開した側が公開反映を確認してから叩く形にした。cron3便は、
// GitHub Actions自体が動かない日のための保険として残している。
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
//
// 【1人の失敗で全員を止めない(2026-10-23 点検の中-1・中-2)】
// 利用者は1人ずつ順に処理する。以前は途中の例外を受け止めていなかったので、壊れた形の条件を
// 1件保存されたり、応答しない宛先を1件登録されたりすると、その人より後ろの全員に届かなかった。
// いまは次のように1人ぶん・1件ぶんだけを飛ばして先へ進む。
//   ・条件の形を整えてから照合し、壊れた条件はその条件だけ飛ばす(morning-message.ts)
//   ・その人の処理で例外が出たら、その人だけ飛ばす
//   ・宛先は通知サービスのURLだけに送り(_shared/push-endpoint.ts)、1件10秒で打ち切る
// 飛ばしたことは黙って消さず、便の最後にまとめて GitHub Issue で知らせる
// (_shared/failure-report.ts → push-failures.yml)。期限切れの宛先(404・410)は
// 普段から起きるので、知らせずに片付けるだけ。
import webPush from 'npm:web-push@^3'
import { createClient } from 'npm:@supabase/supabase-js@^2'
import {
  buildMessage, fetchAllRows, loadFrames, loadNightVenues, loadToday, matchAlerts, todayJst,
  type Alert, type Entry,
} from '../_shared/morning-message.ts'
import { sendApns } from '../_shared/apns.ts'
import { isAllowedPushEndpoint, PUSH_TIMEOUT_MS } from '../_shared/push-endpoint.ts'
import { FailureLog, reportFailures } from '../_shared/failure-report.ts'

const ACTIVE_STATUSES = ['active', 'trialing']

/**
 * 契約中かどうか。statusだけでなく期限も見る。
 *
 * statusを書き戻す担当が止まっても、current_period_endを過ぎれば自動的に
 * 権利が切れるようにしておくための保険(緩む側ではなく締まる側に倒す)。
 * 期限がnullのときは「切れている」ではなく「記録が無い」なので有効扱いにする。
 *
 * 同じ判定が is_premium()(RLS)・membership.js・send-test-push にもある。
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

/** x-only-user に入れてよい形(URLにも表にも入れないが、念のため縛る)。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 長さの同じ2つの文字列を、突き合わせにかかる時間が中身で変わらない形で比べる。 */
function timingSafeEqual(a: string, b: string): boolean {
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

type RunOptions = {
  onlyUser: string | null
  onlyChannel: string | null
  dryRun: boolean
  drill: boolean
  trigger: string
  failures: FailureLog
}

export default {
  async fetch(req: Request): Promise<Response> {
    // ---- 起動保護 ----
    //
    // 毎朝の便は CRON_SECRET で入る。加えて、**運営が手で1通だけ出すため**に
    // service role キーでも入れるようにしてある(2026-09-18)。service role は
    // もともとデータベースを何でもできる鍵なので、これで増える権限は無い。
    const secret = Deno.env.get('CRON_SECRET')
    const serviceRole = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer /i, '')
    const byCron = !!secret && req.headers.get('x-cron-secret') === secret
    const byAdmin = serviceRole.length > 0 && bearer.length === serviceRole.length &&
      timingSafeEqual(bearer, serviceRole)
    if (!byCron && !byAdmin) {
      return new Response('unauthorized', { status: 401 })
    }

    // ---- 手で1通だけ出すときの指定(運営用) ----
    //
    //   x-only-user    … この user_id だけに送る（**指定が無ければ今までどおり全員**）
    //   x-only-channel … 'ios' ならiOSアプリにだけ送る（ブラウザには送らない）
    //   x-dry-run      … '1' なら文面を組み立てて返すだけで、送らない
    //   x-drill        … '1' なら失敗の知らせの稽古(2026-10-23)。**1通も送らず、送信記録も
    //                    書かない**。日付ガードも見ずに全員ぶんの照合と宛先の確かめだけを通し、
    //                    最後にわざとの1件(drill)を足して、本物の Issue が立つところまで確かめる。
    //                    push-failures.yml を drill=true で手動実行すると、ここを叩く
    //
    // 1人だけに出すときは、その日の送信記録(push_send_log)を見ないし、書かない。
    // 「朝の便がもう届いた人」にも出せるようにし、翌朝の便に影響させないため。
    const onlyUser = req.headers.get('x-only-user')
    const onlyChannel = req.headers.get('x-only-channel')
    const dryRun = req.headers.get('x-dry-run') === '1'
    const drill = req.headers.get('x-drill') === '1'
    if (onlyUser !== null && !UUID_RE.test(onlyUser)) {
      return Response.json({ error: 'bad_only_user' }, { status: 400 })
    }

    // どこから叩かれた便なのかを記録に残す。cron便(既定)と、data.jsを公開した
    // 直後にdaily.ymlから叩かれるCI便('ci')を、あとから見分けられるようにする。
    const trigger = drill ? 'drill' : (req.headers.get('x-trigger') ?? 'cron')

    // 便そのものが想定外の例外で止まっても、黙って消さずに知らせる
    const failures = new FailureLog()
    try {
      return await morningRun({ onlyUser, onlyChannel, dryRun, drill, trigger, failures })
    } catch (err) {
      console.error('[send-morning-push] 想定外の例外で便が止まりました:', err)
      failures.add(null, 'run_error')
      const reported = await reportFailures(todayJst(), trigger, failures.list())
      return Response.json({ error: 'run_error', trigger, failures: failures.size, reported }, { status: 500 })
    }
  },
}

async function morningRun(o: RunOptions): Promise<Response> {
  const { onlyUser, onlyChannel, dryRun, drill, trigger, failures } = o
  const today = todayJst()

  // ---- 日付ガード ----
  let todayData
  try {
    todayData = await loadToday()
  } catch (err) {
    console.error('[send-morning-push] data.js を読めませんでした:', err)
    return Response.json({ sent: 0, skipped: 'data_unavailable', trigger }, { status: 500 })
  }
  // 稽古は1通も送らないので、日付ガードを通さなくてよい(いつでも稽古できるように)
  if (todayData.date !== today && !drill) {
    console.warn(
      `[send-morning-push] data.jsの日付(${todayData.date})が今日(${today})ではないため送信しません。`,
    )
    return Response.json({ sent: 0, skipped: 'stale_data', dataDate: todayData.date, trigger })
  }

  // 枠の見どころ用。読めなくても通知自体は出す(その材料を使わないだけ)。
  // ナイター/デイの区分は5bと同じ判定(meta.json)を使う。読めなければ
  // 開催区分を指定した条件だけが一致しなくなる(他の条件は普通に効く)。
  const [frames, nightVenues] = await Promise.all([loadFrames(), loadNightVenues()])

  // ---- 送り先の組み立て ----
  // 各リスト取得は fetchAllRows でページングする(PostgRESTの1000行上限を
  // 超えても黙って切り捨てられないように)。ページの境目で行が重複・欠落
  // しないよう、すべて明示的に並び順を付ける。
  const { data: subs, error: subErr } = await fetchAllRows((from, to) =>
    supabaseAdmin.from('push_subscriptions').select('id,user_id,endpoint,p256dh,auth')
      .order('id').range(from, to))
  if (subErr) {
    console.error('[send-morning-push] 購読の取得に失敗:', (subErr as Error).message)
    return Response.json({ error: 'subscriptions_failed' }, { status: 500 })
  }
  // iOSアプリ(殻)の送り先(WP-4)。テーブルがまだ無い環境でも朝の便を
  // 止めないよう、ここのエラーは致命的に扱わない。
  const { data: devices, error: devErr } = await fetchAllRows((from, to) =>
    supabaseAdmin.from('apns_tokens').select('id,user_id,token,env').order('id').range(from, to))
  if (devErr) console.error('[send-morning-push] iOS端末の取得に失敗:', (devErr as Error).message)

  const hasWeb = (subs?.length ?? 0) > 0
  const hasIos = (devices?.length ?? 0) > 0
  if (!hasWeb && !hasIos && !drill) return Response.json({ sent: 0, users: 0 })

  // 送る相手は「ブラウザの購読を持つ人」と「iOS端末を持つ人」の和集合。
  const allUserIds = [
    ...new Set([
      ...(subs ?? []).map((s) => s.user_id),
      ...(devices ?? []).map((d) => d.user_id as string),
    ]),
  ]
  // 1人だけの指定があれば、その人が送り先に居るときだけに絞る。
  const userIds = onlyUser === null
    ? allUserIds
    : allUserIds.filter((id) => id === onlyUser)
  if (onlyUser !== null && userIds.length === 0) {
    return Response.json({ sent: 0, skipped: 'no_destination_for_user', trigger })
  }

  const [favRes, memRes, logRes, alertRes] = await Promise.all([
    // お気に入りは「登録が古い順」が無料プランの3名選定の意味を持つので
    // created_at 順を維持し、同時刻の並びの安定化に toban を副キーにする。
    fetchAllRows((from, to) =>
      supabaseAdmin.from('favorite_players').select('user_id,toban,created_at')
        .in('user_id', userIds)
        .order('created_at', { ascending: true }).order('toban').range(from, to)),
    fetchAllRows((from, to) =>
      supabaseAdmin.from('memberships').select('user_id,status,current_period_end')
        .in('user_id', userIds).order('user_id').range(from, to)),
    fetchAllRows((from, to) =>
      supabaseAdmin.from('push_send_log').select('user_id')
        .eq('send_date', today).order('user_id').range(from, to)),
    // 条件アラート。有効なものだけ。テーブルがまだ無い環境でも朝の便を
    // 止めないよう、ここのエラーは致命的に扱わない(下でnull扱いにする)。
    fetchAllRows((from, to) =>
      supabaseAdmin.from('race_alerts').select('id,user_id,toban,cond,label')
        .in('user_id', userIds).eq('enabled', true).order('id').range(from, to)),
  ])
  const errMsg = (e: unknown) => (e as Error | null)?.message
  if (favRes.error || memRes.error || logRes.error) {
    console.error('[send-morning-push] 取得に失敗:',
      errMsg(favRes.error), errMsg(memRes.error), errMsg(logRes.error))
    return Response.json({ error: 'lookup_failed' }, { status: 500 })
  }
  if (alertRes.error) {
    console.warn('[send-morning-push] 条件アラートを取得できませんでした:', errMsg(alertRes.error))
  }

  const premium = new Set(
    (memRes.data ?? []).filter(isActive).map((m) => m.user_id),
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
  for (const s of subs ?? []) {
    const list = subsByUser.get(s.user_id) ?? []
    list.push(s)
    subsByUser.set(s.user_id, list)
  }

  type Device = { id: string; token: string; env: string | null }
  const devicesByUser = new Map<string, Device[]>()
  for (const d of devices ?? []) {
    const uid = d.user_id as string
    const list = devicesByUser.get(uid) ?? []
    list.push({ id: d.id as string, token: d.token as string, env: d.env as string | null })
    devicesByUser.set(uid, list)
  }

  // ---- 送信 ----
  let sentUsers = 0, sentPush = 0, removed = 0, skippedNoRace = 0, skippedDone = 0
  let sentIos = 0, removedIos = 0, failedIos = 0
  let alertUsers = 0   // 条件アラートが1件以上当たった人数(効きを見るための記録)
  let failedUsers = 0  // その人の処理で想定外の例外が出て、飛ばした人数
  let drillUsers = 0   // 稽古で照合まで通した人数

  for (const userId of userIds) {
    // 稽古は送信記録を見ない(送った人も含めて、全員ぶんの照合と宛先の確かめを通す)
    if (!drill && onlyUser === null && alreadySent.has(userId)) { skippedDone++; continue }

    // 1人ぶんの処理。ここで例外が出ても、この人だけを飛ばして次の人へ進む(冒頭の説明)
    try {
      const matched: Entry[] = []
      for (const toban of favByUser.get(userId) ?? []) {
        const entry = todayData.byToban.get(toban)
        if (entry) matched.push(entry)
      }

      // 保存した条件に当てはまる本日の出走(プレミアムのみ)。
      // 照合できなかった条件はその条件だけ飛ばし、知らせに入れる。
      const isPremium = premium.has(userId)
      const hits = isPremium
        ? matchAlerts(alertsByUser.get(userId) ?? [], todayData.allByToban, today, nightVenues,
          (_a, why) => failures.add(userId, why === 'shape' ? 'cond_shape' : 'cond_error'))
        : []
      if (hits.length > 0) alertUsers++

      // 稽古: 送らない。宛先の形だけを確かめる(表に無い宛先があれば、知らせに入る)
      if (drill) {
        for (const s of subsByUser.get(userId) ?? []) {
          if (!isAllowedPushEndpoint(s.endpoint)) failures.add(userId, 'web_blocked')
        }
        drillUsers++
        continue
      }

      // 出走が無い日は送らない。毎朝「今日はいません」が届くほうが煩わしい。
      // 条件に一致していれば、お気に入りの出走が無くても知らせる。
      if (matched.length === 0 && hits.length === 0) { skippedNoRace++; continue }

      const message = buildMessage(matched, { premium: isPremium, frames, alerts: hits })
      const payload = JSON.stringify(message)

      // 試し撃ち。**送らずに**、実際に送るのと同じ文面を返す。
      if (dryRun) {
        return Response.json({
          date: today, trigger, dryRun: true, user: userId.slice(0, 8),
          premium: isPremium, matched: matched.length, alerts: hits.length,
          destinations: {
            web: (subsByUser.get(userId) ?? []).length,
            ios: (devicesByUser.get(userId) ?? []).length,
          },
          message,
        })
      }

      let ok = false
      for (const s of (onlyChannel === 'ios' ? [] : subsByUser.get(userId) ?? [])) {
        // 通知サービス以外の宛先には送らない(応答しないサーバーで便が止まらないように)
        if (!isAllowedPushEndpoint(s.endpoint)) {
          failures.add(userId, 'web_blocked')
          continue
        }
        try {
          await webPush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            payload,
            { timeout: PUSH_TIMEOUT_MS },
          )
          ok = true
          sentPush++
        } catch (err) {
          const code = (err as { statusCode?: number }).statusCode
          if (code === 404 || code === 410) {
            // 購読が失効・解除された。残しておくと毎朝失敗し続けるので消す。
            // 普段から起きることなので、知らせには入れない。
            await supabaseAdmin.from('push_subscriptions').delete().eq('id', s.id)
            removed++
          } else {
            // web-push は時間切れを 'Socket timeout' の例外(状態コードなし)で返す
            const timedOut = code === undefined && /timeout/i.test(String((err as Error)?.message ?? ''))
            failures.add(userId, timedOut ? 'web_timeout' : 'web_error', timedOut ? undefined : (code ?? 'none'))
            console.error(`[send-morning-push] 送信失敗 (user=${userId}, code=${code}):`, err)
          }
        }
      }

      // --- iOSアプリへ(APNs直送・WP-4) ---
      // 文面はWeb Pushと同じものを使う(2つ持つと片方を直し忘れる)。
      const devicesOfUser = devicesByUser.get(userId) ?? []
      if (devicesOfUser.length > 0) {
        const ios = await sendApns(devicesOfUser, message)
        sentIos += ios.sent
        failedIos += ios.failed
        if (ios.failed > 0) failures.add(userId, 'ios_error')
        if (ios.sent > 0) ok = true
        if (ios.dropped.length > 0) {
          // 届かない端末は消す(Web Push の 404/410 と同じ扱い)。
          await supabaseAdmin.from('apns_tokens').delete().in('id', ios.dropped)
          removedIos += ios.dropped.length
        }
      }

      if (ok) {
        sentUsers++
      }
      if (ok && onlyUser === null) {
        const { error } = await supabaseAdmin.from('push_send_log')
          .upsert({ send_date: today, user_id: userId }, { onConflict: 'send_date,user_id' })
        if (error) {
          // ここで書けないと2回目の便で重複して届く。落ちはしないが記録は残す。
          console.error(`[send-morning-push] 送信記録に失敗 (user=${userId}):`, error.message)
          failures.add(userId, 'log_error')
        }
      }
    } catch (err) {
      console.error(`[send-morning-push] 利用者 ${userId} の処理で想定外の例外。この人を飛ばして続けます:`, err)
      failures.add(userId, 'user_error')
      failedUsers++
    }
  }

  // 稽古は、わざとの1件を足して本物の Issue が立つところまで通す
  if (drill) failures.add(null, 'drill')

  // 想定外の失敗が1件でもあれば、便の最後にまとめて Issue で知らせる
  const reported = failures.size > 0 ? await reportFailures(today, trigger, failures.list()) : null

  const summary = {
    date: today, trigger, users: userIds.length, sentUsers, sentPush,
    removedSubscriptions: removed, skippedNoRace, skippedAlreadySent: skippedDone,
    sentIos, removedIosTokens: removedIos, failedIos,
    framesLoaded: !!frames,
    alerts: (alertRes.data ?? []).length, alertUsers, nightVenuesLoaded: !!nightVenues,
    failedUsers, failures: failures.size, reported,
    ...(drill ? { drill: true, drillUsers, dataDate: todayData.date } : {}),
  }
  console.log('[send-morning-push]', JSON.stringify(summary))
  return Response.json(summary)
}
