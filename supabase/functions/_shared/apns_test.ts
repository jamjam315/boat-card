// APNsへ送る部分のテスト(WP-4)。
//
// 守りたいのは3つ。
//   1. 送信先を env で取り違えない(取り違えると誰にも届かない)
//   2. 消してよい失敗だけを消す(設定ミスで送り先を全部消さない)
//   3. Secretsが無いときは何もしない(Web Push側を巻き添えにしない)
import { assert, assertEquals, assertFalse } from 'jsr:@std/assert@^1'
import {
  apnsConfigured,
  apnsHost,
  apnsOutcome,
  apnsPayload,
  apnsReason,
  APNS_TOKEN_TTL_MS,
  createApnsJwt,
  parseApnsEnv,
  resetApnsJwtCache,
  sendApns,
} from './apns.ts'

// ---- 送信先の振り分け ----

Deno.test('sandbox のトークンはSandboxへ、それ以外は本番へ', () => {
  assertEquals(apnsHost('sandbox'), 'https://api.sandbox.push.apple.com')
  assertEquals(apnsHost('production'), 'https://api.push.apple.com')
  // 知らない値・欠けている値は本番。BadDeviceToken で行が消え、
  // 通知をONにし直せば正しい env で入り直る(安全側)。
  assertEquals(apnsHost(null), 'https://api.push.apple.com')
  assertEquals(apnsHost(undefined), 'https://api.push.apple.com')
  assertEquals(apnsHost('Sandbox'), 'https://api.push.apple.com')
})

Deno.test('殻から来た env は sandbox か production にしか倒れない', () => {
  assertEquals(parseApnsEnv('sandbox'), 'sandbox')
  assertEquals(parseApnsEnv('production'), 'production')
  assertEquals(parseApnsEnv('SANDBOX'), 'production')
  assertEquals(parseApnsEnv(''), 'production')
  assertEquals(parseApnsEnv(undefined), 'production')
  assertEquals(parseApnsEnv(42), 'production')
  assertEquals(parseApnsEnv({ env: 'sandbox' }), 'production')
})

// ---- 消してよい失敗だけを消す ----

Deno.test('410 と BadDeviceToken だけ行を消す', () => {
  assertEquals(apnsOutcome(410, 'Unregistered'), 'drop')
  assertEquals(apnsOutcome(400, 'BadDeviceToken'), 'drop')
})

Deno.test('設定の誤り・一時的な失敗では消さない', () => {
  // **ここが大事。** 403で消すと、鍵を直したときには送り先が全部消えている。
  assertEquals(apnsOutcome(403, 'InvalidProviderToken'), 'retry')
  assertEquals(apnsOutcome(403, 'ExpiredProviderToken'), 'retry')
  assertEquals(apnsOutcome(400, 'BadTopic'), 'retry')
  assertEquals(apnsOutcome(400, null), 'retry')
  assertEquals(apnsOutcome(429, 'TooManyRequests'), 'retry')
  assertEquals(apnsOutcome(500, null), 'retry')
  assertEquals(apnsOutcome(503, 'ServiceUnavailable'), 'retry')
})

Deno.test('2xxは成功', () => {
  assertEquals(apnsOutcome(200, null), 'ok')
})

Deno.test('応答の reason を読む', () => {
  assertEquals(apnsReason('{"reason":"BadDeviceToken"}'), 'BadDeviceToken')
  assertEquals(apnsReason(''), null)
  assertEquals(apnsReason('not json'), null)
  assertEquals(apnsReason('{"reason":42}'), null)
})

// ---- 通知の中身 ----

Deno.test('文面はWeb Pushと同じものをそのまま入れる', () => {
  const p = JSON.parse(apnsPayload({ title: '本日の出走', body: '艇読太郎（住之江5R 11:20）' }))
  assertEquals(p.aps.alert.title, '本日の出走')
  assertEquals(p.aps.alert.body, '艇読太郎（住之江5R 11:20）')
  assertEquals(p.aps.sound, 'default')
})

// ---- Secretsの有無 ----

Deno.test('APNS_* が揃っていなければ送らない', () => {
  assertFalse(apnsConfigured(undefined, undefined, undefined, undefined))
  assertFalse(apnsConfigured('KID', 'TEAM', 'PEM', undefined))
  assertFalse(apnsConfigured('KID', 'TEAM', undefined, 'com.mtpworks.teiyomi'))
  assertFalse(apnsConfigured('', 'TEAM', 'PEM', 'com.mtpworks.teiyomi'))
  assertEquals(apnsConfigured('KID', 'TEAM', 'PEM', 'com.mtpworks.teiyomi'), true)
})

Deno.test('Secretsが無いときは1本も送らず、行も消さない', async () => {
  resetApnsJwtCache()
  let called = 0
  const r = await sendApns(
    [{ id: 'a', token: 't', env: 'production' }],
    { title: 'x', body: 'y' },
    {
      secrets: {},   // 未設定
      fetchImpl: (() => { called++; return Promise.resolve(new Response('')) }) as typeof fetch,
    },
  )
  assertEquals(called, 0, 'APNsを叩いていない')
  assertEquals(r, { sent: 0, dropped: [], failed: 0 })
})

// ---- まとめて送る ----

const SECRETS = {
  keyId: 'KID',
  teamId: '574794QZ4P',
  privateKey: 'PEM',
  bundleId: 'com.mtpworks.teiyomi',
}

/** APNs の偽の応答。 */
function fakeApns(
  plan: Record<string, { status: number; body?: string }>,
  seen: string[],
): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    seen.push(u)
    const token = u.split('/3/device/')[1] ?? ''
    const p = plan[token] ?? { status: 200 }
    const headers = (init?.headers ?? {}) as Record<string, string>
    seen.push('auth:' + (headers.authorization ?? '').slice(0, 7))
    seen.push('topic:' + (headers['apns-topic'] ?? ''))
    return Promise.resolve(new Response(p.body ?? '', { status: p.status }))
  }) as typeof fetch
}

Deno.test('env ごとに違うホストへ送る', async () => {
  resetApnsJwtCache()
  const seen: string[] = []
  const r = await sendApns(
    [
      { id: 'a', token: 'tok-prod', env: 'production' },
      { id: 'b', token: 'tok-sand', env: 'sandbox' },
    ],
    { title: 'x', body: 'y' },
    // jwt を渡すので署名はしない(鍵の形はここでは関係ない)。
    { secrets: SECRETS, fetchImpl: fakeApns({}, seen), jwt: 'JWT' },
  )
  assertEquals(r.sent, 2)
  assert(seen.includes('https://api.push.apple.com/3/device/tok-prod'))
  assert(seen.includes('https://api.sandbox.push.apple.com/3/device/tok-sand'))
  // APNs は Authorization: bearer <JWT>(小文字のbearer)。
  assert(seen.some((x) => x.startsWith('auth:bearer')), 'bearer が付いていない')
  assert(seen.includes('topic:com.mtpworks.teiyomi'), 'apns-topic が Bundle ID')
})

Deno.test('届かない端末だけ dropped に入る（他は残す）', async () => {
  resetApnsJwtCache()
  const seen: string[] = []
  const r = await sendApns(
    [
      { id: 'ok', token: 'tok-ok', env: 'production' },
      { id: 'gone', token: 'tok-gone', env: 'production' },
      { id: 'bad', token: 'tok-bad', env: 'production' },
      { id: 'oops', token: 'tok-oops', env: 'production' },
    ],
    { title: 'x', body: 'y' },
    {
      fetchImpl: fakeApns({
        'tok-gone': { status: 410, body: '{"reason":"Unregistered"}' },
        'tok-bad': { status: 400, body: '{"reason":"BadDeviceToken"}' },
        'tok-oops': { status: 403, body: '{"reason":"InvalidProviderToken"}' },
      }, seen),
      secrets: SECRETS,
      jwt: 'JWT',
    },
  )
  assertEquals(r.sent, 1)
  assertEquals(r.dropped.sort(), ['bad', 'gone'])
  assertEquals(r.failed, 1, '403は消さずに数えるだけ')
})

// ---- JWT ----

Deno.test('JWTは ES256 で、kid と iss が入る', async () => {
  // 本物の鍵で署名まで通す(WebCryptoが読める形であることの確認も兼ねる)。
  const key = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', key.privateKey))
  const pem = '-----BEGIN PRIVATE KEY-----\n' +
    btoa(String.fromCharCode(...pkcs8)).replace(/(.{64})/g, '$1\n') +
    '\n-----END PRIVATE KEY-----'

  const jwt = await createApnsJwt({
    keyId: 'ABCDE12345',
    teamId: '574794QZ4P',
    privateKey: pem,
    now: 1789000000000,
  })
  const [h, c, sig] = jwt.split('.')
  const dec = (s: string) =>
    JSON.parse(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)))
  assertEquals(dec(h), { alg: 'ES256', kid: 'ABCDE12345' })
  assertEquals(dec(c), { iss: '574794QZ4P', iat: 1789000000 })
  // ES256の署名は r||s の64バイト。DERに包み直していないこと。
  const raw = Uint8Array.from(
    atob(sig.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((sig.length + 3) % 4)),
    (ch) => ch.charCodeAt(0),
  )
  assertEquals(raw.length, 64)
})

Deno.test('JWTは作り直しすぎない（Appleの上限より短い）', () => {
  assert(APNS_TOKEN_TTL_MS < 60 * 60 * 1000, '1時間を超えて使わない')
  assert(APNS_TOKEN_TTL_MS > 20 * 60 * 1000, '20分に1回以上は作り直さない')
})
