// Supabase Cron から GitHub Actions のワークフローを起動する(タスク⑥)。
//
// 【なぜ要るのか】
// GitHub Actions の schedule(cron) は混雑すると大幅に遅れる。実測で、
// 平常時は +12〜29分だったものが 2026-08-26 以降に悪化し、
//   8/27 旧22:30便 → +5時間00分 / 旧23:30便 → +5時間09分
//   8/28 結果収集   → +8時間42分 / 毎朝データ更新 → +3時間09分(3便中1便のみ発火)
// という状態になった。2便は発火すらしていない。githubstatus.com には
// 載らない規模だが、サイトのデータが半日古いままになる。
//
// workflow_dispatch は即座に起動するので、正確な Supabase Cron から叩いて
// 起動経路をGitHubのcronから切り離す。GitHub側のcronは消さずに残し、
// どちらが動いても同じ結果になるようにしてある(各ワークフローの鮮度ガードと
// concurrency が二重起動を吸収する)。
//
// 【起動方法】
//   POST https://<project>.supabase.co/functions/v1/kick-github
//   ヘッダー: x-cron-secret: <CRON_SECRET>
//   本文:     {"workflow": "daily.yml"}          … ref/inputs は省略可
// send-morning-push / send-delay-notice と同じ流儀。Cron は Supabase の
// JWT を持たないので config.toml で verify_jwt = false にし、
// 代わりにここで x-cron-secret を突き合わせる(鍵は既存のものを共用)。
//
// 【必要なSecret】
//   CRON_SECRET        … 既存(朝の通知と共用)
//   GITHUB_KICK_TOKEN  … 新規。Fine-grained PAT。boat-card のみ / Actions: Read and write
//
// 【無音の失敗を作らない】
// PATは最長でも1年で期限が切れる。切れたことに気づけないと、今回の
// 「45日間ずっと失敗していたのにCIは緑」と同じ形になる。状態ごとに
// 何が起きたかを断定してログに出す(401/403なら「PATが無効か権限不足」と書く)。
// 起動しそこねた場合は、既存の send-delay-notice(10:15 JST)が
// 「データが更新されていない」ことを検知して通知するので、通知経路は増やさない。
const OWNER = 'jamjam315'
const REPO = 'boat-card'
const DEFAULT_REF = 'main'
const TIMEOUT_MS = 20000

// 叩いてよいワークフローを列挙する。ここに無い名前は受け付けない。
// 万一 CRON_SECRET が漏れても、任意のワークフローを起動されないようにするため。
const ALLOWED = new Set(['daily.yml', 'results.yml', 'x-post-daily.yml'])

const JSON_HEADERS = { 'content-type': 'application/json' }

function reply(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
}

/** GitHubの応答から、何が起きたのかを人が読める形にする。 */
function explain(status: number): string {
  if (status === 204) return '起動しました'
  if (status === 401) return 'PATが無効か期限切れです（GITHUB_KICK_TOKEN を作り直してください）'
  if (status === 403) return 'PATの権限が足りないか、レート制限です（Actions: Read and write が要ります）'
  if (status === 404) {
    return 'ワークフローかリポジトリが見つかりません（ファイル名・PATのリポジトリ選択を確認）'
  }
  if (status === 422) return 'refかinputsが不正です（ブランチ名・入力の型を確認）'
  if (status === 429) return 'レート制限です'
  if (status >= 500) return 'GitHub側の障害です'
  return '想定外の応答です'
}

export default {
  async fetch(req: Request): Promise<Response> {
    // ---- 起動保護 ----
    const secret = Deno.env.get('CRON_SECRET')
    if (!secret || req.headers.get('x-cron-secret') !== secret) {
      console.error('[kick-github] x-cron-secret が一致しませんでした')
      return new Response('unauthorized', { status: 401 })
    }
    if (req.method !== 'POST') return reply(405, { ok: false, reason: 'method not allowed' })

    let body: Record<string, unknown> = {}
    try {
      const raw = await req.text()
      if (raw.trim()) body = JSON.parse(raw)
    } catch {
      console.error('[kick-github] 本文がJSONとして読めませんでした')
      return reply(400, { ok: false, reason: 'invalid json' })
    }

    const workflow = typeof body.workflow === 'string' ? body.workflow : ''
    if (!ALLOWED.has(workflow)) {
      console.error(
        `[kick-github] 知らないワークフローです: ${JSON.stringify(workflow)} ` +
          `(許可: ${[...ALLOWED].join(', ')})`,
      )
      return reply(400, { ok: false, reason: 'unknown workflow' })
    }
    const ref = typeof body.ref === 'string' && body.ref ? body.ref : DEFAULT_REF
    // inputs は省略可。省略すればワークフロー側の既定値が使われる。
    const inputs = (body.inputs && typeof body.inputs === 'object')
      ? body.inputs as Record<string, unknown>
      : undefined

    const token = Deno.env.get('GITHUB_KICK_TOKEN')
    if (!token) {
      // Secretの入れ忘れをここで言い切る。黙って何もしないと、
      // 「なぜか毎晩起動しない」だけが残って原因に辿り着けない。
      console.error(
        '[kick-github] GITHUB_KICK_TOKEN が未設定です。' +
          'Supabaseの Edge Function Secrets に登録してください。',
      )
      return reply(500, { ok: false, reason: 'token not configured' })
    }

    const url = `https://api.github.com/repos/${OWNER}/${REPO}` +
      `/actions/workflows/${encodeURIComponent(workflow)}/dispatches`

    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          // GitHubはUser-Agentが無いと拒否することがある。
          'user-agent': 'teiyomi-kick-github',
          'content-type': 'application/json',
        },
        body: JSON.stringify(inputs ? { ref, inputs } : { ref }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (e) {
      // 起動できたかどうかは分からない。ここで投げ直さない
      // (二重起動そのものは各ワークフローが吸収するが、無駄な負荷は掛けない)。
      console.error(`[kick-github] ${workflow} に届きませんでした: ${e}`)
      return reply(502, { ok: false, workflow, reason: 'request failed' })
    }

    // 成功は 204 No Content。本文は空。
    const text = res.status === 204 ? '' : await res.text()
    const remaining = res.headers.get('x-ratelimit-remaining') ?? '-'

    if (res.status === 204) {
      console.log(
        `[kick-github] ${workflow} (${ref}) を起動しました / 残りレート ${remaining}`,
      )
      return reply(200, { ok: true, workflow, ref })
    }

    console.error(
      `[kick-github] ${workflow} の起動に失敗 HTTP ${res.status}: ${explain(res.status)}` +
        ` / 残りレート ${remaining} / 応答: ${text.slice(0, 500)}`,
    )
    return reply(502, {
      ok: false,
      workflow,
      github_status: res.status,
      reason: explain(res.status),
    })
  },
}
