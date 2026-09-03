-- AI講評の通報。
--
-- 【なぜ要るのか】
-- Google Playは、AIでコンテンツを生成するアプリに「アプリを終了せずに
-- デベロッパーへ不適切なコンテンツを報告できる機能」を求めていて、報告は
-- コンテンツフィルタと管理に反映することとされている。AI講評はこれに当たる。
-- mailtoリンクでは「アプリ内で完結」を満たさないので、受け皿を持つ。
--
-- 【ここだけ、講評本文をサーバーに保存する】
-- 艇読みは「AI講評をサーバーに保存しない」と決めていて、同意画面にもそう
-- 書いてある。**報告はその唯一の例外**。本文を見ずに管理はできず、それが
-- Playの求めていることでもある。保存の引き金は利用者自身の明示的な操作で、
-- 報告フォームにも保存する旨を書く。
--
-- 本文には**買い目の組番が含まれることがある**(講評が組番に触れるため)。
-- 金額・出所タグ・選手名は含まれない(そもそも講評に出さない設計)。
-- レースキーや答案データは持たない——本文だけで管理には足りるし、持てば
-- サーバー側に「誰がどのレースを買ったか」の履歴が育つ。
--
-- 【なぜEdge Functionを挟まないのか】
-- 報告は yomi-review を一切呼ばない、別テーブルへの素のINSERTにしてある。
-- **報告の操作が回数カウンタに触れないことを、コードの約束ではなく構造で
-- 保証するため**(bump_yomi_ai_* は service_role にしか grant していないので、
-- クライアントからは呼びようがない)。要る検証はカテゴリ・長さ・件数だけで、
-- CHECK制約とRLSと上限トリガーで足りる。
--
-- 【本文の真正性は検証できない】
-- 生成文をサーバーに残していないので、「本当に艇読みが生成した文章か」は
-- 確かめようがない。任意の文字列を報告として投げることはできる。影響は
-- 運営が読む内容が汚れることだけで、Playが求めているのは受付経路の存在。
-- v1ではここを受容する(JAM判断・2026-09-04)。

create table if not exists public.yomi_ai_reports (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  -- 'wrong'(事実と違う) | 'inappropriate'(不適切な表現) | 'other'(その他)
  category     text not null,
  text         text not null,
  model        text,
  generated_at timestamptz,
  comment      text,
  created_at   timestamptz not null default now(),
  constraint yomi_ai_reports_category_check
    check (category in ('wrong', 'inappropriate', 'other')),
  -- 講評は実測で384〜543字。4000字あれば長く出た回でも入る。
  constraint yomi_ai_reports_text_check
    check (length(text) between 1 and 4000),
  constraint yomi_ai_reports_comment_check
    check (comment is null or length(comment) <= 500)
);

create index if not exists yomi_ai_reports_created_at_idx
  on public.yomi_ai_reports (created_at desc);

alter table public.yomi_ai_reports enable row level security;

-- 自分の出した報告だけ読める・書ける。
drop policy if exists "read own yomi ai reports" on public.yomi_ai_reports;
create policy "read own yomi ai reports"
  on public.yomi_ai_reports for select
  using ((select auth.uid()) = user_id);

drop policy if exists "insert own yomi ai reports" on public.yomi_ai_reports;
create policy "insert own yomi ai reports"
  on public.yomi_ai_reports for insert
  with check ((select auth.uid()) = user_id);

-- update・delete のポリシーは**作らない**(＝誰も書き換えられない)。
-- 出したあとで本人が書き換えられると、報告として受け取った意味が無くなる。
-- 運営が消すときは service role(ダッシュボード)から行う。

-- 1人あたりの上限。艇読みはサイトを開くだけで匿名アカウントが発行される
-- 設計なので、歯止めが無いと行を無限に作れる(2026-08-01の監査 M-3 と同じ理由)。
-- 20件にしたのは、まっとうな利用でここに届くことがまず無く、届いたとしても
-- 「同じ人が20回報告した」時点で個別に見るべき状態だから。
create or replace function public.yomi_ai_reports_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  select count(*) into n from public.yomi_ai_reports where user_id = new.user_id;
  if n >= 20 then
    raise exception 'AI講評の報告は1人20件までです（今% 件）', n
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists yomi_ai_reports_limit_trg on public.yomi_ai_reports;
create trigger yomi_ai_reports_limit_trg
  before insert on public.yomi_ai_reports
  for each row execute function public.yomi_ai_reports_limit();
