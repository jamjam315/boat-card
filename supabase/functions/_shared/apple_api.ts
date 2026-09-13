// App Store Server API を叩くための共通部品(verify-purchase / apple-notifications)。
//
// JWTの作り方を2か所に持たないために切り出した(片方だけ直し忘れると、
// 片方の関数だけが401になり、原因が分かりにくい)。

/**
 * App Store Server API 用のJWTを作る(ES256)。
 *
 * 外部ライブラリを増やさないよう、WebCryptoで自前で作る——[getGoogleAccessToken]
 * がRS256で同じことをしているのと同じ流儀。違いは鍵の型(EC P-256)と、
 * Appleは**署名したJWTをそのままBearerに使う**こと(Googleのように交換しない)。
 *
 * ECDSAの署名は WebCrypto が r||s の生バイトで返す。JWTはこの形式を期待するので
 * 変換は要らない(DERへ包み直さないこと)。
 */
export async function createAppleApiToken(args: {
  keyId: string
  issuerId: string
  privateKey: string
  bundleId: string
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'ES256', kid: args.keyId, typ: 'JWT' }
  const claim = {
    iss: args.issuerId,
    iat: now,
    // Appleの上限は60分。短くしておく(使い捨てなので長くする理由が無い)。
    exp: now + 20 * 60,
    aud: 'appstoreconnect-v1',
    bid: args.bundleId,
  }

  const b64url = (s: string) =>
    btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const unsigned = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(claim))

  const pem = args.privateKey
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '')
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0))
  const key = await crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )
  const sigBuf = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(unsigned),
  )
  const sig = btoa(String.fromCharCode(...new Uint8Array(sigBuf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return unsigned + '.' + sig
}
