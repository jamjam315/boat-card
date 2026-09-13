// プレミアム会員かどうかの判定を1か所にまとめる共通ロジック。
// premium/index.html と backtest-custom.html(5b)の両方から読み込む。
//
// 前提: favorites.js を先に読み込んでおくこと。Supabaseクライアントは
// favorites.js が作った1つを TeiyomiAuth.getClient() 経由で借りる
// (1ページに複数クライアントを作ると認証ストレージが競合するため)。
//
// membershipsテーブルはRLSにより「自分の行だけ読める / 書き込みは全面禁止」。
// 書き込むのはservice roleを持つサーバー側だけ(現在は書き込み口が無い状態。
// Google Play課金へ移行後、そのレシート検証を受ける処理がここに入る)。
(function () {
  "use strict";

  // 有料機能を使える状態。past_due(支払い失敗中)・canceled・incomplete等は含めない。
  // membershipsテーブルのstatusはこの語彙のまま使う(課金の提供元が変わっても、
  // 会員判定の仕組みはそのまま流用できるようにしておく)。
  var ACTIVE_STATUSES = ["active", "trialing"];

  /**
   * 契約中かどうか。statusだけでなく期限も見る。
   *
   * statusを書き戻す担当が止まっても、current_period_endを過ぎれば自動的に
   * 権利が切れるようにしておくための保険(緩む側ではなく締まる側に倒す)。
   * 期限がnullのときは「切れている」ではなく「記録が無い」なので有効扱いにする。
   *
   * 同じ判定が is_premium()(RLS)・send-morning-push・send-test-push にもある。
   * 直すときは4か所そろえること。
   */
  function isActive(status, periodEnd) {
    if (ACTIVE_STATUSES.indexOf(status) === -1) return false;
    if (!periodEnd) return true;
    var t = new Date(periodEnd).getTime();
    if (isNaN(t)) return true;   // 読めない値は期限なし扱い(表示のためだけの値なので)
    return t > Date.now();
  }

  var listeners = [];

  // 読み込みに失敗したとき、諦めるまでに待つ時間(ミリ秒)。3回まで取り直す。
  //
  // 【なぜ取り直すのか】(WP-4追補2)
  // ログインした直後の最初の問い合わせが 401 で弾かれることがある
  // (2026-09-13、Safariで匿名→メールのアカウントに切り替えた直後に実際に起きた)。
  // 症状は Supabase 側で報告されている不具合と一致する。発行された直後の
  // トークンを PostgREST が「未来に発行された」(PGRST303)と読み違え、
  // 直後の1回だけを拒むもので、少し待って取り直せば通る
  // (github.com/orgs/supabase/discussions/48123。こちらの401の応答本文は未確認)。
  //
  // 取り直さないと、失敗は null(判定できない)として画面へ配られ、各画面は
  // それを「契約していない」側で描く。次にログイン状態が変わるか再読み込み
  // するまでそのままなので、**契約者に購入画面やプレミアムの壁が出続ける**。
  //
  // 合計でおよそ4秒(±25%)。各画面の「いつまでも返らないときの保険」(8秒)より短くする。
  var RETRY_DELAYS = [400, 1200, 2500];

  function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  // 同じ瞬間に失敗した人たちが同じ瞬間に取り直さないよう、待ち時間を少し散らす。
  function jitter(ms) {
    return Math.round(ms * (0.75 + Math.random() * 0.5));
  }

  function sameUser(a, b) {
    return !!(a && b && a.id === b.id && !!a.isAnonymous === !!b.isAnonymous);
  }

  function auth() {
    return window.TeiyomiAuth || null;
  }

  /**
   * 自分の会員状態を読む。
   * 返り値(Promise):
   *   null … まだ判定できない(初期化中・Supabase未接続・取り直しても通信失敗)
   *   {status, active, priceId, currentPeriodEnd, user} … 判定できた
   *     行が無い場合は status:null / active:false
   */
  function load() {
    var a = auth();
    if (!a || !a.getClient) return Promise.resolve(null);
    var client = a.getClient();
    var user = a.getUser();
    if (!client || !user) return Promise.resolve(null);

    // 匿名アカウントは決済できない(メール必須)ので、問い合わせるまでもなく非会員。
    if (user.isAnonymous) {
      return Promise.resolve({ status: null, active: false, priceId: null, currentPeriodEnd: null, user: user });
    }

    function queryOnce() {
      return client
        .from("memberships")
        .select("status,price_id,current_period_end")
        .eq("user_id", user.id)
        .then(function (res) {
          if (res.error) return { failed: true };
          var row = (res.data && res.data[0]) || null;
          var status = row ? row.status : null;
          return {
            failed: false,
            state: {
              status: status,
              active: isActive(status, row ? row.current_period_end : null),
              priceId: row ? row.price_id : null,
              currentPeriodEnd: row ? row.current_period_end : null,
              user: user
            }
          };
        }, function () {
          return { failed: true };   // 通信失敗
        });
    }

    var attempt = 0;
    function run() {
      return queryOnce().then(function (r) {
        if (!r.failed) return r.state;
        // 取り直しても駄目なら null。呼び出し側で「確認できませんでした」を出す。
        if (attempt >= RETRY_DELAYS.length) return null;
        return wait(jitter(RETRY_DELAYS[attempt++])).then(function () {
          // 待っている間にログアウト・別のアカウントへ切り替わっていたら、
          // この人の結果はもう要らない。取り直さずに抜ける。
          if (!sameUser(a.getUser(), user)) return null;
          return run();
        });
      });
    }
    return run();
  }

  // 何回目の読み込みか。**後から始まった読み込みの結果だけを配る。**
  //
  // 取り直しで1回の読み込みが数秒かかりうるので、その間にログイン状態が
  // 変わって次の読み込みが始まることがある。古いほうが後から返ってきて
  // 新しい結果を上書きすると、前の人(や匿名)の状態が画面に残る。
  var generation = 0;

  function notify() {
    var mine = ++generation;
    load().then(function (state) {
      if (mine !== generation) return;
      listeners.forEach(function (fn) {
        try { fn(state); } catch (e) {}
      });
    });
  }

  // ログイン・ログアウト・マジックリンクからの復帰で会員状態も変わりうる。
  window.addEventListener("teiyomi-auth-changed", notify);

  window.TeiyomiMembership = {
    ACTIVE_STATUSES: ACTIVE_STATUSES.slice(),
    load: load,
    /**
     * 会員状態を取り直して、購読している全員に配る。
     *
     * 購入が済んだ直後に呼ぶためのもの。onChange を購読している画面
     * (5b・選手ページ・マイページ・プレミアム)が、これ1回で全部更新される。
     * 呼ばないと、買ったのに画面が「未契約」のままになる。
     */
    reload: notify,
    /** 会員状態が決まる/変わるたびに呼ばれるコールバックを登録する。 */
    onChange: function (fn) {
      listeners.push(fn);
      // 既に認証状態が確定済みなら、イベントを待たずに1回流す。
      var a = auth();
      if (a && a.getUser()) notify();
    }
  };
})();
