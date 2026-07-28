-- お気に入り選手(端末をまたいで引き継ぐための保存先)。
--
-- このテーブルは早い時期にSupabaseのSQL Editorから手動で作られており、
-- 定義がリポジトリに残っていなかった。memberships と同じく、後追いで記録する
-- ためのマイグレーション。列・制約は実DBを information_schema と pg_constraint で
-- 確認した内容(2026-07-28)をそのまま写している。
--
--   user_id    uuid        not null
--   toban      text        not null   … 選手の登録番号。数値ではなく文字列で持つ
--   created_at timestamptz not null default now()
--   primary key (user_id, toban)
--
-- created_at は既に存在していたので、追加は不要だった。この列は
-- 「無料プランは古い順に3名まで通知する」の順序を決めるのに使う予定
-- (通知・工程2)。
--
-- 【RLSとポリシー】
-- pg_policies で確認した3本(2026-07-28)をそのまま写している。いずれも
-- 「自分の行だけ」に限定されている:
--   select own favorites … SELECT using (auth.uid() = user_id)
--   insert own favorites … INSERT with check (auth.uid() = user_id)
--   delete own favorites … DELETE using (auth.uid() = user_id)
-- update ポリシーが無いのは、favorites.js が
-- upsert(..., ignoreDuplicates: true) = INSERT ... ON CONFLICT DO NOTHING しか
-- 使わないため。更新は発生しないので、無いままが正しい。
--
-- 条件式は実DBの表記(auth.uid())のまま残した。memberships で使っている
-- (select auth.uid()) の形にすると行ごとの再評価が減るという利点はあるが、
-- ここは「実際にこうなっている」ことの記録を優先している。
--
-- 【このファイルの位置づけ】
-- 既存のDBに対しては create table if not exists が何もせず、ポリシーも
-- drop → 同じ内容で create し直すだけなので、実行しても状態は変わらない。
-- 新しい環境を一から作り直すときのための記録として置いている。

create table if not exists public.favorite_players (
  user_id uuid not null,
  toban text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, toban)
);

alter table public.favorite_players enable row level security;

-- create policy に if not exists は使えないため、drop if exists → create で
-- 再適用安全にする(memberships / push_subscriptions と同じ作法)。
drop policy if exists "select own favorites" on public.favorite_players;
create policy "select own favorites"
  on public.favorite_players for select
  using (auth.uid() = user_id);

drop policy if exists "insert own favorites" on public.favorite_players;
create policy "insert own favorites"
  on public.favorite_players for insert
  with check (auth.uid() = user_id);

drop policy if exists "delete own favorites" on public.favorite_players;
create policy "delete own favorites"
  on public.favorite_players for delete
  using (auth.uid() = user_id);
