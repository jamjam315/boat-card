// 朝の通知で、条件アラートの「艇の材料」が照合されることのテスト(2026-10-20)。
// loadToday が data.js から各出走に6艇ぶんの材料(boats)を付け、matchAlerts がそれで判定する。
// 判定そのものの TS版/JS版の一致は rule_match_parity_test.ts が見ている。ここは配線(data.js → Entry.boats)。
import { assert, assertEquals } from 'jsr:@std/assert@^1'
import { loadToday, matchAlerts, type Alert } from './morning-message.ts'

const boat = (n: number, t: string, k: string, nw: number, s: number[], r: (number | null)[]) =>
  ({ n, t, name: 'x' + n, k, nw, mo: 30 + n, lw: 5, lwn: 10, ks: { s, r } })

const DATA = {
  date: '2026年10月20日',
  venues: [{
    name: '桐生',
    races: [
      { no: 1, dl: '15:00', kind: '予選', dist: 1800, fixed: false, boats: [
        boat(1, '1001', 'A1', 7.2, [0.12, 0.13], [1, 2]),
        boat(2, '1002', 'B1', 4.5, [0.18], [5, 6, 4]),
        boat(3, '4218', 'A2', 6.1, [0.15, 0.16], [3, 3]),
        boat(4, '1004', 'B1', 0, [], []),
        boat(5, '1005', 'B2', 3.9, [0.2], [6]),
        boat(6, '1006', 'A2', 5.8, [0.14], [2, 4, 1]),
      ] },
      { no: 2, dl: '15:30', kind: '予選', dist: 1800, fixed: false, boats: [
        boat(1, '4218', 'A2', 6.1, [0.15, 0.16], [3, 3]),
        boat(2, '1001', 'A1', 7.2, [0.12, 0.13], [1, 2]),
        boat(3, '1002', 'B1', 4.5, [0.18], [5, 6, 4]),
        boat(4, '1004', 'B1', 0, [], []),
        boat(5, '1005', 'B2', 3.9, [0.2], [6]),
        boat(6, '1006', 'A2', 5.8, [0.14], [2, 4, 1]),
      ] },
    ],
  }],
}

async function withData<T>(fn: () => Promise<T>, data: unknown = DATA): Promise<T> {
  const orig = globalThis.fetch
  globalThis.fetch = (() => Promise.resolve(new Response('window.DATA = ' + JSON.stringify(data) + ';'))) as typeof fetch
  try { return await fn() } finally { globalThis.fetch = orig }
}

Deno.test('loadToday: 各出走に、そのレースの6艇の材料が艇番順に付く', async () => {
  const { allByToban } = await withData(() => loadToday())
  const mine = allByToban.get('4218')!
  assertEquals(mine.length, 2)
  const b = mine[0].boats!
  assertEquals(b.length, 6)
  assertEquals(b[0], { k: 'A1', nw: 7.2, mo: 31, st: 0.125, fm: 1.5 })
  assertEquals(b[3], { k: 'B1', nw: null, mo: 34, st: null, fm: null }, '勝率0.00・走りなしは分からない')
  assertEquals(b[4]!.fm, null, '着が1走だけなら調子は出さない')
})

Deno.test('matchAlerts: 材料の条件で当たる出走だけを返す(この選手・艇番の両方)', async () => {
  const { allByToban } = await withData(() => loadToday())
  const alert = (mats: Alert['cond']['mats']): Alert => ({ id: 'a', user_id: 'u', toban: '4218', cond: { mats } })
  // 1号艇が A1 のレース → 1R(1号艇は1001・A1)だけ。2R の1号艇はこの選手(A2)
  let hit = matchAlerts([alert([{ lane: 1, mat: 'k', bands: ['A1'] }])], allByToban, '2026-10-20', null)
  assertEquals(hit.map((e) => e.race), [1])
  // この選手の平均STが 0.14〜0.16 → 両方(0.155)
  hit = matchAlerts([alert([{ lane: 'self', mat: 'st', bands: ['0.14-0.16'] }])], allByToban, '2026-10-20', null)
  assertEquals(hit.map((e) => e.race), [1, 2])
  // 4号艇の全国勝率(0.00 = 分からない)はどの帯にも入らない → 0件
  hit = matchAlerts([alert([{ lane: 4, mat: 'nw', bands: ['-5.0', '5.0-5.5'] }])], allByToban, '2026-10-20', null)
  assertEquals(hit.length, 0)
})

// ---- 壊れた形でも止まらない(2026-10-23 点検の中-1・低-1) ----

// DB に直接書けば保存できてしまう、壊れた形の条件(点検で例外になることを確かめたものを含む)
const BROKEN_CONDS: unknown[] = [
  { mats: 1 }, { mats: {} }, { mats: true }, { mats: 'x' }, { mats: [null] }, { mats: [1] }, { mats: [[]] },
  { mats: [{ lane: 1, mat: 'constructor', bands: ['x'] }] },
  { mats: [{ lane: 1, mat: 'toString', bands: ['x'] }] },
  { mats: [{ lane: 1, mat: '__proto__', bands: ['x'] }] },
  { mats: [{ lane: 1, mat: 'k', bands: { length: 1 } }] },
  { mats: [{ lane: 1, mat: 'k', bands: 'A1' }] },
  { mats: [{ lane: 1, mat: 'k', bands: [] }] },
  { mats: [{ lane: 1, mat: 'k', bands: ['ZZ'] }] },
  { mats: [{ lane: '1', mat: 'k', bands: ['A1'] }] },
  { mats: [{ lane: 7, mat: 'k', bands: ['A1'] }] },
  { mats: [{ lane: 1.5, mat: 'k', bands: ['A1'] }] },
  { mats: [{ mat: 'k', bands: ['A1'] }] },
  // 正しい行と壊れた行が混ざっていても、壊れた行だけ捨てて条件を緩めない
  { mats: [{ lane: 1, mat: 'k', bands: ['A1'] }, { lane: 1, mat: 'zz', bands: ['A1'] }] },
  { venues: { length: 1 } }, { races: { length: 1 } }, { kinds: { length: 1 } }, { months: 3 }, { frames: '1' },
  { dists: { 0: 1800, length: 1 } },
  'abc', 123, true, [], [{ mats: [] }],
]

Deno.test('matchAlerts: 壊れた形の条件でも例外を投げず、その条件だけ飛ばして知らせる', async () => {
  const { allByToban } = await withData(() => loadToday())
  const good: Alert = { id: 'good', user_id: 'u', toban: '4218', cond: { mats: [{ lane: 1, mat: 'k', bands: ['A1'] }] } }
  for (const cond of BROKEN_CONDS) {
    const broken: string[] = []
    const bad = { id: 'bad', user_id: 'u', toban: '4218', cond } as unknown as Alert
    const hit = matchAlerts([bad, good], allByToban, '2026-10-20', null, (a, why) => broken.push(`${a.id}:${why}`))
    // 壊れた条件は当たらず、同じ人の正しい条件(1号艇がA1 → 1R)は今までどおり当たる
    assertEquals(hit.map((e) => e.race), [1], JSON.stringify(cond))
    assertEquals(broken, ['bad:shape'], JSON.stringify(cond))
  }
})

Deno.test('matchAlerts: 今までどおりの形は「壊れている」と言わない(null・空・知らないキー・空の材料)', async () => {
  const { allByToban } = await withData(() => loadToday())
  for (const cond of [null, undefined, {}, { mats: [] }, { mats: null }, { venues: [] }, { session: 'all' },
    { weather: 'rain' }, { fixed: 'yes' }, { races: ['1'] }]) {
    const broken: string[] = []
    const a = { id: 'a', user_id: 'u', toban: '4218', cond } as unknown as Alert
    matchAlerts([a], allByToban, '2026-10-20', null, (x, why) => broken.push(`${x.id}:${why}`))
    assertEquals(broken, [], JSON.stringify(cond))
  }
})

Deno.test('loadToday: data.js の形が崩れていても止まらず、読める艇だけで続ける', async () => {
  const odd = {
    date: '2026年10月20日',
    venues: [
      null, 'x', { name: '壊れ1', races: { 0: {} } }, { name: '壊れ2', races: [null, 7, { no: 1, boats: { a: 1 } }] },
      { name: '桐生', races: [{ no: 3, dl: '16:00', boats: [
        null, 5, 'x', { n: 2 },                                             // 形の違う艇・登番の無い艇
        { n: 1, t: '1001', name: 'a', k: 'A1', nw: 7, ks: { s: '0.12', r: 3 } },   // ks の中身が配列でない
        { n: 3, t: '4218', name: 'b', k: 'A2', nw: 6, ks: 'x' },
        { n: 9, t: '1009', name: 'c' },                                     // 艇番が範囲外(材料は付かない)
      ] }] },
    ],
  }
  const { date, byToban, allByToban } = await withData(() => loadToday(), odd)
  assertEquals(date, '2026-10-20')
  assertEquals([...byToban.keys()].sort(), ['1001', '1009', '4218'])
  const b = allByToban.get('4218')![0].boats!
  assertEquals(b[0], { k: 'A1', nw: 7, mo: null, st: null, fm: null }, 'ks が配列でなければ「分からない」')
  assertEquals(b[1], null, '登番の無い艇は飛ばす')
  // data.js そのものが配列・null でも止まらない(日付が読めないので、朝の便は送らずに終わる)
  for (const whole of [[], null, 'x', { venues: 'x' }]) {
    const r = await withData(() => loadToday(), whole)
    assertEquals(r.date, null)
    assert(r.byToban.size === 0)
  }
})
