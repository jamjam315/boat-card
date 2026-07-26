// プレミアム会員かどうかの判定を1か所にまとめる共通ロジック。
// premium/index.html と backtest-custom.html(5b)の両方から読み込む。
//
// 前提: favorites.js を先に読み込んでおくこと。Supabaseクライアントは
// favorites.js が作った1つを TeiyomiAuth.getClient() 経由で借りる
// (1ページに複数クライアントを作ると認証ストレージが競合するため)。
//
// membershipsテーブルはRLSにより「自分の行だけ読める / 書き込みは全面禁止」。
// 書き込むのはStripe Webhookを受けるEdge Functionだけ(service role)。
(function () {
  "use strict";

  // 有料機能を使える状態。Stripeのstatusをそのまま保存しているので、
  // past_due(支払い失敗中)・canceled・incomplete等はここに含めない。
  var ACTIVE_STATUSES = ["active", "trialing"];

  var listeners = [];

  function auth() {
    return window.TeiyomiAuth || null;
  }

  /**
   * 自分の会員状態を読む。
   * 返り値(Promise):
   *   null … まだ判定できない(初期化中・Supabase未接続・通信失敗)
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

    return client
      .from("memberships")
      .select("status,price_id,current_period_end")
      .eq("user_id", user.id)
      .then(function (res) {
        if (res.error) return null;
        var row = (res.data && res.data[0]) || null;
        var status = row ? row.status : null;
        return {
          status: status,
          active: ACTIVE_STATUSES.indexOf(status) !== -1,
          priceId: row ? row.price_id : null,
          currentPeriodEnd: row ? row.current_period_end : null,
          user: user
        };
      }, function () {
        return null;   // 通信失敗。呼び出し側で「確認できませんでした」を出す。
      });
  }

  function notify() {
    load().then(function (state) {
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
    /** 会員状態が決まる/変わるたびに呼ばれるコールバックを登録する。 */
    onChange: function (fn) {
      listeners.push(fn);
      // 既に認証状態が確定済みなら、イベントを待たずに1回流す。
      var a = auth();
      if (a && a.getUser()) notify();
    }
  };
})();
