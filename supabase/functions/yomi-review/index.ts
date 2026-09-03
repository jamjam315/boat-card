// 読み採点の答案に、AIの講評を1本書かせる(指示文AI-1)。
//
// ## フェイルクローズ
// 講評を返すのは「JWTが本人・回数が残っている・AI応答あり・出力フィルタを
// 通過」がすべて揃ったときだけ。権利が確認できない・Secrets未設定・AI応答が
// 空・フィルタで止まった、はすべてエラーに倒す。疑わしきは出さない。
//
// ## 権限
// レジャー帳の相棒は X-Client-Key(APKから抜ける共有キー)と自己申告の
// install_id で権利を見ていた。アカウントを持たないアプリでは、それ以上の
// 手が無かった。**艇読みはSupabaseのアカウントがあるので、JWTそのものを
// 認証に使う**(verify-purchase と同じ)。プレミアム判定は is_premium() を
// RPCで呼ぶ。クライアントの自己申告は一切入らない。
//
// ## 統計はサーバーが差し込む
// クライアントから受け取るのは答案(結果・買い目・番組表の数字)だけ。
// 展開連鎖と前づけは、サーバーが teiyomi.com から取ってきて差し込む。
// クライアントに持たせると、都合のいい数字に書き換えてAIに書かせられる。
//
// ## 保存しないもの
// 答案も生成文もDBに書かない。書くのは回数のカウンタ1行だけ。
// ログに出すのは user_id の先頭8桁と結果コードまでで、**答案の中身と
// 生成された講評は絶対に出さない。**
//
// ## デプロイ
//   supabase functions deploy yomi-review
//   supabase secrets set AI_PROVIDER=openai AI_MODEL=gpt-5.6-luna
//     AI_BASE_URL=https://api.openai.com/v1 AI_API_KEY=<OpenAIのAPIキー>
//     AI_MAX_TOKENS=2048 --project-ref vynbhssakpxiikmseoja
//     (実際は1行で。上は読みやすさのために折り返している)
//
// AI_PROVIDER / AI_MODEL / AI_BASE_URL / AI_MAX_TOKENS は未設定でも ai.ts の
// 既定が同じ値なので同じように動く。それでもSecretsに明示しておくのは、
// 何を使っているかがコードを読まずに分かるようにするため。
// AI_API_KEY を設定するまで、この関数は常に ai_unavailable を返す。
import { withSupabase } from 'npm:@supabase/server@^1'
import { createClient } from 'npm:@supabase/supabase-js@^2'

import { createAiCaller, hashUserId, readAiConfig } from './ai.ts'
import {
  buildUserPrompt,
  filterOutput,
  jstDate,
  type Maezuke,
  MAX_DAILY_PREMIUM,
  MAX_FREE_TOTAL,
  parseSheet,
  pickMaezuke,
  pickRenren,
  type Renren,
  shortId,
  SYSTEM_PROMPT,
  winnerCourse,
} from './logic.ts'

const JSON_HEADERS = { 'content-type': 'application/json' }
const SITE = 'https://teiyomi.com'

const supabaseAdmin = createClient(
  Deno.env.get('SUPABASE_URL') as string,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') as string,
  { auth: { persistSession: false } },
)

/** 素材のキャッシュ。1インスタンスにつき30分。取れなければ null のまま進む。 */
const CACHE_MS = 30 * 60 * 1000
const cache: { at: number; renren: Renren | null; maezuke: Maezuke | null } = {
  at: 0,
  renren: null,
  maezuke: null,
}

async function loadStats() {
  if (Date.now() - cache.at < CACHE_MS && (cache.renren || cache.maezuke)) return cache
  try {
    const [a, b] = await Promise.all([
      fetch(`${SITE}/renren.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(`${SITE}/maezuke.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ])
    cache.renren = a ?? null
    cache.maezuke = b?.players ?? null
    cache.at = Date.now()
  } catch {
    // 取れなくても講評は書ける(展開データ無しとしてAIに渡る)。
    console.log('[yomi-review] stats fetch failed')
  }
  return cache
}

function fail(code: string, logReason: string, status = 400): Response {
  console.log(`[yomi-review] ${code} (${logReason})`)
  return new Response(JSON.stringify({ ok: false, code }), { status, headers: JSON_HEADERS })
}

export default {
  fetch: withSupabase(
    {
      auth: 'user',
      cors: {
        headers: {
          'Access-Control-Allow-Origin': 'https://teiyomi.com',
          'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
        },
      },
    },
    async (req: Request, ctx: { userClaims?: Record<string, unknown> }) => {
      try {
        if (req.method !== 'POST') return fail('bad_request', 'method', 405)

        const userId = ctx.userClaims?.id as string | undefined
        if (!userId) return fail('unauthorized', 'no claims', 401)

        // --- 1. 入力 ---
        // 権利より先に検証する。壊れた答案でAIを呼んでも意味が無いし、
        // 回数も消費させたくない。
        let raw: unknown
        try {
          raw = await req.json()
        } catch {
          return fail('bad_request', 'invalid json', 400)
        }
        const parsed = parseSheet(raw)
        if ('error' in parsed) return fail('bad_request', 'sheet:' + parsed.error, 400)
        const sheet = parsed.sheet

        // --- 2. Secrets ---
        const config = readAiConfig()
        if (!config) return fail('ai_unavailable', 'AI_API_KEY not configured', 503)

        // --- 3. 権利と回数 ---
        // 数えるだけで、まだ加算しない。加算は出力フィルタを通ったあと。
        const { data: premium, error: pErr } = await supabaseAdmin
          .rpc('is_premium', { uid: userId })
        if (pErr) return fail('forbidden', 'is_premium failed: ' + pErr.message, 403)
        const isPremium = premium === true

        const today = jstDate()
        let used = 0
        let limit = 0
        if (isPremium) {
          limit = MAX_DAILY_PREMIUM
          const { data, error } = await supabaseAdmin
            .from('yomi_ai_daily')
            .select('count')
            .eq('user_id', userId)
            .eq('jst_date', today)
            .maybeSingle()
          if (error) return fail('forbidden', 'daily read failed: ' + error.message, 403)
          used = data?.count ?? 0
        } else {
          limit = MAX_FREE_TOTAL
          const { data, error } = await supabaseAdmin
            .from('yomi_ai_free')
            .select('count')
            .eq('user_id', userId)
            .maybeSingle()
          if (error) return fail('forbidden', 'free read failed: ' + error.message, 403)
          used = data?.count ?? 0
        }
        if (used >= limit) {
          console.log(`[yomi-review] limit (${shortId(userId)}: ${isPremium ? 'premium' : 'free'})`)
          return new Response(
            JSON.stringify({
              ok: false,
              code: 'limit',
              premium: isPremium,
              used,
              limit,
              remaining: 0,
            }),
            { status: 429, headers: JSON_HEADERS },
          )
        }

        // --- 4. 素材をサーバー側で差し込む ---
        const stats = await loadStats()
        const renren = pickRenren(stats.renren, sheet.venue, winnerCourse(sheet), sheet.kimarite)
        const maezuke = pickMaezuke(stats.maezuke, sheet)

        // --- 5. 生成 ---
        const ai = createAiCaller(config)
        const text = await ai(
          SYSTEM_PROMPT,
          buildUserPrompt(sheet, renren, maezuke),
          await hashUserId(userId),
        )

        // --- 6. 出力フィルタ ---
        // ここで止まった回は回数を消費しない。ブロックの理由はログにだけ
        // 残し、クライアントには返さない(どう書けば通るかの手がかりになる)。
        const checked = filterOutput(text, sheet)
        if (!checked.ok) {
          console.log(`[yomi-review] blocked (${shortId(userId)}: ${checked.reason})`)
          // 種別(banned / invented / empty)までは返す。どの語・どの組番で
          // 止まったかは返さない——それを返すと「何を避ければ通るか」を
          // 教えることになる。種別だけなら、詰まっている場所を運用側が
          // 掴めて、迂回の手がかりにはならない。
          return new Response(
            JSON.stringify({ ok: false, code: 'blocked', kind: checked.reason.split(':')[0] }),
            { status: 502, headers: JSON_HEADERS },
          )
        }

        // --- 7. 通ったので数える ---
        // 加算に失敗しても講評は返す。お金は掛かっているが、利用者から見れば
        // 「出たのに回数だけ減った」より「出て回数が減らなかった」ほうが害が
        // 小さい。取りこぼしはログに残す。
        const { data: after, error: bumpErr } = isPremium
          ? await supabaseAdmin.rpc('bump_yomi_ai_daily', { p_user: userId, p_date: today })
          : await supabaseAdmin.rpc('bump_yomi_ai_free', { p_user: userId })
        if (bumpErr) console.log(`[yomi-review] bump failed (${shortId(userId)})`)
        const nowUsed = typeof after === 'number' ? after : used + 1

        console.log(
          `[yomi-review] ok (${shortId(userId)}: ${isPremium ? 'premium' : 'free'} ` +
            `${nowUsed}/${limit})`,
        )
        return new Response(
          JSON.stringify({
            ok: true,
            text: checked.text,
            model: config.model,
            premium: isPremium,
            used: nowUsed,
            limit,
            remaining: Math.max(0, limit - nowUsed),
          }),
          { status: 200, headers: JSON_HEADERS },
        )
      } catch (e) {
        // 想定外は必ず失敗に倒す。例外の中身は出さない(答案が混ざりうる)。
        console.log('[yomi-review] unexpected error: ' +
          (e instanceof Error ? e.name : 'unknown'))
        return fail('ai_unavailable', 'unexpected', 500)
      }
    },
  ),
}
