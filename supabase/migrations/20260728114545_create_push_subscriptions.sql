-- プッシュ通知の送信先(購読情報)を保持するテーブル。
--
-- 1行 = 1ブラウザ。endpoint はブラウザが発行する送信先URLで、これ自体が
-- そのブラウザを一意に指す。氏名等とは結びつかない。
-- p256dh / auth は通知本文を暗号化するための鍵で、これが無いと送信できない
-- (逆に言うと、経由する配信サービスは中身を読めない)。
--
-- 【RLSの考え方】
-- 本人の行だけ読み書きできるようにする。update を作っているのは、同じブラウザで
-- 通知をON→OFF→ONと切り替えたときにクライアントが upsert(onConflict: endpoint)
-- を使うため。update ポリシーが無いと、2回目のONで
-- 「INSERT ... ON CONFLICT DO UPDATE」が弾かれてしまう。
-- なお using / with check とも自分の行に限定しているので、他人の購読を
-- 乗っ取ることはできない(他人が使っている endpoint への upsert は失敗する。
-- これは安全側の失敗であり、意図した挙動)。
--
-- 送信側(工程2のEdge Function)は service role で読み書きし、配信に失敗した
-- 購読(HTTP 404 / 410)をここから削除する。

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 送信時は「このユーザーの購読を全部」引くので、user_id で引けるようにする。
create index if not exists push_subscriptions_user_id_idx
  on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;

-- create policy に if not exists は使えないため、drop if exists → create で
-- 再適用安全にする(memberships と同じ作法)。
drop policy if exists "read own push subscriptions" on public.push_subscriptions;
create policy "read own push subscriptions"
  on public.push_subscriptions for select
  using ((select auth.uid()) = user_id);

drop policy if exists "insert own push subscriptions" on public.push_subscriptions;
create policy "insert own push subscriptions"
  on public.push_subscriptions for insert
  with check ((select auth.uid()) = user_id);

drop policy if exists "update own push subscriptions" on public.push_subscriptions;
create policy "update own push subscriptions"
  on public.push_subscriptions for update
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "delete own push subscriptions" on public.push_subscriptions;
create policy "delete own push subscriptions"
  on public.push_subscriptions for delete
  using ((select auth.uid()) = user_id);
