-- 「その日、そのユーザーに“お知らせ”を送ったか」の記録。
-- 朝の出走通知(push_send_log)とは別の表にする。
--
-- 【なぜ push_send_log に相乗りさせないのか】
-- あちらは「朝の通知を送ったか」の記録で、書き込むとその日の朝の通知が
-- 止まる。データ更新の遅れを知らせた後にデータが届いた場合、朝の通知は
-- ちゃんと送りたいので、止めてしまう表とは分ける。
--
-- 【kind を持たせている理由】
-- 今のところ 'data_delay'(データ更新の遅れ)の1種類だけだが、将来ほかの
-- お知らせを足したときに、種類ごとに「1日1回」を数えられるようにしておく。
--
-- 主キーを (send_date, kind, user_id) にしているので、同じ日・同じ種類・
-- 同じ人の行は物理的に1つしか作れない。二重送信の防止はこの制約に依存する。
-- user_id まで含めているのは、途中で失敗した時に取りこぼした人だけ後から
-- 送り直せるようにするため。
--
-- 【RLSはポリシー無しで有効化する】
-- 読み書きするのは送信処理(service role)だけで、ブラウザからは一切触らない。
-- RLSを有効にしてポリシーを1つも作らなければ、anon/authenticated からは
-- 何も見えず、service role だけが素通しになる。push_send_log と同じ既定。

create table if not exists public.push_notice_log (
  send_date date not null,
  kind      text not null,
  user_id   uuid not null references auth.users(id) on delete cascade,
  sent_at   timestamptz not null default now(),
  primary key (send_date, kind, user_id)
);

alter table public.push_notice_log enable row level security;

-- 古い記録の掃除は必須ではない(遅れた日にしか行が増えない)。増えすぎたら
--   delete from public.push_notice_log where send_date < current_date - 90;
-- のような掃除を後から足せばよい。
