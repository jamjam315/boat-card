-- App Store Server Notifications V2 の受け取り記録(WP-6)。
--
-- 書くのは apple-notifications 関数(service role)だけ。利用者には見せないので、
-- RLS を有効にしてポリシーは1本も置かない(anon / authenticated からは読めも書けもしない)。
--
-- 【何のための表か】
-- ・同じ通知を2回扱わない(Apple は失敗したと思うと送り直してくる)
-- ・「どの通知で何をしたか」をあとから追えるようにする(更新・無視・Sandbox不許可 など)
--
-- 【残すもの・残さないもの】
-- 残すのは通知の種類・環境・originalTransactionId と、処理の結果の短い文字列だけ。
-- 通知の本文(JWS)は残さない。user_id も持たない(memberships の purchase_token から辿れる)。
-- memberships の行が見つからなかった通知・他のアプリの通知は、記録自体を残さない。
-- TEST 通知は環境ごとに1行('test-production' / 'test-sandbox')を上書きするだけ。
-- 同じ購読の記録は1分に1行まで(関数のクールダウン)。どれも、偽の通知で表を
-- 埋められないようにするため(security-review 2026-09-13)。
--
-- 【保持は90日】
-- 関数が通知を扱ったついでに、received_at が90日より前の行を消す(専用の cron は持たない)。

create table if not exists public.apple_notifications (
  notification_uuid text primary key,
  notification_type text not null,
  subtype text,
  -- 'Production' | 'Sandbox'
  environment text not null,
  original_transaction_id text,
  result text not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

create index if not exists apple_notifications_received_at_idx
  on public.apple_notifications (received_at);

-- 同じ購読を1分以内に扱ったかを見る(偽の通知の連打で Apple への問い合わせを増やさせない)。
create index if not exists apple_notifications_otx_processed_idx
  on public.apple_notifications (original_transaction_id, processed_at);

alter table public.apple_notifications enable row level security;
