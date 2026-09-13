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

  // この端末で登録できたトークンの控え(WP-5 step5)。{userId, token, env}
  //
  // 【なぜ控えるのか】
  // 「オン」かどうかは**この端末の**行があるかで決めたいが、殻はトークンを
  // メモリにしか持たず、アプリを開き直すと「オンにする」を押すまで分からない。
  // 以前は分からないあいだ「そのアカウントに行が1つでもあればオン」で代用していて、
  // 開発版の古い行が残っていた TestFlight 版で**最初からオンと表示され、登録を
  // 一度も頼まないまま**になった(2026-09-13 実機)。
  //
  // 控えはアプリの中の保存領域(WKWebView の localStorage)に置くので、アプリを
  // 削除すれば一緒に消える＝入れ直した端末は必ず「オフ」から始まる。
  var DEVICE_KEY = "teiyomi_ios_push_device";

  function readDevice() {
    try {
      var raw = localStorage.getItem(DEVICE_KEY);
      if (!raw) return null;
      var d = JSON.parse(raw);
      if (!d || typeof d.token !== "string" || !d.token || typeof d.userId !== "string") return null;
      return { userId: d.userId, token: d.token, env: d.env === "sandbox" ? "sandbox" : "production" };
    } catch (e) {
      return null;
    }
  }

  function writeDevice(userId, t) {
    try {
      localStorage.setItem(DEVICE_KEY, JSON.stringify({ userId: userId, token: t.token, env: t.env }));
    } catch (e) {}
  }

  function clearDevice() {
    try { localStorage.removeItem(DEVICE_KEY); } catch (e) {}
  }

  /**
   * 殻から今回まだトークンを受け取っていなければ、控えから戻す。
   * **控えは、いまログインしている人のものだけ使う**(同じ端末で別の人に替わったら使わない)。
   */
  function ensureCurrent() {
    if (current) return current;
    var u = currentUser();
    var d = readDevice();
    if (u && !u.isAnonymous && d && d.userId === u.id) {
      current = { token: d.token, env: d.env };
    }
    return current;
  }

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
    var saving = current;
    saveToken(saving).then(function (ok) {
      lastProblem = ok ? null : "save-failed";
      var u = currentUser();
      if (ok && u && !u.isAnonymous) writeDevice(u.id, saving);
      settleRegister(ok ? { state: "on" } : { state: "save-failed" });
      notifyChanged();
    });
  }

  function onDenied() {
    current = null;
    clearDevice();
    lastProblem = "denied";
    settleRegister({ state: "denied" });
    notifyChanged();
  }

  /** 許可は済んだのに、APNsへの登録に失敗した。**denied とは案内が違う。** */
  function onRegisterFailed() {
    current = null;
    clearDevice();
    lastProblem = "register-failed";
    settleRegister({ state: "register-failed" });
    notifyChanged();
  }

  function onUnregistered() {
    current = null;
    clearDevice();
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
   *
   * **「オン」はこの端末の行があるときだけ。** この端末のトークンが分からない
   * (控えが無い＝入れ直し・機種変更・別の人)ときは off。同じアカウントの行が
   * ほかにあれば elsewhere: true を添える(「この端末でも受け取るには」の案内用)。
   */
  function getState() {
    if (!ios.billingAvailable()) return Promise.resolve({ state: "unavailable" });
    if (!loggedIn()) return Promise.resolve({ state: "need-login" });
    var c = client();
    if (!c) return Promise.resolve({ state: "unavailable" });
    function off(extra) {
      var r = { state: "off" };
      if (lastProblem) r.problem = lastProblem;
      if (extra) r.elsewhere = true;
      return r;
    }
    var u = currentUser();
    function checkElsewhere() {
      return c.from(TABLE).select("token").eq("user_id", u.id).limit(1)
        .then(function (res) {
          return off(!res.error && res.data && res.data.length > 0);
        }, function () { return off(false); });
    }
    if (ensureCurrent()) {
      return c.from(TABLE).select("token").eq("token", current.token).limit(1)
        .then(function (res) {
          if (res.error) return { state: "unavailable" };
          if (res.data && res.data.length) return { state: "on" };
          // 控えのトークンの行が無い(APNs が失効を返して消した等)。控えは捨てる。
          current = null;
          clearDevice();
          return checkElsewhere();
        }, function () { return { state: "unavailable" }; });
    }
    return checkElsewhere();
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
    var t = ensureCurrent() && current.token;
    return deleteToken(t).then(function () {
      send({ type: "push.unregister" });
      current = null;
      clearDevice();
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
