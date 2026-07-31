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
  // 朝の時点で分かるレースの属性(2026-07-31にdata.jsへ追加)。条件アラートの照合に使う。
  // 古いdata.jsを読んだ場合は undefined になる(その条件は判定できない=一致とみなさない)。
  kind?: string | null   // 種別(優勝戦/準優勝戦/予選/一般/その他)
  dist?: number | null   // 距離(m)
  fixed?: boolean | null // 進入固定
}

/**
 * 保存された条件アラートのうち、朝に判定できる部分。
 *
 * 【この形をここに書いてある理由】
 * 保存する側(5bのUI)と照合する側(この関数)が別々に形を決めると、片方だけ直したときに
 * 静かに一致しなくなる。仕様はここに1つだけ置き、保存側もこの形に合わせる。
 *
 * どのキーも省略可で、省略は「その条件では絞らない」を意味する。
 * 配列は中身のどれかに当てはまればよい(OR)、キーどうしはすべて満たす必要がある(AND)。
 *
 *   venues  会場名の配列        例 ["住之江","大村"]
 *   races   レース番号の配列    1〜12
 *   months  月の配列            1〜12
 *   frames  枠(艇番)の配列      1〜6
 *   kinds   種別の配列          "優勝戦" "準優勝戦" "予選" "一般" "その他"
 *   dists   距離(m)の配列       1800 / 1200
 *   fixed   進入固定            true=固定戦のみ / false=固定でないレースのみ
 *   session 開催区分            "night"=ナイター / "day"=デイ
 *
 * 【ここに無いものは無視する】
 * 天候・風速・波高・決まり手・実際の進入・枠なりは、レース後にしか分からないので
 * 朝には判定できない。保存側の不具合でこれらが混ざっていても、黙って無視する
 * (知らないキーで通知が壊れないようにするための防御)。
 */
export type AlertCond = {
  venues?: string[]
  races?: number[]
  months?: number[]
  frames?: number[]
  kinds?: string[]
  dists?: number[]
  fixed?: boolean
  session?: 'night' | 'day' | 'all'
}

export type Alert = {
  id: string
  user_id: string
  toban: string
  cond: AlertCond
  label?: string | null
}

export type Frames = {
  min: number
  th: Record<string, number>
  avg?: Record<string, number>   // 枠ごとの全体の1着率(「(平均◯%)」の基準)
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

/**
 * window.XXX = {...}; の形のJSファイルから中身のJSONを取り出す。
 *
 * 【キャッシュ回避を「やらない」ことの記録(2026-07-30に実測)】
 * data.js は GitHub Pages(Fastly経由)が Cache-Control: max-age=600 で配るため、
 * エッジは最大10分ぶん古いコピーを返し得る(Ageヘッダーが実際に伸びるのを確認)。
 * ただし次の回避策はいずれも効かないことを実測で確認した:
 *   - URLに毎回違うクエリを付ける … GitHub Pagesはクエリをキャッシュキーから
 *     外すため、新しいクエリでも同じ Age の古いコピーが返る(Age:92で一致)
 *   - リクエストヘッダー Cache-Control: no-cache / no-store / Pragma: no-cache
 *     … いずれも無視される(Age:125のまま)
 * fetch の cache:'no-store' もDeno側のキャッシュにしか効かない。
 * つまり「読む側の工夫」では新しさを保証できない。保証したい場合は、
 * data.jsを公開したCI側が公開反映を確認してから送信を叩く形にする必要がある。
 */
async function loadWindowJson(url: string): Promise<any> {
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  const text = await res.text()
  return JSON.parse(text.slice(text.indexOf('=') + 1).trim().replace(/;\s*$/, ''))
}

/**
 * data.js を読み、登番 → 本日の出走 の対応表にする。
 *   byToban    … 1人につき「いちばん早い締切のレース」1件(お気に入り通知が使う。従来どおり)
 *   allByToban … 1人の本日の出走ぜんぶ(条件アラートの照合が使う。同じ日に2走することがある)
 */
export async function loadToday(): Promise<{
  date: string | null
  byToban: Map<string, Entry>
  allByToban: Map<string, Entry[]>
}> {
  const data = await loadWindowJson(DATA_URL)
  const byToban = new Map<string, Entry>()
  const allByToban = new Map<string, Entry[]>()
  for (const venue of data.venues ?? []) {
    for (const race of venue.races ?? []) {
      for (const boat of race.boats ?? []) {
        const entry: Entry = {
          toban: boat.t, name: boat.name, venue: venue.name,
          race: race.no, deadline: race.dl, frame: boat.n,
          localRate: boat.lw, nationalRate: boat.nw,
          localStarts: boat.lwn, motorRate: boat.mo,
          kind: race.kind, dist: race.dist, fixed: race.fixed,
        }
        const list = allByToban.get(boat.t) ?? []
        list.push(entry)
        allByToban.set(boat.t, list)

        const cur = byToban.get(boat.t)
        // 同じ日に複数走る場合は、いちばん早い締切のレースを載せる。
        if (!cur || (race.dl && cur.deadline && race.dl < cur.deadline)) {
          byToban.set(boat.t, entry)
        }
      }
    }
  }
  return { date: parseDataDate(data.date), byToban, allByToban }
}

// ---- 条件アラートの照合 ----

const META_URL = 'https://teiyomi.com/backtest-data/meta.json'

/** ナイター開催の会場名の集合。5bと同じ判定を使うため meta.json から読む。 */
export async function loadNightVenues(): Promise<Set<string> | null> {
  try {
    const res = await fetch(META_URL, { cache: 'no-store' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const meta = await res.json()
    const out = new Set<string>()
    for (const v of meta.venues ?? []) {
      if (v?.night && v?.name) out.add(v.name)
    }
    return out
  } catch (err) {
    console.warn('[morning-message] meta.json を読めませんでした:', err)
    return null
  }
}

/**
 * 1つの出走が条件に当てはまるか。
 *
 * 【判定できないものは「当てはまらない」に倒す】
 * 種別・距離・進入固定は2026-07-31にdata.jsへ追加したので、それより前に作られた
 * data.js には入っていない。条件で指定されているのにデータ側に無い場合は、
 * 一致とみなさない。届かないことより、間違った知らせが届くことのほうが害が大きい
 * (朝の便の日付ガードと同じ考え方)。
 */
export function matchesCond(
  e: Entry, cond: AlertCond, dateIso: string, nightVenues: Set<string> | null,
): boolean {
  const c = cond ?? {}
  if (c.venues?.length && !c.venues.includes(e.venue)) return false
  if (c.races?.length && !c.races.includes(e.race)) return false
  if (c.frames?.length && !c.frames.includes(e.frame)) return false
  if (c.months?.length) {
    const month = Number(dateIso.slice(5, 7))
    if (!c.months.includes(month)) return false
  }
  if (c.kinds?.length) {
    if (!e.kind || !c.kinds.includes(e.kind)) return false
  }
  if (c.dists?.length) {
    if (typeof e.dist !== 'number' || !c.dists.includes(e.dist)) return false
  }
  if (typeof c.fixed === 'boolean') {
    if (typeof e.fixed !== 'boolean' || e.fixed !== c.fixed) return false
  }
  if (c.session === 'night' || c.session === 'day') {
    if (!nightVenues) return false            // 会場の区分が分からないので判定しない
    const isNight = nightVenues.has(e.venue)
    if ((c.session === 'night') !== isNight) return false
  }
  return true
}

/**
 * その人の条件アラートに当てはまる本日の出走を集める。
 * 同じレースが複数の条件に当てはまっても1件として数える(通知は「何レースあるか」を伝えるため)。
 * 並びは締切の早い順(先に締め切るものから知らせたい)。
 */
export function matchAlerts(
  alerts: Alert[], allByToban: Map<string, Entry[]>, dateIso: string,
  nightVenues: Set<string> | null,
): Entry[] {
  const seen = new Set<string>()
  const out: Entry[] = []
  for (const a of alerts) {
    for (const e of allByToban.get(a.toban) ?? []) {
      if (!matchesCond(e, a.cond, dateIso, nightVenues)) continue
      const key = `${e.venue}:${e.race}:${e.toban}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(e)
    }
  }
  out.sort((x, y) => (x.deadline ?? '').localeCompare(y.deadline ?? ''))
  return out
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
      if (rate >= th) {
        // 枠の水準は枠ごとに全く違う(1枠55% / 6枠3%)。数字だけ出すと
        // 「4枠で1着率17%」が低成績に見えてしまうので、枠平均を併記する。
        const avg = frames.avg?.[String(e.frame)]
        const base = typeof avg === 'number' ? `（平均${Math.round(avg * 100)}%）` : ''
        return `${e.frame}枠で1着率${Math.round(rate * 100)}%${base}`
      }
    }
  }
  return null
}

/**
 * 通知の本文を組み立てる。
 * 通知はOS側で短く切り詰められるので、本文が長くなりすぎないよう
 * MAX_BODY を目安に打ち切り、残りは人数だけ添える(全員ぶんはタップ先で見られる)。
 */
/**
 * 条件アラートの1行。締切の早い順に2件まで具体名を出し、残りは件数だけにする。
 * 通知は短いほうがよいので、長すぎる場合は件数だけの形に落とす。
 */
function alertLine(hits: Entry[], room: number): string {
  const short = `🔔 保存した条件に${hits.length}件一致`
  const named = hits.slice(0, 2).map((e) => `${e.venue}${e.race}R ${e.deadline}`)
  const rest = hits.length - named.length
  const full = `${short}（${named.join('／')}${rest > 0 ? ` ほか${rest}件` : ''}）`
  return full.length <= room ? full : short
}

export function buildMessage(
  matched: Entry[],
  opts: { premium: boolean; frames: Frames | null; alerts?: Entry[] },
) {
  const total = matched.length
  // 条件アラートはプレミアムだけ。保存自体が壁の内側だが、契約が切れた人に
  // 出し続けないよう、送る直前にもう一度ここで確認する。
  const hits = opts.premium ? (opts.alerts ?? []) : []
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

  // お気に入りの出走が無くても、条件に一致していれば知らせる。
  // この場合は見出しを条件アラート側にして、本文はレースの並びだけにする。
  if (total === 0 && hits.length > 0) {
    const named: string[] = []
    let len = 0
    for (const e of hits) {
      const piece = `${e.venue}${e.race}R ${e.deadline}（${e.name}）`
      if (named.length > 0 && len + piece.length > MAX_BODY) break
      named.push(piece)
      len += piece.length + 1
    }
    const rest = hits.length - named.length
    return {
      title: `🔔 保存した条件に${hits.length}件一致`,
      body: named.join('／') + (rest > 0 ? `／ほか${rest}件` : ''),
      url: TAP_URL,
    }
  }

  // お気に入りを先に詰め、残った文字数で条件アラートを足す(優先順は変えない)。
  if (hits.length > 0) {
    body += '\n' + alertLine(hits, Math.max(24, MAX_BODY - body.length))
  }

  return { title: `本日の出走（${total}名）`, body, url: TAP_URL }
}
