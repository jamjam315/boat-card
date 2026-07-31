-- 条件アラート(5bで検証した絞り込みを保存し、翌朝以降の出走表と照合して通知する)の保存先。
--
-- 【選手を必須にしている理由】
-- 選手を指定しない条件(例「1号艇・全国」)は、今日の全レース(最大240件)が一致してしまい、
-- 通知として成立しない。毎朝かならず鳴る通知は、いちばん早く無視されるようになる。
-- また照合も、登番でハッシュ引きできるぶん圧倒的に軽い(出走表の全走査が要らない)。
-- 将来ゆるめる場合は toban を null 許容に変え、「会場を1つ以上必須」等の歯止めを別に置くこと。
--
-- 【cond と raw_cond を分けている理由】
-- 5bのしぼり込みには「レース後にしか分からない条件」(決まり手・実際の進入・天候・風速・波高)が
-- 含まれる。これらは朝の時点では判定できないので、照合に使う条件だけを cond に正規化して入れ、
-- 保存時の指定そのものは raw_cond に残す。画面で「この条件のうち通知の判定に使うのは◯◯です」と
-- 正直に出すために、両方が要る。cond だけにすると、利用者が何を指定したか復元できなくなる。
--
-- 【朝に判定できる条件(cond に入れてよいもの)】
--   会場 / レース番号 / 月 / 種別 / 距離 / 進入固定 / 開催区分(ナイター・デイ) / 枠
-- 種別・距離・進入固定は 2026-07-31 に data.js へ追加した(B票の見出し行から取る)。
--
-- 【RLSの考え方】
-- favorite_players と同じ作法で、本人の行だけ読み書きできるようにする。
-- マイページで一覧・削除・オンオフを操作するため、送信側(service role)だけでなく
-- 本人にも select/insert/update/delete を許す必要がある。

create table if not exists public.race_alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  toban text not null,                       -- 選手(登番)。A案=選手必須
  cond jsonb not null default '{}'::jsonb,   -- 朝に判定できる条件だけを正規化したもの
  raw_cond jsonb not null default '{}'::jsonb, -- 保存時の5bの指定そのまま(表示・再現用)
  label text,                                -- 一覧に出す名前(自動生成でよい)
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

-- 朝の照合は「有効な条件を全部引く」、マイページは「その人のぶんを引く」。
create index if not exists race_alerts_user_id_idx on public.race_alerts (user_id);
create index if not exists race_alerts_enabled_idx on public.race_alerts (enabled) where enabled;

alter table public.race_alerts enable row level security;

-- create policy に if not exists は使えないため、drop if exists → create で再適用安全にする
-- (memberships・push_subscriptions と同じ作法)。
drop policy if exists "read own race alerts" on public.race_alerts;
create policy "read own race alerts"
  on public.race_alerts for select
  using ((select auth.uid()) = user_id);

drop policy if exists "insert own race alerts" on public.race_alerts;
create policy "insert own race alerts"
  on public.race_alerts for insert
  with check ((select auth.uid()) = user_id);

drop policy if exists "update own race alerts" on public.race_alerts;
create policy "update own race alerts"
  on public.race_alerts for update
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "delete own race alerts" on public.race_alerts;
create policy "delete own race alerts"
  on public.race_alerts for delete
  using ((select auth.uid()) = user_id);

-- 【1人あたりの上限を10件にする理由】
-- 容量ではなく通知の文面のため。朝の通知は本文180文字を目安に切り詰めるので、
-- 条件が20も30もあると「ほか◯件」ばかりになって意味がなくなる。
-- アプリ側でも同じ数で止めるが、そちらは回避できるのでDBでも止める(二重の歯止め)。
create or replace function public.race_alerts_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  select count(*) into n from public.race_alerts where user_id = new.user_id;
  if n >= 10 then
    raise exception '条件アラートは1人10件までです（今% 件）', n
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists race_alerts_limit_trg on public.race_alerts;
create trigger race_alerts_limit_trg
  before insert on public.race_alerts
  for each row execute function public.race_alerts_limit();
