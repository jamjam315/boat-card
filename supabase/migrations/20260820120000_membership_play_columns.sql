-- memberships を Google Play Billing 用にする列を足す(タスク②)。
--
-- 既存の列はそのまま使い、意味だけ読み替える:
--   status              active / inactive (ACTIVE_STATUSES はこれまでどおり)
--   price_id            Playの商品ID(teiyomi_premium_monthly)を入れる
--   current_period_end  Googleが返す expiryTime をそのまま入れる
--
-- stripe_customer_id / stripe_subscription_id は使わない。列は残すが常にnullになる
-- (消すのは、他の課金元へ移る可能性が完全に無くなってからでよい。今消しても得が無い)。
--
-- この時点では、memberships に書き込むコードはまだ1つも無い(membership.js は
-- select のみ)。列が増えても既存の動きには一切影響しない。書き込みはタスク③の
-- verify-purchase(service role)だけが行う。RLSは「本人の行を読めるだけ」のまま。

-- 購入トークン。Googleが購読1件ごとに発行する識別子。
-- 1トークンが複数アカウントで使い回されないよう、あとで一意にする。
alter table public.memberships
  add column if not exists purchase_token text;

-- 課金の提供元。今は 'play' だけだが、手で権利を付けた行(審査用アカウント等)を
-- あとから見分けられるようにしておく。'play' | 'manual' を想定。
--
-- 【既存の行は 'play' で埋まる】
-- defaultを付けた列を足すと、既にある行にもその値が入る。手で権利を付ける行は
-- insert のときに platform = 'manual' を明示すること。あとから見分けられなくなる。
--   例) 審査用アカウント:
--       insert into public.memberships
--         (user_id, status, price_id, current_period_end, platform)
--       select id, 'active', 'play-review', '2099-12-31'::timestamptz, 'manual'
--         from auth.users where email = '<審査用メール>'
--       on conflict (user_id) do update set status = 'active',
--         current_period_end = excluded.current_period_end, platform = 'manual';
--
-- CHECK制約は付けない。将来 'apple' 等が増えたときに、制約を外す作業から
-- 始めることになるため。値の妥当性は書き込む側(verify-purchase)で担保する。
alter table public.memberships
  add column if not exists platform text default 'play';

-- 【なぜ一意にするのか】
-- 1つの購読を複数のアカウントで使い回せてしまうと、1人ぶんの支払いで
-- 何人でもプレミアムになれる。トークンを一意にしておくと、2人目のアカウントが
-- 同じトークンを出してきた時点で書き込みが失敗する(=権利が付かない)。
--
-- インライン制約(add column ... unique)ではなく独立した索引にしているのは、
-- 列だけあって制約が無い状態からでも、このファイルを流し直せば復旧できるようにするため。
-- nullは複数行あってよい(Postgresの一意索引はnull同士を重複と見なさない)ので、
-- トークンを持たない行(手で付けた権利・Stripe時代の残骸)は今までどおり共存できる。
create unique index if not exists memberships_purchase_token_key
  on public.memberships (purchase_token);

-- 【運用上の注意: アカウントを移りたいと言われたとき】
-- 上の一意制約は「使い回しの防止」と引き換えに、正規の乗り換えも止める。
-- Aで買った人がBのアカウントで使いたい場合、Bで復元しようとしても
-- 「そのトークンはAが持っている」ため失敗する。そのときは運営側で
--   update public.memberships
--      set purchase_token = null, status = 'inactive'
--    where user_id = '<Aのuser_id>';
-- として手放させてから、Bで復元してもらう。自動でAから剥がす作りにはしない
-- (それを認めると、他人のトークンを申告して奪えてしまうため)。
