// 宛先の許可リストと、失敗の知らせの中身のテスト(2026-10-23 点検の中-1・中-2)。
import { assert, assertEquals } from 'jsr:@std/assert@^1'
import { isAllowedPushEndpoint } from './push-endpoint.ts'
import { dispatchBody, FailureLog } from './failure-report.ts'

Deno.test('isAllowedPushEndpoint: 主要ブラウザの通知サービスだけを通す', () => {
  for (const ok of [
    'https://fcm.googleapis.com/fcm/send/abc:def',
    'https://updates.push.services.mozilla.com/wpush/v2/gAAAA',
    'https://web.push.apple.com/QGx',
    'https://wns2-par02p.notify.windows.com/w/?token=AwYAAA',
    'https://FCM.googleapis.com/fcm/send/x',
  ]) assert(isAllowedPushEndpoint(ok), ok)
  for (const ng of [
    'http://fcm.googleapis.com/fcm/send/x',          // https でない
    'https://fcm.googleapis.com:8443/fcm/send/x',    // 決まっていないポート
    'https://user:pw@fcm.googleapis.com/x',
    'https://fcm.googleapis.com.evil.example/x',     // 似せた名前
    'https://evilfcm.googleapis.com/x',
    'https://notify.windows.com/x',                  // 接尾辞そのもの
    'https://evil.example/notify.windows.com',
    'https://example.com/', 'https://127.0.0.1/', 'not a url', '', null, 1, {},
  ]) assert(!isAllowedPushEndpoint(ng), String(ng))
})

Deno.test('FailureLog: 利用者IDは先頭8文字だけ・同じ人の同じ種類は件数にまとめる', () => {
  const f = new FailureLog()
  const u = '1a2b3c4d-1111-2222-3333-444455556666'
  f.add(u, 'web_timeout')
  f.add(u, 'web_timeout')
  f.add(u, 'web_error', 403)
  f.add('ffffffff-0000-0000-0000-000000000000', 'cond_shape')
  f.add(null, 'run_error')
  assertEquals(f.size, 4)
  assertEquals(f.list(), [
    { user: '-', kind: 'run_error', n: 1 },
    { user: '1a2b3c4d', kind: 'web_error:403', n: 1 },
    { user: '1a2b3c4d', kind: 'web_timeout', n: 2 },
    { user: 'ffffffff', kind: 'cond_shape', n: 1 },
  ])
  // 知らせに入るのは利用者IDの先頭8文字だけ(公開の Issue に全部は出さない)
  assert(!JSON.stringify(dispatchBody('2026-10-24', 'ci', f.list())).includes(u))
})

Deno.test('dispatchBody: 入力は文字列だけ・trigger は形を縛る・多すぎる行は件数だけ送る', () => {
  const many = Array.from({ length: 250 }, (_, i) => ({ user: i.toString(16).padStart(8, '0'), kind: 'web_timeout', n: 1 }))
  const b = dispatchBody('2026-10-24', 'ci', many)
  assertEquals(b.ref, 'main')
  for (const v of Object.values(b.inputs)) assertEquals(typeof v, 'string')
  const doc = JSON.parse(b.inputs.failures)
  assertEquals(doc.items.length, 200)
  assertEquals(doc.more, 50)
  assert(b.inputs.failures.length < 65535)
  assertEquals(dispatchBody('2026-10-24', '`rm -rf`', []).inputs.trigger, 'other')
  assertEquals(dispatchBody('2026-10-24', 'drill', []).inputs.trigger, 'drill')
})
