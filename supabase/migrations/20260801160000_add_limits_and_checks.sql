-- 保存領域の荒らしへの歯止め(2026-08-01のセキュリティ監査 M-3 への対応)。
--
-- 【なぜ要るのか】
-- favorite_players と push_subscriptions には1人あたりの上限が無く、
-- 文字数・サイズの制限もどのテーブルにも無かった。艇読みはサイトを開くだけで
-- 匿名アカウントが発行される設計なので、その気になればアカウントを量産して
-- 無限に行を作れる。データを盗まれるわけではないが、**Supabaseの容量を食い潰して
-- 請求が膨らむか、サービスが止まる**という形の被害になる。
--
-- 【上限値の根拠(実データで確認)】
--   favorite_players 500件  … 現役2,114名のうちA1は348名。「A1を全員お気に入り」
--                             という極端な使い方でも余裕がある数。
--   push_subscriptions 20件 … 1行=1ブラウザ。2台の端末で3行できることがあるので
--                             プロファイル単位で増えるが、20には届かない。
--                             無効な購読は配信時に404/410で自動削除される。
--   文字数・サイズ          … 実際に保存される最大級の cond でも423バイト。
--                             8KBは通常利用の19倍で、邪魔にならない。
--   toban の書式            … 現役2,114名すべて4桁。5桁は将来の登番増加への備え。
--
-- 【上限トリガーで upsert を邪魔しないための工夫(重要)】
-- Postgres は INSERT ... ON CONFLICT のとき、**結果的に更新や無視になる行でも
-- BEFORE INSERT トリガーを必ず実行する**。素朴に「件数が上限以上なら例外」と
-- 書くと、上限に達した人が「既にあるお気に入りをもう一度タップする」
-- 「同じ端末で通知をONにし直す」だけでエラーになってしまう(新しい行は増えないのに)。
-- そこで、同じ行が既にあるときはトリガーを素通りさせる。
--   favorite_players   … (user_id, toban) が既にある → 素通り
--   push_subscriptions … endpoint が既にある         → 素通り
--
-- 【適用前の確認】
-- 既存データが制約に違反しているとALTERが失敗する。先に次を実行して0件を確認する:
--   select count(*) from public.favorite_players where toban !~ '^[0-9]{4,5}$';
--   select count(*) from public.race_alerts where toban !~ '^[0-9]{4,5}$'
--      or length(coalesce(label,'')) > 200 or octet_length(cond::text) > 8192
--      or octet_length(raw_cond::text) > 8192;
--   select count(*) from public.verification_notes where length(coalesce(label,'')) > 200
--      or length(coalesce(memo,'')) > 2000 or octet_length(cond::text) > 8192
--      or octet_length(result::text) > 8192;
--   select user_id, count(*) from public.favorite_players group by user_id having count(*) > 500;
--   select user_id, count(*) from public.push_subscriptions group by user_id having count(*) > 20;

-- ============ 1. 件数の上限 ============

create or replace function public.favorite_players_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  -- 既にあるお気に入りの押し直し(upsertのON CONFLICT DO NOTHING)は素通りさせる。
  -- 新しい行は増えないので、上限で止める理由が無い。
  if exists (
    select 1 from public.favorite_players
    where user_id = new.user_id and toban = new.toban
  ) then
    return new;
  end if;
  select count(*) into n from public.favorite_players where user_id = new.user_id;
  if n >= 500 then
    raise exception 'お気に入りは1人500件までです（今% 件）', n
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists favorite_players_limit_trg on public.favorite_players;
create trigger favorite_players_limit_trg
  before insert on public.favorite_players
  for each row execute function public.favorite_players_limit();


create or replace function public.push_subscriptions_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  -- 同じ端末で通知をONにし直したとき(upsertのON CONFLICT DO UPDATE)は素通りさせる。
  -- endpoint はテーブル全体で一意なので、これで「同じブラウザからの再登録」を判別できる。
  if exists (select 1 from public.push_subscriptions where endpoint = new.endpoint) then
    return new;
  end if;
  select count(*) into n from public.push_subscriptions where user_id = new.user_id;
  if n >= 20 then
    raise exception '通知を受け取る端末は1人20台までです（今% 台）', n
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists push_subscriptions_limit_trg on public.push_subscriptions;
create trigger push_subscriptions_limit_trg
  before insert on public.push_subscriptions
  for each row execute function public.push_subscriptions_limit();


-- ============ 2. 書式・長さ・サイズ ============
-- 登番は数字だけに限る。長さの制限と同時に、HTMLに埋めたときの事故も防げる
-- (画面側でもエスケープするが、入り口で止めるほうが確実)。

alter table public.favorite_players
  drop constraint if exists favorite_players_toban_format;
alter table public.favorite_players
  add constraint favorite_players_toban_format check (toban ~ '^[0-9]{4,5}$');

alter table public.race_alerts
  drop constraint if exists race_alerts_toban_format;
alter table public.race_alerts
  add constraint race_alerts_toban_format check (toban ~ '^[0-9]{4,5}$');

alter table public.race_alerts
  drop constraint if exists race_alerts_size;
alter table public.race_alerts
  add constraint race_alerts_size check (
    length(coalesce(label, '')) <= 200
    and octet_length(cond::text) <= 8192
    and octet_length(raw_cond::text) <= 8192
  );

alter table public.verification_notes
  drop constraint if exists verification_notes_size;
alter table public.verification_notes
  add constraint verification_notes_size check (
    length(coalesce(label, '')) <= 200
    and length(coalesce(memo, '')) <= 2000
    and octet_length(cond::text) <= 8192
    and octet_length(result::text) <= 8192
  );

-- mode は 'player' か 'normal' のどちらかしか使わない。
alter table public.verification_notes
  drop constraint if exists verification_notes_mode;
alter table public.verification_notes
  add constraint verification_notes_mode check (mode in ('player', 'normal'));
