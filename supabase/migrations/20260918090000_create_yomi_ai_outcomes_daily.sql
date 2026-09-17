-- AI講評: AIを呼んだ結果を日別・種類別に数える(2026-09-18 監視)。
--
-- 【なぜ要るのか】
-- 2026-09-17 23:48 から講評が100%タイムアウトしていたのに、利用者の報告とログを見に行くまで
-- 気づけなかった。成功と失敗を日ごとに数えておき、毎晩の results.yml が前日の数を読んで、
-- 「成功0件」か「失敗が半分超」なら GitHub Issue を立てる(scripts/check_ai_health.py)。
--
-- 【数える単位】AIを呼んだ1回につき1つ(回数の上限で断った回・入力が壊れていた回は数えない)。
--   ok          … 講評を返した
--   timeout / http_error / exception … AIの呼び出しそのものが失敗(ai.ts の onFailure)
--   empty / banned / invented        … AIは返したが出力フィルタで止めた
--   no_config   … AI_API_KEY が無い
--   error       … 想定外の例外
-- 【中身は持たない】日付・種類・件数だけ。利用者も答案も講評も入れない。
-- 【書くのは service role だけ】読むのも ai-health(service role)だけなので、ポリシーは作らない。

create table if not exists public.yomi_ai_outcomes_daily (
  jst_date   text not null,
  outcome    text not null,
  count      integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (jst_date, outcome),
  constraint yomi_ai_outcomes_daily_date_format check (jst_date ~ '^\d{4}-\d{2}-\d{2}$'),
  constraint yomi_ai_outcomes_daily_outcome_format check (outcome ~ '^[a-z_]{1,32}$'),
  constraint yomi_ai_outcomes_daily_count_range check (count >= 0 and count <= 1000000)
);

alter table public.yomi_ai_outcomes_daily enable row level security;

-- 加算は1文の中で行う(yomi_ai_anon_daily と同じ)。戻り値は加算後の件数。
create or replace function public.bump_yomi_ai_outcome(p_date text, p_outcome text)
returns integer
language sql
volatile
security definer
set search_path = public
as $$
  insert into public.yomi_ai_outcomes_daily (jst_date, outcome, count, updated_at)
  values (p_date, p_outcome, 1, now())
  on conflict (jst_date, outcome)
  do update set count = public.yomi_ai_outcomes_daily.count + 1, updated_at = now()
  returning count;
$$;

revoke all on function public.bump_yomi_ai_outcome(text, text) from public;
revoke all on function public.bump_yomi_ai_outcome(text, text) from anon, authenticated;
grant execute on function public.bump_yomi_ai_outcome(text, text) to service_role;
