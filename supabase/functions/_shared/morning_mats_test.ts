// 朝の通知で、条件アラートの「艇の材料」が照合されることのテスト(2026-10-20)。
// loadToday が data.js から各出走に6艇ぶんの材料(boats)を付け、matchAlerts がそれで判定する。
// 判定そのものの TS版/JS版の一致は rule_match_parity_test.ts が見ている。ここは配線(data.js → Entry.boats)。
import { assertEquals } from 'jsr:@std/assert@^1'
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

async function withData<T>(fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch
  globalThis.fetch = (() => Promise.resolve(new Response('window.DATA = ' + JSON.stringify(DATA) + ';'))) as typeof fetch
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
