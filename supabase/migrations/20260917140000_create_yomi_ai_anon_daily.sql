-- AI講評: 匿名アカウント全体の1日の回数(2026-09-17)。
--
-- 【なぜ要るのか】
-- 無料お試し(累計5回・yomi_ai_free)は、サイトを開いた人全員(匿名アカウント)向けの設計。
-- 匿名アカウントは作り直せるので、1アカウント5回の上限だけでは、作り直しながら呼び続けると
-- 実質無制限になる(AIの利用料が膨らむ)。そこで「匿名アカウントから呼ばれた回数の合計」に
-- 1日の上限を置く。上限の値は Edge Function の環境変数 YOMI_AI_ANON_DAILY_LIMIT(既定100)。
-- メールでログインした利用者(匿名でない)は、この全体上限の対象外。
--
-- 【日付はJSTで持つ】yomi_ai_daily と同じ。Edge Function が作った日付文字列を受け取る。
-- 【書くのは service role だけ】読み取りのポリシーも作らない(利用者に見せる数字ではない)。

create table if not exists public.yomi_ai_anon_daily (
  jst_date   text primary key,
  count      integer not null default 0,
  updated_at timestamptz not null default now(),
  constraint yomi_ai_anon_daily_date_format check (jst_date ~ '^\d{4}-\d{2}-\d{2}$'),
  constraint yomi_ai_anon_daily_count_range check (count >= 0 and count <= 1000000)
);

alter table public.yomi_ai_anon_daily enable row level security;

-- 加算は1文の中で行う(yomi_ai_daily と同じ理由)。戻り値は加算後の回数。
create or replace function public.bump_yomi_ai_anon_daily(p_date text)
returns integer
language sql
volatile
security definer
set search_path = public
as $$
  insert into public.yomi_ai_anon_daily (jst_date, count, updated_at)
  values (p_date, 1, now())
  on conflict (jst_date)
  do update set count = public.yomi_ai_anon_daily.count + 1, updated_at = now()
  returning count;
$$;

revoke all on function public.bump_yomi_ai_anon_daily(text) from public;
revoke all on function public.bump_yomi_ai_anon_daily(text) from anon, authenticated;
grant execute on function public.bump_yomi_ai_anon_daily(text) to service_role;
