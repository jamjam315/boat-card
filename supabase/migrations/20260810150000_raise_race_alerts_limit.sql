-- 条件アラートの1人あたり上限を 10件 → 30件 に引き上げる(2026-08-10、JAM決定)。
--
-- 【経緯】
-- 10件は「通知の文面が破綻しない数」として置いた初期値だが、二つ名(殿堂)から
-- 選手単位のアラートを登録する使い方が増える見込みのため30件にする。
-- 文面側の制約(本文180文字目安で切り詰め、超過は「ほか◯件」)は変えていないので、
-- 一度に多く当たった朝は畳まれて届く。件数を増やしても1通の情報量は増えない。
--
-- 【前提(実施済み)】
-- 通知送信側のリスト取得はページング化済み(fetchAllRows)。増枠しても
-- PostgRESTの1000行上限で切り捨てられることはない。
--
-- アプリ側(alerts.js の MAX)も同じ数に合わせる。DB側は回避できない歯止め、
-- アプリ側は使い勝手のための先回り、という二重の構え(従来どおり)。

create or replace function public.race_alerts_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  select count(*) into n from public.race_alerts where user_id = new.user_id;
  if n >= 30 then
    raise exception '条件アラートは1人30件までです（今% 件）', n
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- トリガー自体は既存(race_alerts_limit_trg)のまま。関数の中身だけ差し替わる。
