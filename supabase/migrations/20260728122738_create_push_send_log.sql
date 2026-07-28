-- 「その日、そのユーザーに朝の通知を送ったか」の記録。二重送信を防ぐためだけの表。
--
-- 【なぜ要るのか】
-- 朝の配信は07:45と08:45の2回動かす(1回目が失敗しても届くように)。記録が無いと
-- 2回目で全員にもう一度届いてしまう。送信に成功したら (送信日, user_id) を
-- 書き込み、2回目の起動では既にある人を飛ばす。
--
-- 主キーを (send_date, user_id) にしているので、同じ日に同じ人の行は
-- 物理的に1つしか作れない。二重送信の防止はこの制約に依存している。
--
-- 【RLSはポリシー無しで有効化する】
-- この表を読み書きするのは送信処理(service role)だけで、ブラウザからは
-- 一切触らない。RLSを有効にしてポリシーを1つも作らなければ、
-- anon/authenticated からは何も見えず、service role だけが素通しになる。
-- これがいちばん安全な既定。

create table if not exists public.push_send_log (
  send_date date not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  sent_at timestamptz not null default now(),
  primary key (send_date, user_id)
);

alter table public.push_send_log enable row level security;

-- 古い記録の掃除は必須ではない(1日1人1行と小さい)。増えすぎたら
--   delete from public.push_send_log where send_date < current_date - 90;
-- のような掃除を後から足せばよい。
