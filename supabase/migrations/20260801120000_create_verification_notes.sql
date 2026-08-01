-- 検証ノート(5bで試した条件と、そのときの結果を残しておく場所)。
--
-- 【なぜ結果まで一緒に残すのか】
-- 艇読みのデータは毎晩伸びる。同じ条件でも、1か月後に実行すれば数字は変わる。
-- 条件だけ残しても「あのとき何%だったか」は二度と分からないので、実行時点の
-- 主要な数字と「データの最終日」をひとまとめに残す。あとで開き直したときに
-- 「記録時：回収率100.6%（89レース・データ〜08/01時点）」と並べて出せる。
-- 数字が動いていれば利用者が自分で気づける。こちらから「悪化」等の評価はしない。
--
-- 【cond は条件アラート(race_alerts)とは別の形にしている】
-- race_alerts.cond は「朝に判定できる条件だけ」を正規化したもので、照合のための形。
-- こちらは「画面をそっくり元に戻す」ためのもので、券種・買い目・期間まで要る。
-- 目的が違うので同じ形にはしない(片方の都合でもう片方が壊れるのを避ける)。
--
-- 【RLS】
-- race_alerts と同じ作法で、本人の行だけ読み書きできるようにする。
-- 送信処理(service role)からは読まない。あくまで本人が見返すためのもの。

create table if not exists public.verification_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  mode text not null default 'normal',       -- 'player'(選手モード) | 'normal'(艇番)
  cond jsonb not null default '{}'::jsonb,   -- 復元に必要な5bの条件一式
  result jsonb not null default '{}'::jsonb, -- 記録時のスナップショット
  memo text,
  label text,
  created_at timestamptz not null default now()
);

create index if not exists verification_notes_user_id_idx
  on public.verification_notes (user_id, created_at desc);

alter table public.verification_notes enable row level security;

drop policy if exists "read own verification notes" on public.verification_notes;
create policy "read own verification notes"
  on public.verification_notes for select
  using ((select auth.uid()) = user_id);

drop policy if exists "insert own verification notes" on public.verification_notes;
create policy "insert own verification notes"
  on public.verification_notes for insert
  with check ((select auth.uid()) = user_id);

drop policy if exists "update own verification notes" on public.verification_notes;
create policy "update own verification notes"
  on public.verification_notes for update
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "delete own verification notes" on public.verification_notes;
create policy "delete own verification notes"
  on public.verification_notes for delete
  using ((select auth.uid()) = user_id);

-- 【上限を50件にした理由】
-- 条件アラート(10件)の理由は「通知の文面が破綻するから」だったが、こちらは
-- 送信時のコストが無く、効くのは一覧の見やすさと、際限なく増えることの防止だけ。
-- 週に1つ仮説を試して1年ぶん残る程度を想定して50件にした。
-- 足りなくなったら増やせばよい種類の制限(通知と違って副作用が無い)。
create or replace function public.verification_notes_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  select count(*) into n from public.verification_notes where user_id = new.user_id;
  if n >= 50 then
    raise exception '検証ノートは1人50件までです（今% 件）', n
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists verification_notes_limit_trg on public.verification_notes;
create trigger verification_notes_limit_trg
  before insert on public.verification_notes
  for each row execute function public.verification_notes_limit();
