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
 * 購読は更新されてもトークンが変わらないので、毎回Googleに問い合わせる必要はない。
 * この関数がGoogleへの問い合わせ回数の上限も兼ねている(専用のレート制限表を持たない)。
 * 期限そのものは is_premium() 側でも見ているので、キャッシュを返しても
 * 期限切れの人が通ることはない。
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
  return age < ttlMs
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
