-- 課金状態(Stripeのサブスクリプション)を保持するテーブル。
--
-- このSQLは工程1でSupabaseのSQL Editorから手動実行済みで、本番には既に
-- 反映されている。リポジトリだけで構成を再現できるようにするため、
-- 同じ内容をマイグレーションとして後追いで記録したもの。
-- 既に適用済みの環境に再適用しても壊れないよう、全文を冪等に書いている。
--
-- 書き込みはEdge Function(stripe-webhook)がservice roleで行う。
-- クライアント向けの書き込みポリシーは作らない = RLSにより全面禁止。

create table if not exists public.memberships (
  user_id uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  status text not null default 'inactive',
  price_id text,
  current_period_end timestamptz,
  updated_at timestamptz not null default now()
);

-- 有効済みのテーブルに対して実行しても何も起きない(冪等)。
alter table public.memberships enable row level security;

-- create policy に if not exists は使えないため、drop if exists → create で
-- 再適用安全にする。マイグレーションはトランザクション内で実行されるため、
-- 「ポリシーが一瞬消える」状態が他セッションから見えることはない。
drop policy if exists "read own membership" on public.memberships;

create policy "read own membership"
  on public.memberships for select
  using ((select auth.uid()) = user_id);
