// 利用者が自分でアカウントを消す(WP-2b)。
//
// これまで削除はメールでの依頼だけだった。App Store Review Guideline 5.1.1(v)
// は、アカウントを作れるアプリに**アプリの中から削除を始められること**を
// 求めている。メール窓口だけでは足りない。iOS版のためだが、仕組み自体は
// ブラウザ・Androidでも同じように使える(プラットフォームの分岐は無い)。
//
// ## 消すのは「呼んだ本人」だけ
//
// **本文でIDを受け取らない。** 誰を消すかはJWTからしか決めない。
// 本文で受け取る口を作ると、他人のIDを書いて送るだけでアカウントを
// 消せる関数になる。verify-purchase が「書き込む先も必ず本人の行だけ」に
// しているのと同じ考え方。
//
// ## 消す順番
//
//   1. 連鎖削除の対象外の表(favorite_players)を先に消す
//   2. auth.users を消す(残り9つの表は on delete cascade で一緒に消える)
//
// この順にしているのは、途中で失敗したときに**やり直せば必ず収束する**ため。
// 1で失敗したら何も消えていない。2で失敗したらお気に入りだけ消えた状態で
// アカウントは残るので、もう一度押せば続きから消える。
// 逆順にすると、2が成功して1が失敗したときに「持ち主のいないお気に入り」が
// 残り、本人はもうログインできないので消しに来られない。
//
// ## デプロイ
//   supabase functions deploy delete-account --project-ref <PROJECT_REF>
// 新しいSecretsは要らない(SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY は
// Edge Functionに既定で注入される)。
import { withSupabase } from 'npm:@supabase/server@^1'
import { createClient } from 'npm:@supabase/supabase-js@^2'
import { isAllowedMethod, logId, subjectFromClaims, TABLES_WITHOUT_CASCADE } from './logic.ts'

const JSON_HEADERS = { 'content-type': 'application/json' }

const supabaseAdmin = createClient(
  Deno.env.get('SUPABASE_URL') as string,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') as string,
  { auth: { persistSession: false } },
)

/**
 * 失敗を返す。**理由は呼び出し元に返さない。**
 *
 * 「そのアカウントは存在しません」のような答え方をすると、当てずっぽうに
 * 叩いて存在を確かめる材料になる。画面側は理由を出さずに
 * 「時間をおいて再度」と案内する作りにしてある。
 */
function failed(reason: string, status = 200): Response {
  console.log('[delete-account] failed: ' + reason)
  return new Response(JSON.stringify({ ok: false }), {
    status,
    headers: JSON_HEADERS,
  })
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
        if (!isAllowedMethod(req.method)) return failed('method not allowed', 405)

        const userId = subjectFromClaims(ctx.userClaims)
        if (!userId) return failed('unauthorized', 401)

        // --- 1. 連鎖削除の対象外を先に消す ---
        for (const table of TABLES_WITHOUT_CASCADE) {
          const { error } = await supabaseAdmin.from(table).delete().eq('user_id', userId)
          if (error) {
            // ここで止める。まだ何も消えていないので、押し直せばやり直せる。
            return failed(`${table} delete failed: ${error.message}`, 500)
          }
        }

        // --- 2. 利用者そのものを消す(残りは連鎖で消える) ---
        const { error: authErr } = await supabaseAdmin.auth.admin.deleteUser(userId)
        if (authErr) {
          return failed('auth delete failed: ' + authErr.message, 500)
        }

        console.log('[delete-account] deleted user=' + logId(userId))
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: JSON_HEADERS,
        })
      } catch (e) {
        // 想定外は必ず失敗として返す。「たぶん消えた」を返さない。
        return failed('unexpected error: ' + e, 500)
      }
    },
  ),
}
