// 条件の照合が、サーバー(朝の通知)とブラウザ(マイページ)で食い違わないことのテスト(AI-12)。
//
// 守りたいのは3つ。
//   1. matchesCond / parseDataDate が TS版(morning-message.ts)とJS版(rule-match.js)で
//      同じ入力に同じ答えを返す。片方だけ直すと、通知は鳴るのにマイページには出ない
//      (またはその逆)という、気づきにくい壊れ方をするため
//   2. 検証ノートの cond から、朝に照らせる条件だけを取り出せている
//      (券種・買い目・期間は使わない/天候などは「照らせない条件」として返す)
//   3. 絞れる条件が無いノートは全レースを該当にしない
// 5bが選択肢の表を二重に持っていないことは tests/rule-match.test.mjs で見る
// (CIの deno test はファイルの読み取り権限なしで走るため)。
import { assert, assertEquals } from 'jsr:@std/assert@^1'
import { matchesCond, parseDataDate, type AlertCond, type Entry } from './morning-message.ts'

await import('../../../rule-match.js')
// deno-lint-ignore no-explicit-any
const RM = (globalThis as any).TeiyomiRuleMatch

// ---- 1. TS版とJS版の一致 ----

const ENTRY_BASE: Entry = {
  toban: '4444', name: 'x', venue: '桐生', race: 1, deadline: '15:00', frame: 1,
}

function entries(): Entry[] {
  const out: Entry[] = []
  for (const venue of ['桐生', '戸田', '大村']) {
    for (const race of [1, 5, 12]) {
      for (const frame of [1, 6]) {
        for (const kind of ['優勝戦', '予選', null, undefined]) {
          for (const dist of [1800, 1200, null, undefined]) {
            for (const fixed of [true, false, null, undefined]) {
              out.push({ ...ENTRY_BASE, venue, race, frame, kind, dist, fixed })
            }
          }
        }
      }
    }
  }
  return out
}

const CONDS: (AlertCond | null)[] = [
  null,
  {},
  { venues: [] },
  { venues: ['桐生'] },
  { venues: ['戸田', '大村'] },
  { races: [1, 2, 3] },
  { races: [12] },
  { frames: [1] },
  { months: [9] },
  { months: [12, 1, 2] },
  { kinds: ['優勝戦', '準優勝戦'] },
  { kinds: ['予選'] },
  { dists: [1200] },
  { dists: [1800] },
  { fixed: true },
  { fixed: false },
  { session: 'night' },
  { session: 'day' },
  { session: 'all' },
  { venues: ['桐生'], races: [12], kinds: ['優勝戦'], session: 'night', months: [9] },
  { venues: ['戸田'], session: 'night' },
]

const NIGHTS: (Set<string> | null)[] = [null, new Set(['桐生', '大村'])]
const DATES = ['2026-09-15', '2026-01-03']

Deno.test('matchesCond: TS版とJS版が全組み合わせで同じ答えを返す', () => {
  let n = 0, hits = 0
  for (const e of entries()) {
    for (const c of CONDS) {
      for (const night of NIGHTS) {
        for (const d of DATES) {
          const ts = matchesCond(e, c as AlertCond, d, night)
          const js = RM.matchesCond(e, c, d, night)
          if (ts !== js) {
            throw new Error(`食い違い: entry=${JSON.stringify(e)} cond=${JSON.stringify(c)} date=${d} night=${night ? [...night] : null} ts=${ts} js=${js}`)
          }
          n++
          if (ts) hits++
        }
      }
    }
  }
  // 当てはまる/当てはまらないの両方を実際に通っていること(全部falseで一致、を防ぐ)
  assert(hits > 0 && hits < n, `hits=${hits} n=${n}`)
})

Deno.test('parseDataDate: TS版とJS版が同じ', () => {
  for (const s of ['2026年9月15日', '2026年10月1日', ' 2026年1月3日 ', '2026-09-15', '', null, undefined, 20260915]) {
    assertEquals(RM.parseDataDate(s), parseDataDate(s), String(s))
  }
})

// ---- 2. 検証ノートの cond から照合に使うものを作る ----

const VENUES = [
  { name: '桐生', romaji: 'kiryu', night: true },
  { name: '戸田', romaji: 'toda', night: false },
  { name: '大村', romaji: 'omura', night: true },
]

const FILTER_ALL = {
  month: 'all', months: [], rno: 'all', races: [], weather: 'all', wind: 'all',
  session: 'all', kind: 'all', dist: 'all', fixed: 'all', entry: 'all', kimarite: 'all',
}

function note(over: Record<string, unknown>, filter: Record<string, unknown> = {}) {
  return {
    toban: null, venue: 'zenkoku', period: '1y', custom: null, bet: 'tan3', mode: 'box',
    singleBoats: [], axisBoat: 1, axisPos: 1, oppoBoats: [], boxBoats: [1, 2, 3],
    ...over, filter: { ...FILTER_ALL, ...filter },
  }
}

Deno.test('ruleFromNote: 朝に照らせる条件だけを AlertCond の形で取り出す', () => {
  const r = RM.ruleFromNote(note({ venue: 'kiryu' }, {
    month: 'custom', months: [11, 9], rno: 'late', kind: 'yusho', dist: '1800', fixed: 'off',
  }), VENUES)
  assertEquals(r.cond, {
    venues: ['桐生'], months: [9, 11], races: [10, 11, 12], kinds: ['優勝戦'], dists: [1800], fixed: false,
  })
  assertEquals(r.toban, null)
  assertEquals(r.unusable, [])
  assert(r.narrowable)
})

Deno.test('ruleFromNote: 開催区分は全国のときだけ使う(5bのバックテストと同じ)', () => {
  assertEquals(RM.ruleFromNote(note({}, { session: 'night' }), VENUES).cond, { session: 'night' })
  assertEquals(RM.ruleFromNote(note({ venue: 'toda' }, { session: 'night' }), VENUES).cond, { venues: ['戸田'] })
})

Deno.test('ruleFromNote: 天候・風速・決まり手・進入は照らせない条件として名前を返す', () => {
  const r = RM.ruleFromNote(note({}, { weather: 'rain', wind: 'hi', kimarite: 'nige', entry: 'waku' }), VENUES)
  assertEquals(r.cond, {})
  assertEquals(r.unusable, ['天候：雨', '風速：5m以上', '決まり手：逃げ', '進入：枠なり'])
  assertEquals(r.narrowable, false)
})

Deno.test('ruleFromNote: 選手モードは登番だけでも絞れる', () => {
  const r = RM.ruleFromNote(note({ toban: 4444 }), VENUES)
  assertEquals(r.toban, '4444')
  assertEquals(r.cond, {})
  assert(r.narrowable)
})

Deno.test('ruleFromNote: 欠けた・知らない値は「すべて」扱いで壊れない', () => {
  const r = RM.ruleFromNote({ venue: 'nowhere', filter: { month: 'custom', kind: '???' } }, VENUES)
  assertEquals(r.cond, {})
  assertEquals(RM.ruleFromNote(null, VENUES).narrowable, false)
})

Deno.test('condFromFilter: 5bの画面から保存する条件アラートと同じ形', () => {
  // 以前 5b の中にあった buildAlertCond と同じ結果になること(会場を選ぶと画面が開催区分を
  // 「すべて」に戻すので、画面から来る値では session と venues が同時に入ることはない)。
  assertEquals(
    RM.condFromFilter({ ...FILTER_ALL, rno: 'custom', races: [3, 1], kind: 'jun', dist: '1200', fixed: 'on', session: 'day' }, 'zenkoku', VENUES),
    { races: [1, 3], kinds: ['準優勝戦'], dists: [1200], fixed: true, session: 'day' },
  )
})

// ---- 3. 今日の番組表から集める ----

const DATA = {
  date: '2026年9月15日',
  venues: [
    { name: '戸田', races: [
      { no: 1, dl: '15:10', kind: '予選', dist: 1800, fixed: false, boats: [{ t: '1111', n: 1 }, { t: '4444', n: 3 }] },
      { no: 12, dl: '16:30', kind: '優勝戦', dist: 1800, fixed: false, boats: [{ t: '2222', n: 1 }] },
    ] },
    { name: '桐生', races: [
      { no: 1, dl: '15:00', kind: '一般', dist: 1800, fixed: true, boats: [{ t: '4444', n: 5 }] },
      { no: 12, dl: '20:40', kind: '優勝戦', dist: 1800, fixed: false, boats: [{ t: '3333', n: 2 }] },
    ] },
  ],
}

Deno.test('matchRaces: 条件に合うレースを締切の早い順に集める', () => {
  const night = RM.nightVenuesFrom(VENUES)
  const r = RM.ruleFromNote(note({}, { kind: 'yusho' }), VENUES)
  assertEquals(RM.matchRaces(DATA, r, night), [
    { venue: '戸田', race: 12, deadline: '16:30' },
    { venue: '桐生', race: 12, deadline: '20:40' },
  ])
  const nightOnly = RM.ruleFromNote(note({}, { session: 'night' }), VENUES)
  assertEquals(RM.matchRaces(DATA, nightOnly, night).map((x: { venue: string }) => x.venue), ['桐生', '桐生'])
})

Deno.test('matchRaces: 選手モードはその登番が出るレースだけ', () => {
  const r = RM.ruleFromNote(note({ toban: '4444' }), VENUES)
  assertEquals(RM.matchRaces(DATA, r, null), [
    { venue: '桐生', race: 1, deadline: '15:00' },
    { venue: '戸田', race: 1, deadline: '15:10' },
  ])
  const r2 = RM.ruleFromNote(note({ toban: '4444', venue: 'toda' }), VENUES)
  assertEquals(RM.matchRaces(DATA, r2, null), [{ venue: '戸田', race: 1, deadline: '15:10' }])
})

Deno.test('matchRaces: 絞れる条件が無いノートは全レースを該当にしない', () => {
  const r = RM.ruleFromNote(note({}, { weather: 'rain' }), VENUES)
  assertEquals(RM.matchRaces(DATA, r, null), [])
})

Deno.test('matchRaces: 日付が読めない data.js では何も出さない(月の判定を誤らない)', () => {
  const r = RM.ruleFromNote(note({}, { kind: 'yusho' }), VENUES)
  assertEquals(RM.matchRaces({ ...DATA, date: '' }, r, null), [])
})
