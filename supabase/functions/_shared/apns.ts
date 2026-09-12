// APNs(Apple Push Notification service)へ直接送る(WP-4)。
//
// **Firebaseを使わない。** FCM経由にすると、Google側にもう1つ鍵と送信先の管理が
// 増える。艇読みが要るのは「iOSの端末へ通知を1本投げる」だけなので、
// APNsのHTTP/2エンドポイントを直接叩く。Denoのfetchはh2を話すので、
// 追加のライブラリは要らない。
//
// ## 認証はJWT(.p8のES256)
//
// verify-purchase の App Store Server API とまったく同じ作り方。違いは
// クレームの中身(aud/bidが無く、iss=チームID・iat だけ)と、ヘッダに
// `apns-topic`(Bundle ID)を付けること。
//
// **JWTは使い回す。** Appleは「20分に1回以上作り直すな、1時間を超えて使うな」と
// している。作るたびに署名するとCPUも無駄なので、50分持たせて使い回す。
//
// ## 送信先はトークンごとに決まる
//
// 開発ビルド・TestFlightで取ったトークンはSandbox、App Store配信は本番。
// **取り違えると BadDeviceToken になる**ので、行に持っている env で振り分ける。
//
// ## 失敗したトークンは消す
//
// 410(Unregistered) と 400/BadDeviceToken は「その端末にはもう届かない」。
// 残すと毎朝失敗し続けるので、呼び出し側が消せるように結果で知らせる
// (push_subscriptions の 404/410 と同じ作法)。

const APNS_PRODUCTION = 'https://api.push.apple.com'
const APNS_SANDBOX = 'https://api.sandbox.push.apple.com'

/** JWTを作り直す間隔。Appleの上限は60分。 */
export const APNS_TOKEN_TTL_MS = 50 * 60 * 1000

/** 送信先のホスト。**トークンの env で決める。** */
export function apnsHost(env: string | null | undefined): string {
  return env === 'sandbox' ? APNS_SANDBOX : APNS_PRODUCTION
}

/**
 * 殻から申告された環境名を読む。
 *
 * 知らない値は 'production' に倒す——Sandboxへ送ってしまうと本番の端末に
 * 届かないが、逆(本番へ送ってSandboxの端末に届かない)は BadDeviceToken で
 * 行が消え、次に通知をONにし直せば正しい env で入り直る。どちらも安全側だが、
 * 既定は利用者の多いほうにする。
 */
export function parseApnsEnv(raw: unknown): 'sandbox' | 'production' {
  return raw === 'sandbox' ? 'sandbox' : 'production'
}

/** APNsへ送るのに要る4つ。 */
export type ApnsSecrets = {
  keyId?: string
  teamId?: string
  privateKey?: string
  bundleId?: string
}

/**
 * Secretsを環境から読む。
 *
 * **環境に触るのはここだけ。** 送信そのもの([sendApns])には値を渡す形にして
 * あるので、テストは環境変数を読む許可なしで全分岐を通せる。
 */
export function apnsSecretsFromEnv(): ApnsSecrets {
  return {
    keyId: Deno.env.get('APNS_KEY_ID'),
    teamId: Deno.env.get('APNS_TEAM_ID'),
    privateKey: Deno.env.get('APNS_PRIVATE_KEY'),
    bundleId: Deno.env.get('APNS_BUNDLE_ID'),
  }
}

/** APNsのSecretsが揃っているか。**揃っていなければ送らない。** */
export function apnsConfigured(
  keyId: string | undefined | null,
  teamId: string | undefined | null,
  privateKey: string | undefined | null,
  bundleId: string | undefined | null,
): boolean {
  return !!keyId && !!teamId && !!privateKey && !!bundleId
}

/**
 * 送信の結果をどう扱うか。
 *
 * - `ok`      … 届いた
 * - `drop`    … その端末にはもう届かない。**行を消す**
 * - `retry`   … 一時的な失敗。行は残す(次の便でもう一度試す)
 */
export type ApnsOutcome = 'ok' | 'drop' | 'retry'

/**
 * APNsの応答から、行を消すべきかを決める。
 *
 * 消すのは2つだけ。
 *   410 Unregistered   … アプリが消された・トークンが失効した
 *   400 BadDeviceToken … そのトークンはこの環境のものではない(env取り違え等)
 *
 * **それ以外は消さない。** 403(鍵の誤り)や5xxで消すと、設定を直したあとに
 * 送り先が全部消えている、という取り返しのつかない形になる。
 */
export function apnsOutcome(status: number, reason: string | null): ApnsOutcome {
  if (status >= 200 && status < 300) return 'ok'
  if (status === 410) return 'drop'
  if (status === 400 && reason === 'BadDeviceToken') return 'drop'
  return 'retry'
}

/** 応答の本文から reason を取り出す。読めなければ null。 */
export function apnsReason(body: string): string | null {
  try {
    const j = JSON.parse(body)
    return typeof j?.reason === 'string' ? j.reason : null
  } catch {
    return null
  }
}

/**
 * 通知1本ぶんの中身。
 *
 * `buildMessage()`(Web Pushと共通)が返す title/body をそのまま入れる。
 * **文面を2つ持たない**——iOSとブラウザで別の文章になると、直すときに
 * 片方を忘れる。
 */
export function apnsPayload(message: { title: string; body: string }): string {
  return JSON.stringify({
    aps: {
      alert: { title: message.title, body: message.body },
      sound: 'default',
      // 通知を必ず表示する(サイレントpushはしない)。Web Push側の
      // userVisibleOnly:true と対になる考え方。
      'mutable-content': 0,
    },
  })
}

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const b64urlText = (s: string) =>
  btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/**
 * APNs用のJWTを作る(ES256)。
 *
 * 外部ライブラリを増やさないよう、WebCryptoで自前で作る——verify-purchase の
 * createAppleApiToken と同じ流儀。ECDSAの署名は WebCrypto が r||s の生バイトで
 * 返すので、JWTが期待する形そのまま(DERへ包み直さないこと)。
 */
export async function createApnsJwt(args: {
  keyId: string
  teamId: string
  privateKey: string
  now?: number
}): Promise<string> {
  const now = Math.floor((args.now ?? Date.now()) / 1000)
  const header = { alg: 'ES256', kid: args.keyId }
  const claim = { iss: args.teamId, iat: now }
  const unsigned = b64urlText(JSON.stringify(header)) + '.' + b64urlText(JSON.stringify(claim))

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
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(unsigned),
  )
  return unsigned + '.' + b64url(new Uint8Array(sig))
}

/** 送る相手1件ぶん。 */
export type ApnsTarget = { id: string; token: string; env: string | null }

export type ApnsResult = { sent: number; dropped: string[]; failed: number }

/**
 * まとめて送る。**行を消すのは呼び出し側**(返り値の dropped を使う)。
 *
 * Secretsが揃っていなければ何もせずに返す。設定前でも朝の便を落とさないため
 * (Web Push側は今までどおり動く)。
 */
export async function sendApns(
  targets: readonly ApnsTarget[],
  message: { title: string; body: string },
  opts?: {
    secrets?: ApnsSecrets
    fetchImpl?: typeof fetch
    now?: number
    jwt?: string
  },
): Promise<ApnsResult> {
  const result: ApnsResult = { sent: 0, dropped: [], failed: 0 }
  if (targets.length === 0) return result

  const { keyId, teamId, privateKey, bundleId } = opts?.secrets ?? apnsSecretsFromEnv()
  if (!apnsConfigured(keyId, teamId, privateKey, bundleId)) {
    console.log('[apns] APNS_* secrets not configured — iOSへの送信は行いません')
    return result
  }

  const jwt = opts?.jwt ?? await cachedJwt({
    keyId: keyId as string,
    teamId: teamId as string,
    privateKey: privateKey as string,
    now: opts?.now,
  })
  const doFetch = opts?.fetchImpl ?? fetch
  const payload = apnsPayload(message)

  for (const t of targets) {
    try {
      const res = await doFetch(apnsHost(t.env) + '/3/device/' + encodeURIComponent(t.token), {
        method: 'POST',
        headers: {
          authorization: 'bearer ' + jwt,
          'apns-topic': bundleId as string,
          'apns-push-type': 'alert',
          'apns-priority': '10',
        },
        body: payload,
      })
      if (res.ok) {
        result.sent++
        continue
      }
      const body = await res.text().catch(() => '')
      const reason = apnsReason(body)
      const outcome = apnsOutcome(res.status, reason)
      if (outcome === 'drop') {
        result.dropped.push(t.id)
      } else {
        result.failed++
      }
      // トークン本文は出さない(端末を特定できる値なので、行のidだけ)。
      console.error(`[apns] 送信失敗 id=${t.id} status=${res.status} reason=${reason}`)
    } catch (e) {
      result.failed++
      console.error(`[apns] 送信で例外 id=${t.id}: ${e}`)
    }
  }
  return result
}

// ---- JWTのキャッシュ -------------------------------------------------------
// Edge Function のインスタンスが生きている間だけ持つ。使い回せなくても
// 作り直すだけなので、消えても壊れない。

let cache: { jwt: string; at: number } | null = null

async function cachedJwt(args: {
  keyId: string
  teamId: string
  privateKey: string
  now?: number
}): Promise<string> {
  const now = args.now ?? Date.now()
  if (cache && now - cache.at < APNS_TOKEN_TTL_MS) return cache.jwt
  const jwt = await createApnsJwt(args)
  cache = { jwt, at: now }
  return jwt
}

/** テスト用。キャッシュを空にする。 */
export function resetApnsJwtCache(): void {
  cache = null
}
