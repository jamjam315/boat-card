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
-- 【まだ記録できていないもの: RLSとポリシー】
-- このテーブルはブラウザから直接読み書きしており(favorites.js)、本人の行だけを
-- 扱えるようRLSが設定されているはずだが、その内容は未確認のため書いていない。
-- 実際の設定を確認しないまま enable row level security だけ書くと、ポリシーが
-- 無い状態を作ってお気に入り機能を止めてしまう危険があるため、あえて省いている。
-- 下記を実行して結果が分かった時点で、このファイルに追記すること:
--
--   select rowsecurity from pg_tables
--    where schemaname = 'public' and tablename = 'favorite_players';
--
--   select policyname, cmd, qual, with_check from pg_policies
--    where schemaname = 'public' and tablename = 'favorite_players';
--
-- 【このファイルの位置づけ】
-- 既存のDBに対しては create table if not exists が何もしない(=無害)。
-- 新しい環境を一から作り直すときのための記録として置いている。

create table if not exists public.favorite_players (
  user_id uuid not null,
  toban text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, toban)
);
