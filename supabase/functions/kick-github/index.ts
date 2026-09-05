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
//   本文:     {"workflow": "daily.yml"}                       … boat-card
//             {"repo": "mtpworks-x-bot",
//              "workflow": "generate-daily.yml"}              … x-bot
//   repo / ref / inputs は省略可。repo を省くと boat-card。
// send-morning-push / send-delay-notice と同じ流儀。Cron は Supabase の
// JWT を持たないので config.toml で verify_jwt = false にし、
// 代わりにここで x-cron-secret を突き合わせる(鍵は既存のものを共用)。
//
// 【複数リポジトリ対応(2026-09-05)】
// mtpworks-x-bot も同じ仕組みで起動する。既存の3便は本文に repo を
// 入れていないので、省略時の既定を boat-card にして触らずに済ませてある。
// Cron の登録も既存3件はそのまま。
//
// 【必要なSecret】
//   CRON_SECRET        … 既存(朝の通知と共用)
//   GITHUB_KICK_TOKEN  … 既存。boat-card 用の Fine-grained PAT / Actions: Read and write
//   XBOT_KICK_TOKEN    … mtpworks-x-bot 用。2026-09-05 に JAM が登録済み
// PATはリポジトリを選んで発行するので、1本のPATで両方を叩くこともできるが、
// リポジトリごとに分けてある。片方が漏れても片方は無事なため。
// **鍵はリポジトリで切り替える。足りなければ他方で代用しない。**
// 代用すると、対象リポジトリの入っていないPATで叩いて 404 が返り、
// 「ワークフロー名が違うのか、鍵が違うのか」が切り分けられなくなる。
// 既存の GITHUB_KICK_TOKEN には手を触れない。
//
// 【無音の失敗を作らない】
// PATは最長でも1年で期限が切れる。切れたことに気づけないと、今回の
// 「45日間ずっと失敗していたのにCIは緑」と同じ形になる。状態ごとに
// 何が起きたかを断定してログに出す(401/403なら「PATが無効か権限不足」と書く)。
// 起動しそこねた場合、boat-card は既存の send-delay-notice(10:15 JST)が
// 「データが更新されていない」ことを検知して通知する。x-bot は投稿枠のあいだ
// GitHub側のcron(15分間隔)が第一層として動いているので、キッカーが黙っても
// 投稿は落ちない(逆にGitHubのcronが飛んだ日をキッカーが拾う)。
const DEFAULT_REF = 'main'
const TIMEOUT_MS = 20000

// 叩いてよいリポジトリとワークフローを列挙する。ここに無い名前は受け付けない。
// 万一 CRON_SECRET が漏れても、任意のワークフローを起動されないようにするため。
const REPOS: Record<
  string,
  { owner: string; workflows: Set<string>; tokenEnv: string }
> = {
  'boat-card': {
    owner: 'jamjam315',
    workflows: new Set(['daily.yml', 'results.yml', 'x-post-daily.yml']),
    tokenEnv: 'GITHUB_KICK_TOKEN',
  },
  'mtpworks-x-bot': {
    owner: 'jamjam315',
    // 生成の便だけ。x-post-test.yml(実投稿するテスト)はここに入れない。
    workflows: new Set(['generate-daily.yml']),
    tokenEnv: 'XBOT_KICK_TOKEN',
  },
}
// repo を省いた本文は boat-card 宛。既存3便の互換のため必ずここを既定にする。
const DEFAULT_REPO = 'boat-card'

const JSON_HEADERS = { 'content-type': 'application/json' }

function reply(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
}

/** GitHubの応答から、何が起きたのかを人が読める形にする。 */
function explain(status: number): string {
  if (status === 204) return '起動しました'
  if (status === 401) return 'PATが無効か期限切れです（ログに出ている鍵を作り直してください）'
  if (status === 403) return 'PATの権限が足りないか、レート制限です（Actions: Read and write が要ります）'
  if (status === 404) {
    // 複数リポジトリを叩くようになってから、いちばん出やすいのがこれ。
    // PATは対象リポジトリを選んで発行するので、選び忘れたリポジトリは
    // 「存在しない」と同じ 404 になる（権限不足の 403 にはならない）。
    return 'ワークフローかリポジトリが見つかりません（ファイル名と、PATの対象リポジトリにそのリポジトリが入っているかを確認）'
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

    const repoName = typeof body.repo === 'string' && body.repo
      ? body.repo
      : DEFAULT_REPO
    const target = REPOS[repoName]
    if (!target) {
      console.error(
        `[kick-github] 知らないリポジトリです: ${JSON.stringify(repoName)} ` +
          `(許可: ${Object.keys(REPOS).join(', ')})`,
      )
      return reply(400, { ok: false, reason: 'unknown repo' })
    }

    const workflow = typeof body.workflow === 'string' ? body.workflow : ''
    if (!target.workflows.has(workflow)) {
      console.error(
        `[kick-github] ${repoName} で知らないワークフローです: ` +
          `${JSON.stringify(workflow)} ` +
          `(許可: ${[...target.workflows].join(', ')})`,
      )
      return reply(400, { ok: false, repo: repoName, reason: 'unknown workflow' })
    }
    const ref = typeof body.ref === 'string' && body.ref ? body.ref : DEFAULT_REF
    // inputs は省略可。省略すればワークフロー側の既定値が使われる。
    const inputs = (body.inputs && typeof body.inputs === 'object')
      ? body.inputs as Record<string, unknown>
      : undefined

    // 鍵はリポジトリで決まる。無くても他方で代用しない(上の【必要なSecret】)。
    // 使った鍵の名前は必ずログに出す。404 のとき「PATの対象にそのリポジトリが
    // 入っていない」を疑えるようにするため。値そのものは絶対に出さない。
    const token = Deno.env.get(target.tokenEnv)
    const tokenUsed = target.tokenEnv
    if (!token) {
      // Secretの入れ忘れをここで言い切る。黙って何もしないと、
      // 「なぜか毎晩起動しない」だけが残って原因に辿り着けない。
      console.error(
        `[kick-github] ${repoName} 用の ${target.tokenEnv} が未設定です。` +
          'Supabaseの Edge Function Secrets に登録してください' +
          '(他のリポジトリの鍵では代用しません)。',
      )
      return reply(500, {
        ok: false,
        repo: repoName,
        reason: `token not configured (${target.tokenEnv})`,
      })
    }

    const url = `https://api.github.com/repos/${target.owner}/${repoName}` +
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
      console.error(`[kick-github] ${repoName}/${workflow} に届きませんでした: ${e}`)
      return reply(502, { ok: false, repo: repoName, workflow, reason: 'request failed' })
    }

    // 成功は 204 No Content。本文は空。
    const text = res.status === 204 ? '' : await res.text()
    const remaining = res.headers.get('x-ratelimit-remaining') ?? '-'

    if (res.status === 204) {
      console.log(
        `[kick-github] ${repoName}/${workflow} (${ref}) を起動しました` +
          ` / 鍵 ${tokenUsed} / 残りレート ${remaining}`,
      )
      return reply(200, { ok: true, repo: repoName, workflow, ref })
    }

    console.error(
      `[kick-github] ${repoName}/${workflow} の起動に失敗 HTTP ${res.status}: ` +
        `${explain(res.status)} / 鍵 ${tokenUsed}` +
        ` / 残りレート ${remaining} / 応答: ${text.slice(0, 500)}`,
    )
    return reply(502, {
      ok: false,
      repo: repoName,
      workflow,
      github_status: res.status,
      reason: explain(res.status),
    })
  },
}
