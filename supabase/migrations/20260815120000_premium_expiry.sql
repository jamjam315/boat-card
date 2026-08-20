-- 契約の判定に「期限」を足す。
--
-- 【なぜ要るのか】
-- これまでの is_premium() は status しか見ていなかった。Stripe時代は webhook が
-- 解約・支払い失敗のたびに status を書き換えていたので、それで足りていた。
-- Stripeを撤去した今、status を書き戻す担当が誰もいない。このまま Play Billing を
-- 繋ぐと「一度 active になったら永久に active」になる。
--
-- 期限を条件に足しておくと、万一なんらかの理由で書き戻しが止まっても、
-- current_period_end を過ぎた時点で自動的に権利が切れる。書き戻しの仕組みが
-- 壊れたときに、緩む側ではなく締まる側に倒れるようにするための保険。
--
-- 【current_period_end が null のときは有効扱いにする】
-- 期限が「切れている」のではなく「記録が無い」状態なので、ここで無効に倒すと
-- 既存の契約者を予告なく締め出しうる。Play Billing の検証(タスク③)は
-- expiryTime を必ず書き込むので、今後 null の行は増えない。
-- 審査用アカウントも期限を明示して入れる運用にしてある。
--
-- 【判定は4か所にある。ここを直したら必ず全部そろえること】
--   1. この関数           … RLS(条件アラート・検証ノートのINSERT)
--   2. membership.js      … ブラウザの表示
--   3. send-morning-push  … 朝の通知
--   4. send-test-push     … テスト通知
-- 'active' と 'trialing' を契約中とみなす点は従来どおり(ACTIVE_STATUSES と同じ)。

create or replace function public.is_premium(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.memberships
    where user_id = uid
      and status in ('active', 'trialing')
      and (current_period_end is null or current_period_end > now())
  );
$$;

-- 再適用しても壊れないよう、実行権限も明示し直す(20260802090000と同じ作法)。
grant execute on function public.is_premium(uuid) to anon, authenticated;
