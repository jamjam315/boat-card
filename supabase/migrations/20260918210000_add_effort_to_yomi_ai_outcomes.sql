-- AI講評の成否の記録に、推論量(AI_REASONING_EFFORT)を足す(2026-09-18)。
--
-- 【なぜ要るのか】
-- 2026-09-18 21:00 JST に推論量を既定から low へ切り替えた(応答が 9〜15秒 → 5〜10秒)。
-- 切り替えの前後で成否が変わっていないかを、監視の集計そのもので見分けられるようにする。
-- 以後の切り替えも、日付を覚えておかなくても記録から分かる。
--
-- 値は yomi-review が送る: 'default'(Secret 未設定) / 'low' など ai.ts の REASONING_EFFORTS。
-- 切り替えた当日(2026-09-18)の既存の行は、検証で既定・low・none・minimal を混ぜて呼んだため 'mixed' にする。

alter table public.yomi_ai_outcomes_daily
  add column if not exists effort text not null default 'default';

update public.yomi_ai_outcomes_daily set effort = 'mixed' where jst_date = '2026-09-18';

alter table public.yomi_ai_outcomes_daily
  drop constraint if exists yomi_ai_outcomes_daily_pkey;
alter table public.yomi_ai_outcomes_daily
  add primary key (jst_date, outcome, effort);
alter table public.yomi_ai_outcomes_daily
  add constraint yomi_ai_outcomes_daily_effort_format check (effort ~ '^[a-z_]{1,16}$');

-- 引数の数が変わるので、前の関数は消してから作る(同じ名前で2つあると呼び分けが曖昧になる)。
-- p_effort は省略できる(省略時 'default')。切り替えの途中で古い関数の呼び方が来ても通る。
drop function if exists public.bump_yomi_ai_outcome(text, text);

create or replace function public.bump_yomi_ai_outcome(p_date text, p_outcome text, p_effort text default 'default')
returns integer
language sql
volatile
security definer
set search_path = public
as $$
  insert into public.yomi_ai_outcomes_daily (jst_date, outcome, effort, count, updated_at)
  values (p_date, p_outcome, p_effort, 1, now())
  on conflict (jst_date, outcome, effort)
  do update set count = public.yomi_ai_outcomes_daily.count + 1, updated_at = now()
  returning count;
$$;

revoke all on function public.bump_yomi_ai_outcome(text, text, text) from public;
revoke all on function public.bump_yomi_ai_outcome(text, text, text) from anon, authenticated;
grant execute on function public.bump_yomi_ai_outcome(text, text, text) to service_role;
