-- AI講評の回数カウンタ。
--
-- 【なぜテーブルが2つなのか】
-- プレミアムは「1日3回」、無料は「お試し累計5回」で、数える単位が違う。
-- 1つのテーブルに両方を詰めると、日付が要る行と要らない行が混ざり、
-- どちらの上限に当たったのかが読めなくなる。分けておく。
--
-- 【なぜクライアントから触らせないのか】
-- 回数はクライアントが自己申告するものではない。RLSは読み取りだけ許可し、
-- 書き込みは service role(Edge Function)だけができる。読めるようにして
-- あるのは、画面に「本日あと◯回」を出すため。
--
-- 【日付はJSTで持つ】
-- 上限は利用者の1日に対する約束なので、UTCで切り替わると夜9時に翌日ぶんが
-- 使えてしまう。Edge Function側でJSTの日付文字列を作って渡す
-- (Postgresのnow()には頼らない。関数と行の日付がずれる余地を作らない)。

create table if not exists public.yomi_ai_daily (
  user_id    uuid not null references auth.users(id) on delete cascade,
  jst_date   text not null,
  count      integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, jst_date),
  constraint yomi_ai_daily_date_format check (jst_date ~ '^\d{4}-\d{2}-\d{2}$'),
  constraint yomi_ai_daily_count_range check (count >= 0 and count <= 1000)
);

create table if not exists public.yomi_ai_free (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  count      integer not null default 0,
  updated_at timestamptz not null default now(),
  constraint yomi_ai_free_count_range check (count >= 0 and count <= 1000)
);

alter table public.yomi_ai_daily enable row level security;
alter table public.yomi_ai_free  enable row level security;

-- 自分の行だけ読める。書き込みのポリシーは作らない(＝誰も書けない)。
-- service role は RLS を通らないので、Edge Function からは書ける。
drop policy if exists "read own yomi ai daily" on public.yomi_ai_daily;
create policy "read own yomi ai daily"
  on public.yomi_ai_daily for select
  using ((select auth.uid()) = user_id);

drop policy if exists "read own yomi ai free" on public.yomi_ai_free;
create policy "read own yomi ai free"
  on public.yomi_ai_free for select
  using ((select auth.uid()) = user_id);

-- 加算は1文の中で行う。読んでから書くと、2つの要求が同時に来たときに
-- どちらも「まだ2回目」と読んで、上限を1回ぶん超える。戻り値は加算後の回数。
--
-- user_id は引数で受け取る。auth.uid() を関数の中で引く書き方にすると、
-- service role のクライアント(Edge Function)から呼んだときは auth.uid() が
-- null になって insert が落ちる。呼べるのは service role だけなので、
-- 引数で受けても他人の行を触られる経路にはならない。
create or replace function public.bump_yomi_ai_daily(p_user uuid, p_date text)
returns integer
language sql
volatile
security definer
set search_path = public
as $$
  insert into public.yomi_ai_daily (user_id, jst_date, count, updated_at)
  values (p_user, p_date, 1, now())
  on conflict (user_id, jst_date)
  do update set count = public.yomi_ai_daily.count + 1, updated_at = now()
  returning count;
$$;

create or replace function public.bump_yomi_ai_free(p_user uuid)
returns integer
language sql
volatile
security definer
set search_path = public
as $$
  insert into public.yomi_ai_free (user_id, count, updated_at)
  values (p_user, 1, now())
  on conflict (user_id)
  do update set count = public.yomi_ai_free.count + 1, updated_at = now()
  returning count;
$$;

-- ブラウザから直接叩けないようにする。回数はサーバーが数えるものであって、
-- クライアントが申告するものではない。
revoke all on function public.bump_yomi_ai_daily(uuid, text) from public;
revoke all on function public.bump_yomi_ai_free(uuid) from public;
revoke all on function public.bump_yomi_ai_daily(uuid, text) from anon, authenticated;
revoke all on function public.bump_yomi_ai_free(uuid) from anon, authenticated;
grant execute on function public.bump_yomi_ai_daily(uuid, text) to service_role;
grant execute on function public.bump_yomi_ai_free(uuid) to service_role;
