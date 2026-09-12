-- iOSアプリ(殻)への通知の送信先(WP-4)。
--
-- 1行 = 1端末。token はAPNsが端末ごとに発行する値で、これ自体がその端末を
-- 一意に指す。氏名等とは結びつかない。
--
-- 【push_subscriptions と同じ作法にしてある】
-- あちらは endpoint を unique にして、配信が 404/410 を返したら行を消す。
-- こちらも token を unique にして、APNs が 410 / BadDeviceToken を返したら消す。
-- そうしないと、機種変更したあとに前の端末の行が残り続け、毎朝失敗し続ける。
--
-- 【同じ端末で別の人がログインしたら】
-- token が unique なので、upsert(onConflict: token) で user_id が新しい人へ移る。
-- 前の人にはもう届かない。**これは意図した挙動**で、端末を譲ったり家族で
-- 使い回したときに、前の人の出走通知が新しい持ち主へ届き続けるのを防ぐ。
--
-- 【env について】
-- APNs には本番とSandboxの2つのホストがあり、**どちらへ送るかはトークンごとに
-- 決まる**(開発ビルド・TestFlight で取ったトークンは Sandbox、App Store 配信は
-- 本番)。取り違えると BadDeviceToken になるので、取ったときの環境を一緒に持つ。

create table if not exists public.apns_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  token text not null unique,
  -- 'sandbox' | 'production'。CHECK制約は付けない(将来Appleが環境を増やしたときに
  -- 制約を外す作業から始めることになる)。値の妥当性は書き込む側で担保する
  -- ——memberships.platform と同じ判断。
  env text not null default 'production',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 送信時は「このユーザーの端末を全部」引く。
create index if not exists apns_tokens_user_id_idx
  on public.apns_tokens (user_id);

alter table public.apns_tokens enable row level security;

-- create policy に if not exists は使えないため、drop if exists → create で
-- 再適用安全にする(push_subscriptions と同じ作法)。
drop policy if exists "read own apns tokens" on public.apns_tokens;
create policy "read own apns tokens"
  on public.apns_tokens for select
  using ((select auth.uid()) = user_id);

drop policy if exists "insert own apns tokens" on public.apns_tokens;
create policy "insert own apns tokens"
  on public.apns_tokens for insert
  with check ((select auth.uid()) = user_id);

-- update が要るのは、同じ端末で通知をON→OFF→ONと切り替えたときや、
-- 別の人がログインしたときに upsert(onConflict: token) を使うため。
-- using は「いまの持ち主」を見ないことに注意——**別の人の行を自分へ移す**のが
-- この update の目的なので、using を自分の行に限ると端末の引き継ぎができない。
-- 移せるのは「その端末のトークンを実際に握っている人」だけで、トークンは
-- APNs が殻に渡すものなので、他人の端末のトークンは手に入らない。
drop policy if exists "claim apns token" on public.apns_tokens;
create policy "claim apns token"
  on public.apns_tokens for update
  using (true)
  with check ((select auth.uid()) = user_id);

drop policy if exists "delete own apns tokens" on public.apns_tokens;
create policy "delete own apns tokens"
  on public.apns_tokens for delete
  using ((select auth.uid()) = user_id);
