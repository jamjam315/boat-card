// App Store Server API 用 JWT のテスト(WP-6 で verify-purchase から切り出した)。
//   deno test --no-check supabase/
import { assertEquals } from 'jsr:@std/assert@1'
import { createAppleApiToken } from './apple_api.ts'

const decode = (part: string) => {
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/')
  return JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)))
}

Deno.test('ES256 で署名し、Apple が求めるヘッダーとクレームを持つ', async () => {
  // テストのたびに使い捨ての鍵を作る(現物の鍵はリポジトリに置かない)。
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
  const pem = '-----BEGIN PRIVATE KEY-----\n' +
    btoa(String.fromCharCode(...pkcs8)).replace(/(.{64})/g, '$1\n') +
    '\n-----END PRIVATE KEY-----'

  const token = await createAppleApiToken({
    keyId: 'ABCDEFGHIJ',
    issuerId: '00000000-0000-4000-8000-000000000000',
    privateKey: pem,
    bundleId: 'com.mtpworks.teiyomi',
  })
  const [h, c, s] = token.split('.')
  assertEquals(decode(h), { alg: 'ES256', kid: 'ABCDEFGHIJ', typ: 'JWT' })
  const claim = decode(c)
  assertEquals(claim.aud, 'appstoreconnect-v1')
  assertEquals(claim.bid, 'com.mtpworks.teiyomi')
  assertEquals(claim.iss, '00000000-0000-4000-8000-000000000000')
  assertEquals(claim.exp - claim.iat, 20 * 60)

  // 署名は r||s の生バイト(64バイト)で、公開鍵で検証が通ること。
  const sig = Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (x) => x.charCodeAt(0))
  assertEquals(sig.length, 64)
  const ok = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    pair.publicKey,
    sig,
    new TextEncoder().encode(h + '.' + c),
  )
  assertEquals(ok, true)
})
