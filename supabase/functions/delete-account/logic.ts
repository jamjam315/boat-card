// delete-account の判断部分。通信もDBアクセスもしない純粋な関数だけを置く。
//
// ここを index.ts から切り離しているのは、テストで全分岐を通せるようにするため。
// **消し忘れると個人情報が残り、消しすぎると他人のデータを壊す**という、
// 事故ったときの被害が大きい判断なので、実際に走らせて確かめられる形にしておく
// (logic_test.ts)。verify-purchase と同じ作法。

/**
 * 利用者を消すときに、**auth.users を消すだけでは残ってしまう**表。
 *
 * ## なぜ一覧を持つ必要があるのか
 *
 * Supabaseの管理APIで auth.users の行を消すと、`references auth.users(id)
 * on delete cascade` を持つ表は一緒に消える。艇読みの表は10個あり、そのうち
 * 9個はこの宣言を持っている(2026-09-07にマイグレーションで確認):
 *
 *   memberships / push_subscriptions / push_send_log / push_notice_log /
 *   race_alerts / verification_notes / yomi_ai_daily / yomi_ai_free /
 *   yomi_ai_reports
 *
 * **favorite_players だけが持っていない。** この表は早い時期にSQL Editorから
 * 手で作られたもので、`user_id uuid not null` としか宣言されていない
 * (20260728120802_record_favorite_players.sql に実DBの定義がそのまま
 * 記録されている)。つまり利用者を消してもお気に入りの行は残る。
 *
 * だからここで明示的に消す。将来この表に外部キーを足したとしても、
 * 二重に消すだけで害は無い(消えている行を消しても0行更新)。
 *
 * **表が増えたらここも見直すこと。** 新しい表に
 * `on delete cascade` が付いていれば足す必要は無い。
 */
export const TABLES_WITHOUT_CASCADE: readonly string[] = ['favorite_players']

/** 呼び出しを受け付けてよいHTTPメソッドか。 */
export function isAllowedMethod(method: string): boolean {
  return method === 'POST'
}

/**
 * 削除してよい利用者か。
 *
 * **リクエストの中身は一切見ない。** 消すのは「JWTの持ち主」だけで、
 * 本文でIDを受け取る口を作らない。作ってしまうと、他人のIDを書いて
 * 送るだけでアカウントを消せる関数になる。
 *
 * 匿名アカウントも消せる。お気に入りは匿名のうちから貯まるので、
 * 「ログインしていないから消せません」では削除の依頼に応えられない。
 */
export function subjectFromClaims(
  claims: Record<string, unknown> | undefined,
): string | null {
  const id = claims?.id
  if (typeof id !== 'string') return null
  // uuid の形だけ確かめる。JWTはプラットフォーム側で検証済みなので、
  // ここは「想定外の形が来ていないか」の念のための確認。
  return isUuid(id) ? id : null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(s: string): boolean {
  return UUID.test(s)
}

/**
 * ログに出す識別子。
 *
 * **利用者IDをそのまま残さない。** 消したという記録は運用に要るが、
 * 誰を消したかが後から特定できる必要は無い。先頭8桁だけにする
 * (verify-purchase と同じ長さ)。
 */
export function logId(userId: string): string {
  return userId.slice(0, 8)
}
