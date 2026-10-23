// 朝の便で起きた想定外の失敗を、便の最後にまとめて GitHub Issue で知らせる(2026-10-23)。
//
// 【なぜ要るのか】
// 1人の失敗で全員の通知が止まらないよう、利用者ごとに例外を受け止めて次の人へ進むようにした
// (点検の中-1・中-2)。そのままでは失敗が黙って消えるので、便の最後に失敗の一覧を付けて
// GitHub の push-failures.yml を起動し、そこで Issue を立てる。CI便・cron便のどちらで
// 起きても知らせるため、関数の側から起動する(鍵は kick-github と同じ GITHUB_KICK_TOKEN)。
//
// 【書くもの・書かないもの】
// boat-card は公開リポジトリなので、Issue も誰でも読める。書くのは利用者IDの先頭8文字と、
// 何が起きたかの種類と件数だけ。通知の文面・宛先URL・条件の中身は書かない。
// 期限切れの宛先(404・410)は普段から起きるので、ここには入れない(片付けるだけ)。

/** 失敗の種類。push-failures.yml(scripts/notify_push_failures.py)が日本語の説明に直す。 */
export type FailureKind =
  | 'cond_shape'   // 保存した条件の形が壊れていて照合できない(その条件だけ飛ばした)
  | 'cond_error'   // 条件の照合で例外(その条件だけ飛ばした)
  | 'user_error'   // その人の処理で想定外の例外(その人だけ飛ばした)
  | 'web_blocked'  // 宛先が通知サービスのURLではない(送らなかった)
  | 'web_timeout'  // 宛先が時間切れ
  | 'web_error'    // 宛先が 404・410 以外の失敗を返した(後ろに状態コード)
  | 'ios_error'    // iOS アプリへの送信の失敗(届かない端末の片付けは除く)
  | 'log_error'    // 送信記録を書けなかった(次の便で重複して届きうる)
  | 'run_error'    // 便そのものが想定外の例外で止まった
  | 'drill'        // 稽古(通知の配線を確かめるための、わざとの1件)

/** 知らせる1行。user は利用者IDの先頭8文字(便全体のことは '-')。 */
export type Failure = { user: string; kind: string; n: number }

/** 便のあいだ、失敗を (利用者, 種類) ごとに数えておく。 */
export class FailureLog {
  private counts = new Map<string, Failure>()

  add(userId: string | null, kind: FailureKind, detail?: string | number): void {
    const user = userId ? userId.slice(0, 8) : '-'
    const k = detail === undefined ? kind : `${kind}:${detail}`
    const key = `${user}|${k}`
    const cur = this.counts.get(key)
    if (cur) cur.n++
    else this.counts.set(key, { user, kind: k, n: 1 })
  }

  get size(): number {
    return this.counts.size
  }

  list(): Failure[] {
    const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0)
    return [...this.counts.values()].sort((a, b) => cmp(a.user, b.user) || cmp(a.kind, b.kind))
  }
}

const REPO = 'jamjam315/boat-card'
const WORKFLOW = 'push-failures.yml'
const MAX_ITEMS = 200       // workflow_dispatch の入力は合わせて 65,535 文字まで。余りは件数だけ送る
const TIMEOUT_MS = 10000

/** x-trigger は呼び出し側が付ける値なので、Issue に書く前に形を縛る。 */
function safeTrigger(trigger: string): string {
  return /^[a-z0-9_-]{1,20}$/i.test(trigger) ? trigger : 'other'
}

/** push-failures.yml に渡す入力(テストで中身を確かめるために分けてある)。 */
export function dispatchBody(date: string, trigger: string, failures: Failure[]) {
  const items = failures.slice(0, MAX_ITEMS)
  return {
    ref: 'main',
    inputs: {
      date,
      trigger: safeTrigger(trigger),
      failures: JSON.stringify({ items, more: failures.length - items.length }),
    },
  }
}

/**
 * push-failures.yml を起動して Issue を立ててもらう。起動できたら true。
 * ここは失敗しても投げない(知らせ損ねても、送信の結果そのものは変わらないため)。
 * 起動できなかったことは、関数の応答(reported:false)とログに残る。
 */
export async function reportFailures(
  date: string, trigger: string, failures: Failure[], fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (failures.length === 0) return true
  const token = Deno.env.get('GITHUB_KICK_TOKEN')
  if (!token) {
    console.error('[failure-report] GITHUB_KICK_TOKEN が未設定のため、失敗を Issue で知らせられません')
    return false
  }
  try {
    const res = await fetchImpl(
      `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'teiyomi-send-morning-push',
          'content-type': 'application/json',
        },
        body: JSON.stringify(dispatchBody(date, trigger, failures)),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    )
    if (res.status === 204) {
      console.log(`[failure-report] ${WORKFLOW} を起動しました(${failures.length}行)`)
      return true
    }
    const text = await res.text().catch(() => '')
    console.error(`[failure-report] ${WORKFLOW} を起動できませんでした HTTP ${res.status}: ${text.slice(0, 300)}`)
    return false
  } catch (err) {
    console.error(`[failure-report] ${WORKFLOW} に届きませんでした: ${err}`)
    return false
  }
}
