// 朝の通知の「本文づくり」を1か所にまとめたもの。
// send-morning-push(本番の朝の便)と send-test-push(自分宛のテスト)の両方が使う。
// 同じ文面を2か所に書くと、片方だけ直して食い違うため。

// 通知をタップしたときの行き先。トップではなくマイページにするのは、
// 通知に出した「本日の出走」の全員ぶんと⭐お気に入りがそこに揃っているため。
export const TAP_URL = 'https://teiyomi.com/mypage.html'
const DATA_URL = 'https://teiyomi.com/data.js'
const FRAMES_URL = 'https://teiyomi.com/frames.js'

export const FREE_LIMIT = 3          // 無料プランで名前を出す人数
const MAX_BODY = 180                 // 本文の目安。これを超えそうなら残りは人数だけにする

// ---- 「見どころ」の閾値 ----
// いずれも実データの分布から決めた(勘で置いていない)。根拠は下記。
//
// 当地-全国の勝率差: 番組表3日分(2,736出走)の分布で +0.68 が上位15%相当。
//   四捨五入して +0.70 を採用。当地の出走が少ないと当地勝率自体が当てにならないので、
//   当地1年の出走数(lwn)が20走に満たない選手は対象外にする。
// モーター2連率: 同じ分布で 42.15% が上位15%相当。42% を採用。
// 枠の1着率: 枠ごとに水準が違う(直近3年の全体で1枠55.2%・6枠3.0%)ため、
//   共通の数字は使わず frames.js の "th"(枠ごとの上位15%)を読む。
const LOCAL_EDGE = 0.7               // 当地勝率 - 全国勝率
const LOCAL_MIN_STARTS = 20          // 当地の出走数がこれ未満なら当地勝率を使わない
const MOTOR_RATE = 42                // モーター2連率(%)

export type Entry = {
  toban: string
  name: string
  venue: string
  race: number
  deadline: string
  frame: number          // 枠(艇番)
  localRate?: number     // 当地勝率
  nationalRate?: number  // 全国勝率
  localStarts?: number   // 当地の出走数(1年)
  motorRate?: number     // モーター2連率(%)
}

export type Frames = {
  min: number
  th: Record<string, number>
  players: Record<string, Record<string, [number, number, number]>>
}

/** 今日(JST)の YYYY-MM-DD。 */
export function todayJst(): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
}

/** data.js の "2026年7月28日" を "2026-07-28" にする。読めなければ null。 */
export function parseDataDate(label: unknown): string | null {
  if (typeof label !== 'string') return null
  const m = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(label.trim())
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null
}

/** window.XXX = {...}; の形のJSファイルから中身のJSONを取り出す。 */
async function loadWindowJson(url: string): Promise<any> {
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  const text = await res.text()
  return JSON.parse(text.slice(text.indexOf('=') + 1).trim().replace(/;\s*$/, ''))
}

/** data.js を読み、登番 → 本日の出走(いちばん早いレース) の対応表にする。 */
export async function loadToday(): Promise<{ date: string | null; byToban: Map<string, Entry> }> {
  const data = await loadWindowJson(DATA_URL)
  const byToban = new Map<string, Entry>()
  for (const venue of data.venues ?? []) {
    for (const race of venue.races ?? []) {
      for (const boat of race.boats ?? []) {
        const cur = byToban.get(boat.t)
        // 同じ日に複数走る場合は、いちばん早い締切のレースを載せる。
        if (!cur || (race.dl && cur.deadline && race.dl < cur.deadline)) {
          byToban.set(boat.t, {
            toban: boat.t, name: boat.name, venue: venue.name,
            race: race.no, deadline: race.dl, frame: boat.n,
            localRate: boat.lw, nationalRate: boat.nw,
            localStarts: boat.lwn, motorRate: boat.mo,
          })
        }
      }
    }
  }
  return { date: parseDataDate(data.date), byToban }
}

/** frames.js を読む。取れなければ null(枠の見どころを使わないだけで、通知は出す)。 */
export async function loadFrames(): Promise<Frames | null> {
  try {
    return await loadWindowJson(FRAMES_URL) as Frames
  } catch (err) {
    console.warn('[morning-message] frames.js を読めませんでした:', err)
    return null
  }
}

/**
 * 選手1人ぶんの「見どころ」を最大1つ返す。優先度は
 *   1) 得意水面(当地勝率が全国を明確に上回る)
 *   2) 好機関(モーター2連率が高い)
 *   3) 枠の強さ(その枠での1着率が枠内で上位)
 * どれにも当てはまらなければ null。無理に褒めず、何も付けない。
 */
export function pickReason(e: Entry, frames: Frames | null): string | null {
  if (
    typeof e.localRate === 'number' && typeof e.nationalRate === 'number' &&
    (e.localStarts ?? 0) >= LOCAL_MIN_STARTS &&
    e.localRate - e.nationalRate >= LOCAL_EDGE
  ) {
    return `当地${e.localRate.toFixed(2)}の得意水面`
  }

  if (typeof e.motorRate === 'number' && e.motorRate >= MOTOR_RATE) {
    return `モーター2連率${Math.round(e.motorRate)}%`
  }

  if (frames) {
    const row = frames.players?.[e.toban]?.[String(e.frame)]
    const th = frames.th?.[String(e.frame)]
    if (row && th && row[0] >= (frames.min ?? 30)) {
      const rate = row[1] / row[0]
      if (rate >= th) return `${e.frame}枠で1着率${Math.round(rate * 100)}%`
    }
  }
  return null
}

/**
 * 通知の本文を組み立てる。
 * 通知はOS側で短く切り詰められるので、本文が長くなりすぎないよう
 * MAX_BODY を目安に打ち切り、残りは人数だけ添える(全員ぶんはタップ先で見られる)。
 */
export function buildMessage(
  matched: Entry[],
  opts: { premium: boolean; frames: Frames | null },
) {
  const total = matched.length
  // 無料プランは名前を出すのを3名までにする(古いお気に入り順)。
  const allowed = opts.premium ? matched : matched.slice(0, FREE_LIMIT)

  const parts: string[] = []
  let used = 0
  for (const e of allowed) {
    const reason = opts.premium ? pickReason(e, opts.frames) : null
    const piece = opts.premium
      ? `${e.name}（${e.venue}${e.race}R ${e.deadline}）${reason ?? ''}`
      : `${e.name}（${e.venue}${e.race}R 締切${e.deadline}）`
    // 1人目は長くても必ず入れる(空の通知にしないため)。
    if (parts.length > 0 && used + piece.length > MAX_BODY) break
    parts.push(piece)
    used += piece.length + 1
  }

  const hidden = total - parts.length
  let body = parts.join('／')
  if (hidden > 0) {
    body += opts.premium ? `／ほか${hidden}名` : `／他${hidden}名（プレミアムで全員通知）`
  }

  return { title: `本日の出走（${total}名）`, body, url: TAP_URL }
}
