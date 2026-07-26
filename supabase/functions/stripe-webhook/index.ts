// StripeからのWebhookを受け取り、membershipsテーブルへ課金状態を反映する。
// この関数はStripeのサーバーが呼ぶためSupabaseのJWTを持たない
// (config.tomlで verify_jwt = false)。認証は「Stripe署名の検証」が唯一の
// 入口チェックであり、検証に失敗したリクエストは何もせず400で返す。
import Stripe from 'npm:stripe@^22'
import { createClient } from 'npm:@supabase/supabase-js@^2'

// 秘密値はすべてSupabase管理画面の環境変数から読む(コード・リポジトリには書かない)。
const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') as string)
const WEBHOOK_SECRET = Deno.env.get('STRIPE_WEBHOOK_SECRET') as string

// membershipsはRLSでクライアントからの書き込みを禁止しているため、
// service roleキーの管理者クライアントで書き込む(キー自体はログに出さない)。
const supabaseAdmin = createClient(
  Deno.env.get('SUPABASE_URL') as string,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') as string,
  { auth: { persistSession: false, autoRefreshToken: false } },
)

function nowIso(): string {
  return new Date().toISOString()
}

function toIso(unixSeconds: number | null | undefined): string | null {
  return typeof unixSeconds === 'number' ? new Date(unixSeconds * 1000).toISOString() : null
}

/**
 * 現在の請求期間の終了日時。
 * Stripe API 2025-03-31(basil)以降、current_period_end は Subscription 本体から
 * 無くなり SubscriptionItem 側に移っているため、明細から取得する。
 */
function readPeriodEnd(subscription: Stripe.Subscription): string | null {
  const ends = (subscription.items?.data ?? [])
    .map((item) => item.current_period_end)
    .filter((sec): sec is number => typeof sec === 'number')
  return ends.length > 0 ? toIso(Math.max(...ends)) : null
}

/** 契約中の価格ID(艇読みは1契約1明細のため先頭を採用)。 */
function readPriceId(subscription: Stripe.Subscription): string | null {
  return subscription.items?.data?.[0]?.price?.id ?? null
}

function readId(value: string | { id: string } | null | undefined): string | null {
  if (typeof value === 'string') return value
  return value?.id ?? null
}

/** 決済完了。ここで初めてmembershipsに行ができる(2回届いても同じ行を上書きするだけ)。 */
async function handleCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
  if (session.mode !== 'subscription') return

  const userId = session.client_reference_id ?? (session.metadata?.user_id as string | undefined)
  const subscriptionId = readId(session.subscription)
  if (!userId || !subscriptionId) {
    // 再送されても直らない種類の欠落なので、リトライさせず記録だけ残す。
    console.error(
      `[stripe-webhook] checkout.session.completed skipped (session=${session.id}, user_id=${userId ?? 'none'}, subscription=${subscriptionId ?? 'none'})`,
    )
    return
  }

  const subscription = await stripe.subscriptions.retrieve(subscriptionId)

  const { error } = await supabaseAdmin.from('memberships').upsert(
    {
      user_id: userId,
      stripe_customer_id: readId(session.customer) ?? readId(subscription.customer),
      stripe_subscription_id: subscription.id,
      status: 'active',
      price_id: readPriceId(subscription),
      current_period_end: readPeriodEnd(subscription),
      updated_at: nowIso(),
    },
    { onConflict: 'user_id' },
  )
  if (error) throw new Error(`memberships upsert failed: ${error.message}`)
}

/** プラン変更・更新・支払い失敗など。Stripeのstatusをそのまま保存する。 */
async function handleSubscriptionUpdated(subscription: Stripe.Subscription): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from('memberships')
    .update({
      status: subscription.status,
      price_id: readPriceId(subscription),
      current_period_end: readPeriodEnd(subscription),
      updated_at: nowIso(),
    })
    .eq('stripe_subscription_id', subscription.id)
    .select('user_id')
  if (error) throw new Error(`memberships update failed: ${error.message}`)

  if (!data || data.length === 0) {
    // checkout.session.completed より先に届いた場合など。
    // その後のcheckout側upsertで最新状態が入るため、リトライはさせない。
    console.warn(`[stripe-webhook] no membership row for subscription ${subscription.id} (updated)`)
  }
}

/** 解約。行そのものは残し、statusだけ canceled にする。 */
async function handleSubscriptionDeleted(subscription: Stripe.Subscription): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from('memberships')
    .update({ status: 'canceled', updated_at: nowIso() })
    .eq('stripe_subscription_id', subscription.id)
    .select('user_id')
  if (error) throw new Error(`memberships update failed: ${error.message}`)

  if (!data || data.length === 0) {
    console.warn(`[stripe-webhook] no membership row for subscription ${subscription.id} (deleted)`)
  }
}

export default {
  async fetch(req: Request): Promise<Response> {
    if (req.method !== 'POST') {
      return new Response('method_not_allowed', { status: 405 })
    }

    const signature = req.headers.get('stripe-signature')
    if (!signature) {
      return new Response('missing_signature', { status: 400 })
    }

    // 署名検証には加工前の生ボディが必要なので、JSONパースより先にtext()で読む。
    const rawBody = await req.text()

    let event: Stripe.Event
    try {
      // Denoでは同期版(constructEvent)が使えないため非同期版を使う。
      // cryptoProviderは渡さない(npm:stripeではNode実装が選ばれるため、
      // SubtleCryptoProviderを明示すると未実装エラーになる)。
      event = await stripe.webhooks.constructEventAsync(rawBody, signature, WEBHOOK_SECRET)
    } catch (err) {
      console.error('[stripe-webhook] signature verification failed:', (err as Error).message)
      return new Response('invalid_signature', { status: 400 })
    }

    try {
      switch (event.type) {
        case 'checkout.session.completed':
          await handleCheckoutCompleted(event.data.object)
          break
        case 'customer.subscription.updated':
          await handleSubscriptionUpdated(event.data.object)
          break
        case 'customer.subscription.deleted':
          await handleSubscriptionDeleted(event.data.object)
          break
        default:
          // 購読していないイベントが届いても正常終了として返す(Stripeに再送させない)。
          break
      }
    } catch (err) {
      // 500を返すとStripeが自動でリトライする。DB一時障害はここで拾われる。
      console.error(`[stripe-webhook] failed to handle ${event.type} (${event.id}):`, err)
      return new Response('handler_failed', { status: 500 })
    }

    return Response.json({ received: true })
  },
}
