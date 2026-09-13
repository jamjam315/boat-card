// iOSアプリ(殻)で通知を受け取る(WP-4)。
//
// 【全体の流れ】
//   ① push.register  … 殻がiOSに許可を求め、APNsのトークンを取る
//   ② token          … 殻から {token, env} が届く
//   ③ apns_tokens    … その行を保存する(RLSで本人の行だけ)
//   ④ 送信           … Edge Function が APNs へ直接送る(殻は関与しない)
//
// 【Firebaseを使わない】
// 送信は _shared/apns.ts が APNs のHTTP/2エンドポイントを直接叩く。
// ブラウザのWeb Push(favorites.js の TeiyomiNotify)とは別経路で、
// **文面だけは共通**(_shared/morning-message.ts)。
//
// 【ブラウザ・Androidでは何も起きない】
// TeiyomiIOS.isIOSApp() が false のときは window.TeiyomiIOSPush も作らない。
// 読み込んでも表示は変わらない。
//
// 前提: ios.js → favorites.js の順に読み込まれていること(このファイルは後)。
(function () {
  "use strict";

  var ios = window.TeiyomiIOS;
  if (!ios || !ios.isIOSApp()) return;   // ← ブラウザ・Androidはここで終わり

  // 二重読み込みに耐える(ios.js が差し込むぶんと、将来ページに直接置いた場合)。
  if (window.__teiyomiIOSPushApi) {
    window.TeiyomiIOSPush = window.__teiyomiIOSPushReceiver;
    return;
  }

  var TABLE = "apns_tokens";

  // 直近に受け取ったトークン。画面が状態を出すのに使う。
  var current = null;      // {token, env} | null
  var registerWaiters = [];

  // 直近の「オンにできなかった理由」。getState() が off に添えて返す。
  //   denied          … 許可されていない(設定から許可してもらう)
  //   register-failed … 許可は済んだが、APNsへの登録に失敗した(時間をおいてもう一度)
  //   save-failed     … トークンは取れたが、保存に失敗した
  //
  // **画面の案内を、描き直しで消さないために持つ。** 合図が届くと
  // teiyomi-ios-push-changed で mypage が描き直すが、それは getState() の
  // 通信を待ってから箱を丸ごと書き換えるので、押した直後に出した案内が
  // 一瞬で消えていた(WP-4追補)。理由をここに持っておけば、描き直した
  // 箱にも同じ案内が出る。
  var lastProblem = null;

  // 殻から何も返ってこないときに諦めるまでの時間。iOSは圏外だと
  // 登録の成否をつながるまで返さないので、「処理中…」のまま止めない。
  // 諦めたあとでトークンが届けば、そのまま保存して「オン」に描き直す。
  var ENABLE_TIMEOUT_MS = 30000;

  function settleRegister(value) {
    var ws = registerWaiters; registerWaiters = [];
    ws.forEach(function (fn) { fn(value); });
  }

  /**
   * 殻へ合図を送る。**合言葉が無ければ送らない**(billing-ios.js と同じ)。
   */
  function send(body) {
    var ch = ios.channel();
    var bridge = window.__teiyomiNative;
    var token = bridge && bridge.token;
    if (!ch || typeof ch.postMessage !== "function" || !token) return false;
    body.token = token;
    try { ch.postMessage(JSON.stringify(body)); return true; }
    catch (e) { return false; }
  }

  function auth() { return window.TeiyomiAuth || null; }

  function currentUser() {
    var a = auth();
    return (a && a.getUser && a.getUser()) || null;
  }

  function loggedIn() {
    var u = currentUser();
    return !!(u && !u.isAnonymous);
  }

  function client() {
    var a = auth();
    return (a && a.getClient && a.getClient()) || null;
  }

  /**
   * トークンを保存する。
   *
   * **onConflict は token。** 同じ端末で別の人がログインしたら user_id が
   * その人へ移り、前の人にはもう届かなくなる(端末を譲ったときに前の持ち主の
   * 出走通知が届き続けるのを防ぐ)。行が増えないので、機種変更や再インストールで
   * トークンが変わったぶんだけが残り、それは配信の 410 で消える。
   */
  function saveToken(t) {
    var c = client();
    var u = currentUser();
    if (!c || !u || u.isAnonymous) return Promise.resolve(false);
    return c.from(TABLE).upsert({
      user_id: u.id,
      token: t.token,
      env: t.env,
      updated_at: new Date().toISOString()
    }, { onConflict: "token" }).then(function (res) {
      return !res.error;
    }, function () { return false; });
  }

  /** 保存してある行を消す。通知OFF・ログアウト・アカウント削除で呼ぶ。 */
  function deleteToken(tokenValue) {
    var c = client();
    if (!c || !tokenValue) return Promise.resolve(false);
    return c.from(TABLE).delete().eq("token", tokenValue)
      .then(function (res) { return !res.error; }, function () { return false; });
  }

  // ---- 殻からの合図 -----------------------------------------------------------

  function onToken(e) {
    if (typeof e.token !== "string" || e.token.length === 0) return;
    current = { token: e.token, env: e.env === "sandbox" ? "sandbox" : "production" };
    saveToken(current).then(function (ok) {
      lastProblem = ok ? null : "save-failed";
      settleRegister(ok ? { state: "on" } : { state: "save-failed" });
      notifyChanged();
    });
  }

  function onDenied() {
    current = null;
    lastProblem = "denied";
    settleRegister({ state: "denied" });
    notifyChanged();
  }

  /** 許可は済んだのに、APNsへの登録に失敗した。**denied とは案内が違う。** */
  function onRegisterFailed() {
    current = null;
    lastProblem = "register-failed";
    settleRegister({ state: "register-failed" });
    notifyChanged();
  }

  function onUnregistered() {
    current = null;
    lastProblem = null;
    settleRegister({ state: "off" });
    notifyChanged();
  }

  var receiver = {
    onEvent: function (e) {
      if (!e || typeof e !== "object") return;
      switch (e.type) {
        case "token": onToken(e); break;
        case "denied": onDenied(); break;
        case "register-failed": onRegisterFailed(); break;
        case "unregistered": onUnregistered(); break;
        default: break;   // 知らない合図は捨てる
      }
    }
  };
  window.__teiyomiIOSPushReceiver = receiver;
  window.TeiyomiIOSPush = receiver;

  /** 画面に「変わった」と伝える。mypage が拾って描き直す。 */
  function notifyChanged() {
    try {
      window.dispatchEvent(new CustomEvent("teiyomi-ios-push-changed"));
    } catch (e) {}
  }

  // ---- 公開I/F(TeiyomiNotify と同じ顔ぶれ) ------------------------------------
  //
  // mypage が同じ書き方で扱えるよう、getState / enable / disable をそろえる。
  // 状態の名前もブラウザ側と同じ語彙にしてある。

  /**
   * いまの状態。
   *   unavailable … 殻の窓口が無い / Supabaseに繋がっていない
   *   need-login  … 未ログイン(トークンを誰の行として保存するか決まらない)
   *   on / off    … 保存済み / 未保存
   *
   * off のときだけ、直近にオンにできなかった理由を problem に添える
   * (denied | register-failed | save-failed)。無ければ付けない。
   */
  function getState() {
    if (!ios.billingAvailable()) return Promise.resolve({ state: "unavailable" });
    if (!loggedIn()) return Promise.resolve({ state: "need-login" });
    var c = client();
    if (!c) return Promise.resolve({ state: "unavailable" });
    // 保存してある行を見る。**この端末のぶんだけ**を見たいが、トークンは
    // 殻から届くまで分からないので、まだ届いていなければ「自分の行が1つでも
    // あるか」で代用する(機種変更直後は off に見えるが、ONを押せば入り直る)。
    function toState(res) {
      if (!res.error && res.data && res.data.length) return { state: "on" };
      return lastProblem ? { state: "off", problem: lastProblem } : { state: "off" };
    }
    if (current) {
      return c.from(TABLE).select("token").eq("token", current.token).limit(1)
        .then(toState, function () { return { state: "unavailable" }; });
    }
    var u = currentUser();
    return c.from(TABLE).select("token").eq("user_id", u.id).limit(1)
      .then(toState, function () { return { state: "unavailable" }; });
  }

  /**
   * 通知をONにする。**許可のプロンプトはこの中でだけ出る**(=必ずタップ起点)。
   *
   * 返り値(Promise): {state} … "on" | "denied" | "register-failed" | "save-failed"
   *                             | "unavailable" | "need-login"
   */
  function enable() {
    if (!ios.billingAvailable()) return Promise.resolve({ state: "unavailable" });
    if (!loggedIn()) return Promise.resolve({ state: "need-login" });
    lastProblem = null;   // 押し直したら、前の理由はいったん忘れる
    return new Promise(function (resolve) {
      var done = false;
      var timer = null;
      function finish(value) {
        if (done) return;
        done = true;
        if (timer !== null) clearTimeout(timer);
        resolve(value);
      }
      registerWaiters.push(finish);
      if (!send({ type: "push.register" })) {
        settleRegister({ state: "unavailable" });
        return;
      }
      timer = setTimeout(function () {
        if (done) return;
        registerWaiters = registerWaiters.filter(function (fn) { return fn !== finish; });
        lastProblem = "register-failed";
        finish({ state: "register-failed" });
      }, ENABLE_TIMEOUT_MS);
    });
  }

  /** 通知をOFFにする。行を消してから、殻にOSの登録を解いてもらう。 */
  function disable() {
    var t = current && current.token;
    return deleteToken(t).then(function () {
      send({ type: "push.unregister" });
      current = null;
      lastProblem = null;
      notifyChanged();
      return { state: "off" };
    });
  }

  /**
   * ログアウトするとき。**行を消して登録も解く**(Web Push の disable と同じ扱い)。
   *
   * 消さないと、次にこの端末を使う人へ前の人の出走通知が届く。
   * upsert(onConflict: token) でも user_id は移るが、その人が通知をONに
   * するまでの間は前の人の行のままなので、ここで消しておく。
   */
  function signOutCleanup() {
    return disable();
  }

  window.__teiyomiIOSPushApi = window.TeiyomiIOSPushControl = {
    getState: getState,
    enable: enable,
    disable: disable,
    signOutCleanup: signOutCleanup,
    /** テスト・画面用。まだ受け取っていなければ null。 */
    currentToken: function () { return current; }
  };
})();
