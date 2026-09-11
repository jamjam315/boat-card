// verify-purchase の判断部分。通信もDBアクセスもしない純粋な関数だけを置く。
//
// ここを index.ts から切り離しているのは、テストで全分岐を通せるようにするため。
// 「Secretsが無いときに本当に無効を返すか」のような、事故ったら課金が壊れる判断は、
// 実際に走らせて確かめられる形にしておく(logic_test.ts)。

/**
 * このアプリの定期購入の商品ID。
 *
 * **増やすときはここだけ直す。** 判定ロジックは商品IDを知らない作りにしてあるので、
 * 優待価格の別商品(将来検討中の teiyomi_premium_monthly_partner など)を足す場合も、
 * この集合に1行足せば通るようになる。
 *
 * Play Consoleに登録するIDと一字一句一致させること。公開後は変更できない。
 */
export const PRODUCT_IDS: ReadonlySet<string> = new Set([
  'teiyomi_premium_monthly',
])

export function isKnownProduct(productId: string): boolean {
  return PRODUCT_IDS.has(productId)
}

/** 検証結果をキャッシュとして使ってよい時間。 */
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000

export type MembershipRow = {
  user_id?: string | null
  status?: string | null
  price_id?: string | null
  current_period_end?: string | null
  purchase_token?: string | null
  updated_at?: string | null
}

/** Googleの応答から必要なところだけ取り出した形。 */
export type SubState = {
  /** Googleが「有効」と言っていて、かつ期限も過ぎていないか。 */
  active: boolean
  /** 期限(ISO文字列)。取れなければ null。 */
  expiry: string | null
  /** まだ acknowledge していないか(3日以内に返さないと自動返金される)。 */
  needsAcknowledge: boolean
}

/**
 * subscriptionsv2 の応答を読む。
 *
 * 有効とみなすのは ACTIVE と IN_GRACE_PERIOD(支払いの再試行中)だけ。
 * 解約済み・保留・期限切れ・知らない状態はすべて無効に倒す。
 * さらに、Googleが有効と言っていても expiryTime を過ぎていれば無効にする
 * (応答の取り違えや時計のずれで、切れた購読を通してしまわないための二重確認)。
 */
export function parseSubscription(sub: unknown, nowMs: number): SubState {
  const s = (sub ?? {}) as Record<string, unknown>
  const state = typeof s.subscriptionState === 'string' ? s.subscriptionState : ''
  const byState = state === 'SUBSCRIPTION_STATE_ACTIVE' ||
    state === 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD'

  const items = Array.isArray(s.lineItems) ? s.lineItems : []
  const first = (items[0] ?? {}) as Record<string, unknown>
  const expiry = typeof first.expiryTime === 'string'
    ? first.expiryTime
    : (typeof s.expiryTime === 'string' ? s.expiryTime : null)

  let expired = false
  if (expiry) {
    const t = new Date(expiry).getTime()
    // 読めない日付は「期限切れではない」とは断定できないので、無効側に倒す。
    expired = Number.isNaN(t) ? true : t <= nowMs
  }

  return {
    active: byState && !expired,
    expiry,
    needsAcknowledge: s.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_PENDING',
  }
}

/**
 * 前回の検証結果をそのまま返してよいか。
 *
 * 購読は更新されてもトークンが変わらないので、毎回ストアに問い合わせる必要はない。
 * この関数がストアへの問い合わせ回数の上限も兼ねている(専用のレート制限表を持たない)。
 *
 * ## 期限切れの記録はキャッシュにしない
 *
 * **購読は更新されてもトークンが変わらない。** 期限を過ぎた記録をそのまま返すと、
 * ストア側では更新されて期限が伸びているのに、こちらは最大24時間「無効」と
 * 答え続ける——**毎月の更新日に、払っている人が締め出される**。
 * レジャー帳で実際に起きた(2026-08-11、5分更新のテスト購読で表面化。
 * 「Playには定期購入済みと出るのにアプリは無料のまま、復元しても直らない」)。
 *
 * この条件は**省略をやめてストアに聞きにいく**方向にしか働かない。
 * 無効を有効に変えることは無いので、フェイルクローズは緩まない。
 */
export function canUseCache(
  row: MembershipRow | null | undefined,
  nowMs: number,
  ttlMs: number = CACHE_TTL_MS,
): boolean {
  if (!row || !row.updated_at) return false
  const t = new Date(row.updated_at).getTime()
  if (Number.isNaN(t)) return false
  const age = nowMs - t
  if (age < 0) return false // 未来の記録は信用しない
  if (age >= ttlMs) return false

  // 期限の記録が無い行はそのまま扱う(期限切れかどうかの材料が無いだけで、
  // 有効かどうかは status 側で決まる)。
  if (!row.current_period_end) return true
  const end = new Date(row.current_period_end).getTime()
  // 読めない日付は判断材料にならない。省略せずストアに聞き直す。
  if (Number.isNaN(end)) return false
  return end > nowMs
}

/**
 * 保存済みの行から「今この人は有効か」を出す。
 * membership.js / is_premium() / 朝の通知 と同じ条件にそろえている。
 */
export function isRowActive(
  row: MembershipRow | null | undefined,
  nowMs: number,
): boolean {
  if (!row) return false
  if (row.status !== 'active' && row.status !== 'trialing') return false
  if (!row.current_period_end) return true
  const t = new Date(row.current_period_end).getTime()
  if (Number.isNaN(t)) return true
  return t > nowMs
}

/**
 * この購入トークンを、他の人が既に使っていないか。
 *
 * 1つの購読を複数アカウントで使い回せると、1人ぶんの支払いで何人でも
 * プレミアムになれてしまう。DB側にも一意制約があるが、そこで弾くと
 * 何が起きたか分からないエラーになるので、手前で明示的に見る。
 */
export function tokenTakenByOther(
  rows: readonly MembershipRow[] | null | undefined,
  userId: string,
): boolean {
  return (rows ?? []).some((r) => r.user_id && r.user_id !== userId)
}

/**
 * Google照会に必要なSecretsが揃っているか。
 *
 * **揃っていなければ検証できない＝無効。** 「設定を忘れたら素通り」にだけは
 * 絶対にしない。GOOGLE_PLAY_SA_KEY を入れるまでは誰もプレミアムにならない。
 * 空文字も未設定と同じ扱いにする(secrets set で空を入れた事故を通さない)。
 */
export function secretsConfigured(
  saKey: string | undefined | null,
  packageName: string | undefined | null,
): boolean {
  return !!saKey && !!packageName
}

// ---------------------------------------------------------------------------
// iOS(App Store Server API)
//
// レジャー帳の同名関数からの移植。あちらで実機の事故を踏んで直した箇所は、
// 理由ごと持ってきている(踏み直さないため)。
// ---------------------------------------------------------------------------

/** 対応するストア。クライアントが platform で申告する。 */
export type Platform = 'android' | 'ios'

/**
 * 申告された platform を読む。**知らない値を android に倒さない。**
 *
 * 既定を android にすると、iOSのクライアントが古くて platform を送らない場合に
 * AppleのJWSをGoogleへ投げることになる。どちらとも判断できないものは拒否する
 * (フェイルクローズ)。
 *
 * **未指定は android。** 既存のAndroid(TWA)のクライアントは billing.js が
 * `{purchase_token, product_id}` しか送らないので、この既定が無いと
 * 出回っているアプリが全部止まる。
 */
export function parsePlatform(raw: unknown): Platform | null {
  if (raw === 'ios') return 'ios'
  if (raw === undefined || raw === null || raw === 'android') return 'android'
  return null
}

/**
 * Playの購入トークンの上限。**100〜200文字が実測**なので、余裕を見てもこれで足りる。
 * 長い入力でDBやログを膨らませないための歯止め。
 */
export const MAX_PLAY_TOKEN_LENGTH = 4096

/**
 * AppleのJWSの上限。
 *
 * **Playと同じ4096では通らない。** JWSのヘッダには x5c(証明書チェーン3枚)が
 * base64で丸ごと入り、証明書1枚がDERで1〜1.5KB＝base64で1.4〜2KB。ヘッダだけで
 * 4〜6KBになり、ペイロードと署名を足すと5〜8KBが実測レンジ(レジャー帳で
 * 2026-08-25、Sandboxの購入が入口の `invalid parameters` で弾かれた)。
 *
 * 16384は実測の倍以上。Appleが証明書を増やしても当面は足りるが、無制限には
 * しない——長い入力を握らせない、という歯止めの意味は残す。
 */
export const MAX_APPLE_JWS_LENGTH = 16384

/**
 * AppleのJWSとして受け付けられる形か。
 *
 * **署名は検証しない**(それはAppleへの問い合わせが担う。[transactionIdFromJws]
 * の説明を参照)。ここで見るのは「ドット区切りの3パートで、各パートが
 * base64urlの文字だけでできているか」という入口の形だけ。
 *
 * 目的は、**Playのトークンや無関係な文字列がiOS経路へ流れ込むのを止めること**。
 */
export function looksLikeJws(token: string): boolean {
  if (token.length === 0 || token.length > MAX_APPLE_JWS_LENGTH) return false
  const parts = token.split('.')
  if (parts.length !== 3) return false
  // base64urlは A-Z a-z 0-9 - _ のみ(パディングの = は付かない)。
  const b64url = /^[A-Za-z0-9_-]+$/
  return parts.every((p) => p.length > 0 && b64url.test(p))
}

/**
 * 購入の証跡が、そのストアの形として妥当か。
 *
 * **ストアごとに形が違う。** Playのトークンは短い不透明な文字列、AppleのJWSは
 * ドット区切りの長い署名付きトークン。同じ上限で受けるとどちらかが通らない。
 */
export function isAcceptableToken(token: string, platform: Platform): boolean {
  if (platform === 'ios') return looksLikeJws(token)
  return token.length > 0 && token.length <= MAX_PLAY_TOKEN_LENGTH
}

/**
 * Appleのサーバーには本番とSandboxの2つがあり、**どちらに問い合わせるかは
 * こちらでは分からない**。
 *
 * Appleの推奨は「まず本番へ問い合わせ、4040010(トランザクションが無い)が
 * 返ったらSandboxへ問い直す」。Sandboxのトランザクションは本番には存在しないので、
 * この順で必ず見つかる。
 *
 * 逆順(Sandbox優先)にしないのは、本番の購入がSandboxに無いぶん、全利用者の
 * 検証で毎回1往復むだになるため。
 */
export const APPLE_API_PRODUCTION =
  'https://api.storekit.itunes.apple.com/inApps/v1/transactions'
export const APPLE_API_SANDBOX =
  'https://api.storekit-sandbox.itunes.apple.com/inApps/v1/transactions'

/** 本番に無いトランザクションを指すAppleのエラーコード。 */
export const APPLE_TRANSACTION_NOT_FOUND = 4040010

/**
 * 本番の応答を見て、Sandboxへ問い直すべきか判断する。
 *
 * 回すのは2つの場合だけ。
 *
 * ## 1. 404かつ 4040010
 * 「その取引は本番に無い」とAppleが明示した場合。Sandboxの購入は本番に存在
 * しないので、この経路で見つかる。Appleの推奨どおりの並び。
 *
 * ## 2. 401
 * **アプリがApp Storeで公開されるまで、本番の App Store Server API は
 * 資格情報が正しくても401を返す。** レジャー帳で2026-08-25に実測
 * (Supabaseを通さず同じ4つの値で叩いて **Sandbox=認証OK／本番=401**)。
 * 401でSandboxへ回さないと、**公開前はiOSの購入を一度も検証できない**。
 * 艇読みのiOS版はこれから審査に出す段階なので、まさにこの状態から始まる。
 *
 * **公開後の挙動は変わらない。** 本番が200を返すようになればSandboxには回らず、
 * 審査員のSandbox購入は従来どおり 404+4040010 の経路で通る。
 *
 * ## ただし許可制(WP-3f)
 *
 * この問い直しは `APPLE_ALLOW_SANDBOX="true"` のときだけ働く。Sandboxの購入は
 * 無料なので、常時開けておくと**無料で本番の権利が取れる**。審査に出す前と
 * 更新審査のあいだだけ開ける運用にしてある(docs/ops/appstore-verify-deploy.md)。
 *
 * **「本番が無効と言ったものをSandboxで有効にする」経路は増えていない。**
 * 401は「答えを聞けていない」であって「無効」ではない。無効の判断は
 * [entitlementFromAppleTransaction] が応答の中身を見て下す。
 *
 * それ以外の404(URLの誤りなど)や5xxは回さない。障害のときに二重に叩くだけで
 * 結果は変わらない。
 */
export function shouldRetryInSandbox(
  status: number,
  body: { errorCode?: number } | null,
  allowSandbox: boolean,
): boolean {
  // **許可されていなければ、そもそも問い直さない**(WP-3f)。
  // 叩かなければSandbox由来の応答が入り込む余地が無い。二重の守り
  // ([appleSourceAllowed])のうち、こちらが1枚目。
  if (!allowSandbox) return false
  if (status === 401) return true
  return status === 404 && body?.errorCode === APPLE_TRANSACTION_NOT_FOUND
}

/** [fetchAppleTransaction] が応答に求める最小限の形(Responseがそのまま通る)。 */
export type AppleResponse = {
  ok: boolean
  status: number
  json: () => Promise<unknown>
}

export type AppleTransactionResult = {
  /** 採用する応答。Sandboxへ回った場合はそちら。 */
  res: AppleResponse
  productionStatus: number
  /** Sandboxを叩かなかったときは null。 */
  sandboxStatus: number | null
  /** ログに出す1行(例: `production=401 sandbox=200`)。 */
  trace: string
}

/**
 * 本番 →(必要なら)Sandbox の順に問い合わせる。
 *
 * **どちらをどう叩いたかを必ず持ち帰る。** 片方のステータスしか残らないと、
 * 「本番で止まったのか、Sandboxまで行って駄目だったのか」がログから分からず、
 * 本番401でSandboxに到達していないことに気づくのが遅れる(レジャー帳で実際に遅れた)。
 *
 * 問い合わせ自体は呼び出し側から渡す——ここを純粋に保つと、並び順の判断を
 * 実際に動かして確かめられる。
 */
export async function fetchAppleTransaction(
  fetchTx: (base: string) => Promise<AppleResponse>,
  opts: { allowSandbox: boolean },
): Promise<AppleTransactionResult> {
  const production = await fetchTx(APPLE_API_PRODUCTION)
  let res = production
  let sandboxStatus: number | null = null

  if (!production.ok) {
    let body: { errorCode?: number } | null = null
    try {
      body = await production.json() as { errorCode?: number }
    } catch { /* 本文が読めなくても判断は続ける */ }
    if (shouldRetryInSandbox(production.status, body, opts.allowSandbox)) {
      res = await fetchTx(APPLE_API_SANDBOX)
      sandboxStatus = res.status
    }
  }

  return {
    res,
    productionStatus: production.status,
    sandboxStatus,
    trace: `production=${production.status} sandbox=${sandboxStatus ?? '-'}`,
  }
}

/** Appleが返すトランザクション情報のうち、判定に使う部分。 */
export type AppleTransaction = {
  productId?: string
  bundleId?: string
  expiresDate?: number
  type?: string
  revocationDate?: number
  /** この取引そのもののID。**要求したIDと一致することを確かめる**([appleTransactionMatches])。 */
  transactionId?: string
  /** 購読の初回購入のID。**行の鍵はこれ**([appleRowKey])。 */
  originalTransactionId?: string
  /** 'Production' | 'Sandbox'。[appleSourceAllowed] が見る。 */
  environment?: string
}

/**
 * **行の鍵は、Appleが答えたIDから作る**(WP-3f)。
 *
 * ## なぜクライアントの復号値では駄目なのか
 *
 * [membershipRowKey] はクライアントが送ってきたJWSを**署名検証せずに**復号して
 * originalTransactionId を取り出す。Appleへ問い合わせるのは同じペイロードの
 * 別フィールド(transactionId)なので、**2つは独立に偽造できる**。
 *
 * 本物の transactionId を1つ持っていれば、originalTransactionId だけを毎回
 * 違う値にして送ることで、Appleの200を取りながら毎回別の鍵で行を作れる——
 * [tokenTakenByOther] も一意索引も一度も発火せず、**支払い1件で無制限の
 * アカウントがプレミアムになる**(2026-09-11のセキュリティ点検 Vuln 1)。
 *
 * だから鍵はAppleの応答から作る。originalTransactionId が無ければ
 * transactionId に落とす(membershipRowKey と同じ優先順)。
 */
export function appleRowKey(tx: AppleTransaction): string | null {
  const original = tx.originalTransactionId
  if (typeof original === 'string' && original.length > 0) return original
  const id = tx.transactionId
  if (typeof id === 'string' && id.length > 0) return id
  return null
}

/**
 * Appleが答えたのが、こちらが聞いた取引かを確かめる。
 *
 * Get Transaction Info は渡したIDの取引を返すので、一致するのが正常。
 * **一致しない・入っていないものは無効に倒す**(取り違えた応答を権利の
 * 根拠にしない)。
 */
export function appleTransactionMatches(
  tx: AppleTransaction,
  requestedId: string,
): boolean {
  // 空同士を一致と読まない。空になるのは「入っていない」ときなので、
  // それを照合が通った証拠にしてはいけない。
  if (requestedId.length === 0) return false
  return typeof tx.transactionId === 'string' && tx.transactionId === requestedId
}

/**
 * Sandboxへの問い直しを許してよいか。
 *
 * **Secret `APPLE_ALLOW_SANDBOX` が文字列 "true" のときだけ許す。**
 * 未設定・空・それ以外は許さない。設定を忘れたら「本番だけを見る」に倒れる
 * ——Secretsまわりの他の判定([secretsConfigured] / [appleSecretsConfigured])と
 * 同じ、厳しい側が既定という構え。
 */
export function sandboxAllowed(raw: string | undefined | null): boolean {
  return raw === 'true'
}

/**
 * その取引を、いまの設定で権利の根拠にしてよいか。
 *
 * ## なぜ要るのか
 *
 * Sandboxの購入は**無料**。Sandboxの応答をそのまま本番の権利にすると、
 * TestFlightのテスターが誰でもタダでプレミアムになれる(2026-09-11の
 * セキュリティ点検 Vuln 2)。404+4040010 の問い直しは恒久的な分岐なので、
 * 公開後も自然には閉じない。
 *
 * 見るのは2つ。**どちらか片方でもSandboxを指していたら拒否する。**
 *
 *   fromSandbox   … Sandboxのエンドポイントが答えたか(呼び出し側が持っている)
 *   tx.environment … Appleが取引に付けている環境名
 *
 * environment が入っていないときは判断材料が無いだけなので、
 * エンドポイントのほうだけで決める(本番が答えたなら本番の取引)。
 */
export function appleSourceAllowed(
  tx: AppleTransaction,
  opts: { fromSandbox: boolean; allowSandbox: boolean },
): { ok: boolean; reason: string } {
  if (opts.allowSandbox) return { ok: true, reason: 'sandbox allowed' }
  if (opts.fromSandbox) {
    return { ok: false, reason: 'sandbox response not allowed' }
  }
  const env = tx.environment
  if (typeof env === 'string' && env !== 'Production') {
    return { ok: false, reason: 'sandbox transaction not allowed' }
  }
  return { ok: true, reason: 'production' }
}

/**
 * Appleのトランザクションを、こちらの権利へ翻訳する。
 *
 * ## 有効と答える条件(4つ全部)
 *
 * - bundleId がこのアプリのものであること——**他アプリの購入で権利を主張させない**
 * - productId が申告された商品と一致すること——安いほうを買って高いほうの
 *   権利を主張する経路を塞ぐ
 * - 返金・取り消し(revocationDate)が無いこと
 * - expiresDate が未来であること
 *
 * ひとつでも欠ければ無効。expiresDate が無い(＝消耗型・買い切り)ものも
 * 購読ではないので無効に倒す。parseSubscription(Play側)と同じ構え。
 */
export function entitlementFromAppleTransaction(
  tx: AppleTransaction,
  opts: { expectedProductId: string; expectedBundleId: string; now: number },
): { isActive: boolean; expiry: string | null; reason: string } {
  if (tx.bundleId !== opts.expectedBundleId) {
    return { isActive: false, expiry: null, reason: 'bundle mismatch' }
  }
  if (tx.productId !== opts.expectedProductId) {
    return { isActive: false, expiry: null, reason: 'product mismatch' }
  }
  if (typeof tx.revocationDate === 'number') {
    return { isActive: false, expiry: null, reason: 'revoked' }
  }
  if (typeof tx.expiresDate !== 'number') {
    return { isActive: false, expiry: null, reason: 'no expiry' }
  }
  const expiry = new Date(tx.expiresDate).toISOString()
  if (tx.expiresDate <= opts.now) {
    return { isActive: false, expiry, reason: 'expired' }
  }
  return { isActive: true, expiry, reason: 'ok' }
}

/**
 * JWSのペイロードを**署名検証せずに**取り出す。
 *
 * ## なぜ検証しないのか
 *
 * ここで欲しいのはIDだけで、**その値は信用しない**。値をAppleのサーバーへ投げ、
 * Appleの応答を権威とする(Androidが purchase_token をGoogleへ投げるのと同じ形)。
 * 偽のIDを送られてもAppleが「無い」と答えるだけ。
 *
 * 署名を自前で検証しようとすると、x5cの証明書チェーン(リーフ←中間←ルート)を
 * X.509までパースして辿る必要がある。**リーフの公開鍵だけで検証するのは危険**で、
 * 攻撃者は自己署名の証明書をx5cに入れて好きなペイロードに署名できる。
 * 「ルート証明書の指紋を比べる」を足しても、x5cに本物のルートを混ぜるだけで
 * すり抜ける。連鎖を省いた検証は検証ではない。Appleへ問い合わせるほうが安全かつ簡単。
 */
function payloadFromJws(jws: string): Record<string, unknown> | null {
  const parts = jws.split('.')
  if (parts.length !== 3) return null
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4))
    const json = JSON.parse(atob(b64 + pad))
    if (typeof json !== 'object' || json === null) return null
    return json as Record<string, unknown>
  } catch {
    return null
  }
}

/** 先に見つかった空でない文字列を返す。無ければ null。 */
function firstNonEmptyString(
  payload: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

/**
 * **Appleへ問い合わせるためのID。**
 *
 * ここは transactionId(その取引そのものを指すID)を使う。Get Transaction Info は
 * 渡されたIDの取引を返すので、originalTransactionId(購読の初回購入のID)を渡すと
 * **初回期間の expiresDate** が返ってきかねない——とうに過ぎているので
 * reason=expired になり、有効な購読者が締め出される。
 *
 * **行の鍵([membershipRowKey])とは別物**なので、混ぜないこと。
 * あちらは更新をまたいで変わらないことが要る。
 */
export function transactionIdFromJws(jws: string): string | null {
  const payload = payloadFromJws(jws)
  if (payload === null) return null
  return firstNonEmptyString(payload, ['transactionId', 'originalTransactionId'])
}

/**
 * memberships の行を指す鍵(＝ purchase_token 列に入れる値)。
 *
 * ## なぜAndroidと分けるのか
 *
 * Playの purchase_token は**購読が更新されても変わらない**ので、そのまま鍵に
 * できる。AppleのJWSは違う——更新のたびに丸ごと別の文字列になり、中の
 * transactionId も変わる。
 *
 * ## これが無いと何が壊れるか(レジャー帳で2026-08-25に判明)
 *
 * 行を引くときの条件がクライアントの送ってきた**JWSそのもの**で、保存するときの
 * 値は transactionId だった。**形が違うので永久に一致しない。** 結果、
 *
 * - 24時間キャッシュが一度もヒットせず、起動のたびにAppleへ照会していた
 * - 使い回しの検出([tokenTakenByOther])が常に「誰も使っていない」と読まれ、
 *   iOSでは一度も効いていなかった
 * - 更新のたびに同じ購読の行が増え続けていた
 *
 * originalTransactionId は**購読が続くかぎり変わらない**ので、これを鍵にすれば
 * 3つとも直る。取れないJWS(消耗型など)は transactionId に落とす。
 *
 * **艇読みでは購入トークンに一意索引が張ってある**(memberships_purchase_token_key)。
 * 鍵が更新のたびに変わると、1人の購読者が毎月「別人のトークン」を名乗ることになり、
 * 使い回し検出の意味が消える。ここを間違えないことが、そのまま課金の守りになる。
 */
export function membershipRowKey(token: string, platform: Platform): string | null {
  if (platform === 'android') return token.length > 0 ? token : null
  const payload = payloadFromJws(token)
  if (payload === null) return null
  return firstNonEmptyString(payload, ['originalTransactionId', 'transactionId'])
}

/**
 * Apple照会に必要なSecretsが揃っているか。
 *
 * **揃っていなければ検証できない＝無効。** Play側の [secretsConfigured] と
 * まったく同じ構えで、「設定を忘れたら素通り」にだけは絶対にしない。
 * APPLE_* を入れるまで、iOSでは誰もプレミアムにならない。
 * 空文字も未設定と同じ扱いにする(secrets set で空を入れた事故を通さない)。
 */
export function appleSecretsConfigured(
  keyId: string | undefined | null,
  issuerId: string | undefined | null,
  privateKey: string | undefined | null,
  bundleId: string | undefined | null,
): boolean {
  return !!keyId && !!issuerId && !!privateKey && !!bundleId
}
