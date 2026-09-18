// AI講評(yomi-review)の日別の成否を返す(2026-09-18 監視)。
//
// 【なぜ要るのか】
// 2026-09-17 23:48 から講評が100%タイムアウトしていたのに、ログを見に行くまで気づけなかった。
// 毎晩の results.yml(scripts/check_ai_health.py)がここを叩いて前日の数を読み、
// 「成功0件」か「失敗が半分超」なら GitHub Issue を立てる。
//
// 【起動方法】
//   GET https://<project>.supabase.co/functions/v1/ai-health            … JSTの前日
//   GET https://<project>.supabase.co/functions/v1/ai-health?date=2026-09-18
//   ヘッダー: x-cron-secret: <CRON_SECRET>
// 返す: {ok:true, date, ok_count, fail_count, total, by:{ok:3, timeout:1, ...}, efforts:{low:4, ...}}
// kick-github と同じ流儀。GitHub Actions は Supabase の JWT を持たないので config.toml で
// verify_jwt = false にし、代わりにここで x-cron-secret を突き合わせる(鍵は既存のものを共用)。
// 返すのは日付・種類・件数だけ(利用者も答案も講評も持っていない)。
import { createClient } from 'npm:@supabase/supabase-js@^2'

import { summarize, targetDate } from './logic.ts'

const JSON_HEADERS = { 'content-type': 'application/json' }

function reply(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
}

export default {
  async fetch(req: Request): Promise<Response> {
    const secret = Deno.env.get('CRON_SECRET')
    if (!secret || req.headers.get('x-cron-secret') !== secret) {
      console.error('[ai-health] x-cron-secret が一致しませんでした')
      return new Response('unauthorized', { status: 401 })
    }
    if (req.method !== 'GET') return reply(405, { ok: false, reason: 'method not allowed' })

    const date = targetDate(new URL(req.url).searchParams.get('date'))
    if (!date) return reply(400, { ok: false, reason: 'bad date' })

    const admin = createClient(
      Deno.env.get('SUPABASE_URL') as string,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') as string,
      { auth: { persistSession: false } },
    )
    const { data, error } = await admin
      .from('yomi_ai_outcomes_daily')
      .select('outcome, count, effort')
      .eq('jst_date', date)
    if (error) {
      console.error(`[ai-health] 読めませんでした: ${error.message}`)
      return reply(500, { ok: false, reason: 'read failed' })
    }
    const s = summarize(date, (data ?? []) as { outcome: string; count: number; effort: string }[])
    console.log(`[ai-health] ${date} ok=${s.ok} fail=${s.fail}`)
    return reply(200, {
      ok: true,
      date: s.date,
      ok_count: s.ok,
      fail_count: s.fail,
      total: s.total,
      by: s.by,
      efforts: s.efforts,
    })
  },
}
