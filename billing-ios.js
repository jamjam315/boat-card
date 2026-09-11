// iOSアプリ(殻)の中でプレミアムを買う処理(WP-3c)。
//
// 【全体の流れ】Play用の billing.js と同じ6段。違うのは②③の相手が殻であること。
//   ① iap.products     … 価格を殻経由でストアから取る(コードに金額を書かない)
//   ② iap.buy          … 殻がAppleの購入シートを出す
//   ③ purchase ok+jws  … 買えたら殻から証跡(JWS)が届く
//   ④ verify-purchase  … サーバーがAppleに問い合わせて本物か確かめ、membershipsを書く
//   ⑤ iap.verified     … サーバーの答えを殻へ返す(殻はこれを待って取引を完了させる)
//   ⑥ reload()         … 会員状態を取り直して、開いている画面すべてを更新する
//
// 【ここでやらないこと】
// 「買えたかどうか」をこのファイルで判断しない。殻が ok を返しても、権利が付くのは
// サーバーが検証を通したときだけ(④)。ブラウザ側の申告でプレミアムになる経路は
// 作らない。画面も描かない(描くのは premium/index.html)。
//
// 【殻とのやりとり(teiyomi-ios の README「購入ブリッジ」と一字一句そろえる)】
//   Web→殻  TeiyomiNative.postMessage(JSON) … token(window.__teiyomiNative.token)必須
//           iap.products / iap.buy {productId} / iap.restore / iap.verified {requestId, ok}
//   殻→Web  window.TeiyomiIOSBilling.onEvent(payload)
//           {type:'products', items:[{id, priceText, price, currency}]}
//           {type:'purchase', requestId, status:'ok', jws} | {type:'purchase', status:'cancelled'|'pending'|'error'}
//           {type:'restore',  requestId, status:'ok', jws} | {type:'restore',  status:'empty'|'error'}
//
// 【iap.verified を返す・返さないの規則】殻は返事が来るまで取引を完了させない。
//   サーバーが 2xx で答えた      → ok: is_active の値
//   サーバーが 4xx で明示拒否    → ok:false
//   通信失敗・タイムアウト・5xx  → **返さない**。取引は未完了のまま次の起動で再配送され、
//                                   そのときもう一度ここへ来る(サーバーは originalTransactionId で冪等)
//
// 【起動時の復元は条件付き(step0回答①)】
// Androidは起動ごとに restore() で更新と解約を検知するが、iOSの復元はApple IDの
// パスワード入力を求めることがある。次を全部満たすときだけ、1セッション1回送る。
//   (a) iOSアプリの中  (b) ログイン済み  (c) 会員状態が「未契約」
//   (d) この端末・このアカウントで過去にiOSの検証が通っている(VERIFIED_KEY の印)
// 初回購入前の人には一切出ず、更新期を迎えた課金者にだけ走る。
//
// 【ブラウザ・Androidでは何も起きない】
// TeiyomiIOS.isIOSApp() が false のときは window.TeiyomiBilling を差し替えない。
// 読み込んでも Play 用の billing.js がそのまま残るので、動きは1文字も変わらない。
//
// 前提: ios.js → favorites.js → membership.js → billing.js → billing-ios.js の順(このファイルは最後)。
(function () {
  "use strict";

  var ios = window.TeiyomiIOS;
  if (!ios || !ios.isIOSApp()) return;   // ← ブラウザ・Androidはここで終わり

  // 【二重読み込みに耐える】ios.js が全ページに差し込むぶんと、premium の静的な
  // <script> のぶんで2回読まれる。状態(返事待ち・保持中の取引)は最初の1回が
  // 持ち、2回目以降は TeiyomiBilling を戻すだけ(間に billing.js が Play用で
  // 上書きしていても、最後に読まれたこちらが勝つ)。
  if (window.__teiyomiIOSBillingApi) {
    window.TeiyomiBilling = window.__teiyomiIOSBillingApi;
    if (window.__teiyomiIOSBillingWire) window.__teiyomiIOSBillingWire();
    return;
  }

  // App Store Connect の商品ID。Playと同じ文字列(ストアが別なので衝突しない)。
  // 殻(lib/billing/purchase_bridge.dart の teiyomiProductId)と一字一句そろえる。
  var PRODUCT_ID = "teiyomi_premium_monthly";
  var VERIFY_PATH = "/functions/v1/verify-purchase";
  var VERIFY_TIMEOUT_MS = 20000;

  // (d) の印。localStorage に {userId, at} を置く。値はアカウントの識別子だけで、
  // 購入の証跡(JWS)は入れない(端末に控えを残す理由が無い)。
  var VERIFIED_KEY = "teiyomi_ios_verified";
  // 起動時の復元を1セッション1回に抑える印(sessionStorage)。
  var SESSION_KEY = "teiyomi_ios_billing_checked";

  // ---- 殻への送信 -----------------------------------------------------------

  /**
   * 殻へ合図を送る。**合言葉が無ければ送らない**(戻り値 false)。
   *
   * 合言葉はメインフレームにしか配られない(殻の native_bridge.dart)。無いのは
   * 枠の中か、殻がまだ配り終えていないか。どちらも送る相手として正しくない。
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

  // ---- 返事待ち -------------------------------------------------------------
  // 殻の合図は onEvent に届くので、Promise の resolve を控えておいて突き合わせる。

  var priceWaiters = [];      // iap.products の返事待ち(複数可)
  var buyWaiter = null;       // iap.buy の返事待ち(同時に1つ)
  var restoreWaiter = null;   // iap.restore の返事待ち(同時に1つ)
  var lastProducts = null;    // 最後に届いた商品一覧(画面の描き直しで使い回す)

  // 未ログインのときに届いた取引(WP-3d)。ログインが済んだら検証する。
  // requestId で重複を除く(殻は同じ requestId で何度も送り直してくる)。
  var held = {};              // requestId → {requestId, jws, restored}
  var inFlight = {};          // 検証中の requestId(同じ依頼を二重に投げない)

  function settle(waiterRef, value) {
    var w = waiterRef.fn; waiterRef.fn = null;
    if (w) w(value);
  }

  // ---- 会員状態の更新 -------------------------------------------------------

  function reloadMembership() {
    var m = window.TeiyomiMembership;
    if (m && m.reload) m.reload();
  }

  function currentUser() {
    var auth = window.TeiyomiAuth;
    return (auth && auth.getUser && auth.getUser()) || null;
  }

  function markVerified(userId) {
    try {
      localStorage.setItem(VERIFIED_KEY, JSON.stringify({ userId: userId, at: new Date().toISOString() }));
    } catch (e) { /* プライベートモード等。印が無いと起動時の復元が走らないだけ */ }
  }

  function verifiedMarkFor(userId) {
    try {
      var raw = localStorage.getItem(VERIFIED_KEY);
      if (!raw) return false;
      var v = JSON.parse(raw);
      return !!(v && v.userId === userId);
    } catch (e) { return false; }
  }

  // ---- 公開I/F(billing.js と同じ顔ぶれ) ------------------------------------

  /** 購入できる環境か(Promise<boolean>)。殻の窓口があるときだけ true。 */
  function available() {
    return Promise.resolve(!!ios.billingAvailable());
  }

  /**
   * 価格。{value, currency, text} を返す。取れなければ null。
   * **text はストアが組み立てた表示用文字列(¥480)。** こちらでは加工しない。
   */
  function price() {
    if (!ios.billingAvailable()) return Promise.resolve(null);
    return new Promise(function (resolve) {
      priceWaiters.push(resolve);
      if (!send({ type: "iap.products" })) {
        priceWaiters.pop();
        resolve(null);
      }
    });
  }

  /** 表示用の金額文字列。ストアの priceText をそのまま返す(自前で組み立てない)。 */
  function priceText(p) {
    return (p && p.text) ? String(p.text) : null;
  }

  /**
   * サーバーに検証を頼む。
   *
   * 返り値(Promise): {answered:true, active} … サーバーが答えた(2xx/4xx)
   *                  {answered:false}        … 通信失敗・タイムアウト・5xx(答えを聞けていない)
   * この区別が iap.verified を返すかどうかを決める。
   */
  function verify(jws) {
    var auth = window.TeiyomiAuth;
    if (!auth || !auth.getConfig || !auth.getAccessToken) return Promise.resolve({ answered: false });
    var cfg = auth.getConfig();
    if (!cfg || !cfg.url) return Promise.resolve({ answered: false });

    return auth.getAccessToken().then(function (token) {
      // 未ログイン(トークン無し)は「答えを聞けていない」側。ログイン後の再配送で拾う。
      if (!token) return { answered: false };
      var ctl = (typeof AbortController === "function") ? new AbortController() : null;
      var timer = ctl ? setTimeout(function () { ctl.abort(); }, VERIFY_TIMEOUT_MS) : null;
      return fetch(cfg.url + VERIFY_PATH, {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + token,
          "apikey": cfg.anonKey,
          "content-type": "application/json"
        },
        body: JSON.stringify({ purchase_token: jws, product_id: PRODUCT_ID, platform: "ios" }),
        signal: ctl ? ctl.signal : undefined
      }).then(function (r) {
        if (timer) clearTimeout(timer);
        if (r.status >= 500) return { answered: false };            // サーバー側の不調。聞き直す
        // 明示の拒否。409 は「その購読は別のアカウントに紐づいている」
        // (verify-purchase の tokenTakenByOther)。画面の文言を分けるために残す。
        if (!r.ok) return { answered: true, active: false, status: r.status };
        return r.json().then(function (j) {
          return { answered: true, active: !!(j && j.is_active), status: r.status };
        }, function () { return { answered: false }; });
      }, function () {
        if (timer) clearTimeout(timer);
        return { answered: false };
      });
    }).catch(function () { return { answered: false }; });
  }

  /**
   * 殻から届いた証跡をサーバーで確かめ、答えを殻へ返す。
   * 返り値(Promise<boolean>): サーバーが有効と答えたか。
   */
  function loggedIn() {
    var u = currentUser();
    return !!(u && !u.isAnonymous);
  }

  /**
   * 返り値(Promise): {active:true} | {active:false, reason} | null(答えを聞けていない)
   *   reason: "other_account"(409) | "not_verified"
   *
   * 未ログインなら**検証せずに保持**し、ログイン完了(teiyomi-auth-changed)後に
   * 検証する。殻は返事が来るまで完了させないので、ここで捨てても取引は
   * 失われないが、ログインした瞬間に片づけるほうが早い。
   */
  function verifyAndReply(requestId, jws, restored) {
    if (!loggedIn()) {
      held[requestId] = { requestId: requestId, jws: jws, restored: !!restored };
      return Promise.resolve(null);
    }
    if (inFlight[requestId]) return Promise.resolve(null);   // 同じ依頼が検証中
    inFlight[requestId] = true;
    return verify(jws).then(function (res) {
      delete inFlight[requestId];
      if (!res.answered) return null;   // **返さない**(次の起動で再配送される)
      send({ type: "iap.verified", requestId: requestId, ok: !!res.active });
      delete held[requestId];
      if (res.active) {
        var u = currentUser();
        if (u && u.id) markVerified(u.id);
        reloadMembership();   // 開いている画面すべてを描き直す
        return { active: true };
      }
      return { active: false, reason: res.status === 409 ? "other_account" : "not_verified" };
    });
  }

  /** ログインが済んだので、保持していた取引を検証する。 */
  function flushHeld() {
    if (!loggedIn()) return;
    Object.keys(held).forEach(function (id) {
      var h = held[id];
      verifyAndReply(h.requestId, h.jws, h.restored).then(function (res) {
        // 画面(premium)が開いていれば、結果は reload で描き直される。
        // 拒否されたときの文言は、次に buy/restore を押したときに出る。
        if (res && !res.active) lastRejection = res.reason;
      });
    });
  }
  var lastRejection = null;
  window.addEventListener("teiyomi-auth-changed", flushHeld);

  /**
   * 購入する。返り値は billing.js と同じ形 {ok, reason}。
   *   reason: "unavailable" | "cancelled" | "pending" | "not_verified" | "failed"
   */
  function buy() {
    if (!ios.billingAvailable()) return Promise.resolve({ ok: false, reason: "unavailable" });
    if (buyWaiter && buyWaiter.fn) return Promise.resolve({ ok: false, reason: "failed" });   // 二重押し
    return new Promise(function (resolve) {
      buyWaiter = { fn: resolve };
      if (!send({ type: "iap.buy", productId: PRODUCT_ID })) {
        settle(buyWaiter, { ok: false, reason: "unavailable" });
      }
    });
  }

  /**
   * 購入を復元する。返り値 {ok, reason}。reason: "unavailable" | "no_purchase" | "not_verified" | "failed"
   */
  function restore() {
    if (!ios.billingAvailable()) return Promise.resolve({ ok: false, reason: "unavailable" });
    if (restoreWaiter && restoreWaiter.fn) return Promise.resolve({ ok: false, reason: "failed" });
    return new Promise(function (resolve) {
      restoreWaiter = { fn: resolve };
      if (!send({ type: "iap.restore" })) {
        settle(restoreWaiter, { ok: false, reason: "unavailable" });
      }
    });
  }

  // ---- 殻からの合図 -----------------------------------------------------------

  function onProducts(e) {
    var items = Array.isArray(e.items) ? e.items : [];
    var item = null;
    for (var i = 0; i < items.length; i++) {
      if (items[i] && items[i].id === PRODUCT_ID) { item = items[i]; break; }
    }
    lastProducts = item ? { value: item.price, currency: item.currency, text: item.priceText } : null;
    var ws = priceWaiters; priceWaiters = [];
    ws.forEach(function (fn) { fn(lastProducts); });
  }

  function onPurchase(e) {
    var w = buyWaiter || { fn: null };
    switch (e.status) {
      case "ok":
        // 検証を頼んだ取引かどうかに関わらず確かめる。起動時に再配送された
        // 取引(buyWaiter 無し)もここへ来る。
        if (typeof e.requestId !== "string" || typeof e.jws !== "string") return;
        verifyAndReply(e.requestId, e.jws, false).then(function (res) {
          // 答えを聞けていない(通信失敗等)ときも、押した人を待たせ続けない。
          // 取引そのものは殻が持っていて、次の起動か「復元」で片づく。
          if (res === null) { settle(w, { ok: false, reason: "not_verified" }); return; }
          settle(w, res.active ? { ok: true } : { ok: false, reason: res.reason });
        });
        return;
      case "cancelled": settle(w, { ok: false, reason: "cancelled" }); return;
      case "pending":   settle(w, { ok: false, reason: "pending" });   return;
      default:          settle(w, { ok: false, reason: "failed" });    return;
    }
  }

  function onRestore(e) {
    var w = restoreWaiter || { fn: null };
    switch (e.status) {
      case "ok":
        if (typeof e.requestId !== "string" || typeof e.jws !== "string") return;
        verifyAndReply(e.requestId, e.jws, true).then(function (res) {
          if (res === null) { settle(w, { ok: false, reason: "not_verified" }); return; }
          settle(w, res.active ? { ok: true } : { ok: false, reason: res.reason });
        });
        return;
      case "empty":  settle(w, { ok: false, reason: "no_purchase" }); return;
      default:       settle(w, { ok: false, reason: "failed" });      return;
    }
  }

  // **受け口。** 殻はこれが無ければ黙って捨てる。iap.products を送る前に定義する。
  window.TeiyomiIOSBilling = {
    onEvent: function (e) {
      if (!e || typeof e !== "object") return;
      switch (e.type) {
        case "products": onProducts(e); break;
        case "purchase": onPurchase(e); break;
        case "restore":  onRestore(e);  break;
        default: break;   // 知らない合図は捨てる
      }
    }
  };

  // ---- 起動時の復元(条件付き) --------------------------------------------------

  function autoRestoreIfRenewalDue(state) {
    if (!ios.billingAvailable()) return;                          // (a)
    if (!state || !state.user || state.user.isAnonymous) return;  // (b)
    if (state.active !== false) return;                           // (c) 未契約のときだけ
    if (!verifiedMarkFor(state.user.id)) return;                  // (d) 以前この端末で通っている
    try { if (sessionStorage.getItem(SESSION_KEY) === "1") return; } catch (e) {}
    try { sessionStorage.setItem(SESSION_KEY, "1"); } catch (e) {}
    restore();   // 結果は見ない。反映は verifyAndReply → reload() が行う
  }

  // 会員状態への配線。membership.js より先に読まれることがある(ios.js からの
  // 動的挿入)ので、あとから読まれた側(premium の静的タグ)からも呼び直せるようにする。
  var wired = false;
  function wireMembership() {
    if (wired) return;
    var m = window.TeiyomiMembership;
    if (!m || !m.onChange) return;
    wired = true;
    m.onChange(autoRestoreIfRenewalDue);
  }
  wireMembership();
  window.__teiyomiIOSBillingWire = wireMembership;

  // Play用の実装を、iOSのときだけ置き換える。
  window.__teiyomiIOSBillingApi = window.TeiyomiBilling = {
    productId: PRODUCT_ID,
    available: available,
    price: price,
    priceText: priceText,
    buy: buy,
    restore: restore,
    /** 最後に届いた商品(画面の描き直し用)。まだ取っていなければ null。 */
    lastProducts: function () { return lastProducts; },
    /** 直近で拒否された理由("other_account" など)。画面が拾って出す。 */
    lastRejection: function () { var r = lastRejection; lastRejection = null; return r; },
    // 検証用の入口。画面からは呼ばない。
    _verify: verify
  };
})();
