// iOSアプリ(殻)の中でプレミアムを買う処理。
//
// 【いまは何もできない】
// WP-2の段階では available() が常に false を返す。購入の中身(StoreKit・
// レシート検証)はWP-3で殻とSupabase側に入る。ここは**入れ物だけ**を先に
// 用意して、premium/index.html の出し分けをiOSでも同じ形で通すためのもの。
//
// 【billing.js(Play用)と同じ公開I/F】
//   available() / price() / priceText(p) / buy() / restore()
// 同じ形にしてあるので、呼び出し側(premium/index.html)は
// どちらが入っているかを気にしなくてよい。
//
// 【ブラウザ・Androidでは何も起きない】
// TeiyomiIOS.isIOSApp() が false のときは **window.TeiyomiBilling を
// 差し替えない**。読み込んでも Play 用の billing.js がそのまま残るので、
// ブラウザとAndroidの動きは1文字も変わらない。
//
// 前提: ios.js → billing.js の順に読み込まれていること(このファイルは最後)。
(function () {
  "use strict";

  var ios = window.TeiyomiIOS;
  if (!ios || !ios.isIOSApp()) return;   // ← ブラウザ・Androidはここで終わり

  // App Store Connect に登録する商品ID。Playと同じ文字列を使う
  // (ストアが別なので衝突しない。サーバー側の判定を1つに保てる)。
  var PRODUCT_ID = "teiyomi_premium_monthly";

  /**
   * 購入できる環境か(Promise<boolean>)。
   *
   * **WP-2では必ず false。** 窓口(TeiyomiNative)があっても、まだ購入を
   * 頼む先が無い。ここを true にするのはWP-3で、殻側にStoreKitの実装と
   * verify-purchase のiOS分岐が入ってから。
   *
   * 疑わしきは「買えない」に倒す、という billing.js と同じ方針。
   */
  function available() {
    return Promise.resolve(false);
  }

  /** ストアに登録されている価格。WP-3で窓口越しに取る。今は取れない。 */
  function price() {
    return Promise.resolve(null);
  }

  /**
   * 表示用の金額文字列。
   *
   * billing.js と同じ関数を同じ規則で持つ(日本円は「480円」、それ以外は
   * 通貨コードを添える。四捨五入はしない)。呼び出し側が両方で同じコードを
   * 通れるようにするため、いまから形をそろえておく。
   */
  function priceText(p) {
    if (!p || !p.value) return null;
    var v = String(p.value).replace(/\.0+$/, "");
    return p.currency === "JPY" ? v + "円" : v + " " + p.currency;
  }

  /** 購入する。WP-3で実装。今は「この環境では買えない」を返す。 */
  function buy() {
    return Promise.resolve({ ok: false, reason: "unavailable" });
  }

  /** 購入を復元する。WP-3で実装。 */
  function restore() {
    return Promise.resolve({ ok: false, reason: "unavailable" });
  }

  // Play用の実装を、iOSのときだけ置き換える。
  window.TeiyomiBilling = {
    productId: PRODUCT_ID,
    available: available,
    price: price,
    priceText: priceText,
    buy: buy,
    restore: restore
  };
})();
