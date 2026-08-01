-- 条件アラート・検証ノートの「保存」を、サーバー側でも契約者に限る
-- (2026-08-01のセキュリティ監査 M-2 への対応)。
--
-- 【なぜ要るのか】
-- これまで INSERT のポリシーは「自分の user_id であること」しか見ていなかった。
-- 契約しているかどうかの判定はブラウザ側の表示制御だけだったので、REST を直接
-- 叩けば、匿名アカウント(サイトを開くだけで発行される)でも保存できてしまった。
-- 今日つぶした「お試しで選手欄を空にすると本体が使える」と同じ種類の抜け道で、
-- **壁は画面だけでなく、サーバー側の再確認とセットで初めて機能する**。
--
-- なお朝の通知そのものは send-morning-push と _shared/morning-message.ts の
-- 2か所で契約を再確認しているため、無料の人が保存だけしても通知は届かなかった。
-- 本丸は守られていたが、保存できること自体が有料機能の一部なので、入口も閉じる。
--
-- 【select / update / delete は本人限定のまま変えない】
-- 契約が切れた人が、自分が過去に保存したものを見返したり消したりできなくなると
-- 困る。取り上げるのは「新しく作ること」だけにする。

-- 契約中かどうかの判定を1か所にまとめる。
-- security definer にしているのは、memberships が本人しか読めない設定(RLS)のため。
-- この関数の中では所有者の権限で読むので、ポリシーの中から呼んでも正しく判定できる。
-- 'active' と 'trialing' を契約中とみなすのは、Edge Function 側の ACTIVE_STATUSES と
-- 同じ定義(片方だけ直すと食い違うので、変えるときは両方直すこと)。
create or replace function public.is_premium(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.memberships
    where user_id = uid and status in ('active', 'trialing')
  );
$$;

-- ポリシーの中から呼べるように、実行権限を明示しておく
-- (既定でも呼べるが、将来 public への既定権限が絞られたときに壊れないように)。
grant execute on function public.is_premium(uuid) to anon, authenticated;

-- ---- 条件アラート ----
drop policy if exists "insert own race alerts" on public.race_alerts;
create policy "insert own race alerts"
  on public.race_alerts for insert
  with check (
    (select auth.uid()) = user_id
    and public.is_premium((select auth.uid()))
  );

-- ---- 検証ノート ----
drop policy if exists "insert own verification notes" on public.verification_notes;
create policy "insert own verification notes"
  on public.verification_notes for insert
  with check (
    (select auth.uid()) = user_id
    and public.is_premium((select auth.uid()))
  );
