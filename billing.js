// アプリ(TWA)内でプレミアムを買う処理。
//
// 【全体の流れ】
//   ① getDetails()    … 価格をストアから取る(コードに金額を書かない)
//   ② PaymentRequest  … Playの購入シートを出す
//   ③ purchaseToken   … 買えたら手に入る引換券のようなもの
//   ④ verify-purchase … サーバーがGoogleに問い合わせて本物か確かめ、membershipsを書く
//   ⑤ complete()      … 購入シートを閉じる
//   ⑥ reload()        … 会員状態を取り直して、開いている画面すべてを更新する
//
// 【ここでやらないこと】
// 「買えたかどうか」をこのファイルで判断しない。購入シートが成功を返しても、
// 権利が付くのはサーバーが検証を通したときだけ(④)。ブラウザ側の申告で
// プレミアムになる経路は作らない。
//
// 【ブラウザで開いたときは何もしない】
// window.getDigitalGoodsService が無ければ TeiyomiBilling.available() が false を
// 返すだけで、このファイルは画面に一切触れない。読み込んでも表示は変わらない。
//
// 前提: twa.js → favorites.js → membership.js の順に読み込まれていること。
(function () {
  "use strict";

  var PRODUCT_ID = "teiyomi_premium_monthly";
  var VERIFY_PATH = "/functions/v1/verify-purchase";

  function twa() { return window.TeiyomiTWA || null; }

  /** 購入できる環境か(Promise<boolean>)。 */
  function available() {
    var t = twa();
    if (!t || !t.billingAvailable) return Promise.resolve(false);
    return t.billingAvailable();
  }

  /**
   * ストアに登録されている価格を取ってくる。
   *
   * 金額をコードに書かない。国・通貨・キャンペーンで変わる値なので、
   * 書くと実際の請求額と表示が食い違う。取れなければ null を返し、
   * 呼び出し側は金額を伏せた文言にする。
   */
  function price() {
    var t = twa();
    if (!t || !t.billingService) return Promise.resolve(null);
    return t.billingService().then(function (svc) {
      if (!svc) return null;
      return svc.getDetails([PRODUCT_ID]).then(function (items) {
        var item = (items || [])[0];
        if (!item || !item.price) return null;
        // { value: "480", currency: "JPY" } の形で来る。
        return {
          value: item.price.value,
          currency: item.price.currency,
          title: item.title || null,
          raw: item
        };
      });
    }).catch(function () { return null; });
  }

  /**
   * 表示用の金額文字列。日本円は「480円」、それ以外は通貨コードを添える。
   *
   * 値は四捨五入しない。円は小数が無いので丸めても同じに見えるが、
   * ドルなら 3.99 が 4 になってしまい、実際の請求額と食い違う。
   * 「480.00」のように小数が付いてきた場合だけ、意味の変わらない範囲で落とす。
   */
  function priceText(p) {
    if (!p || !p.value) return null;
    var v = String(p.value).replace(/\.0+$/, "");
    return p.currency === "JPY" ? v + "円" : v + " " + p.currency;
  }

  /** 検証結果をサーバーに問い合わせる。失敗はすべて「無効」に倒す。 */
  function verify(purchaseToken) {
    var auth = window.TeiyomiAuth;
    if (!auth || !auth.getConfig || !auth.getAccessToken) {
      return Promise.resolve({ is_active: false });
    }
    var cfg = auth.getConfig();
    if (!cfg || !cfg.url) return Promise.resolve({ is_active: false });

    return auth.getAccessToken().then(function (token) {
      if (!token) return { is_active: false };
      return fetch(cfg.url + VERIFY_PATH, {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + token,
          "apikey": cfg.anonKey,
          "content-type": "application/json"
        },
        body: JSON.stringify({ purchase_token: purchaseToken, product_id: PRODUCT_ID })
      }).then(function (r) {
        // 2xx以外(未認証・他人のトークン等)は無効。本文は当てにしない。
        if (!r.ok) return { is_active: false };
        return r.json();
      });
    }).catch(function () {
      return { is_active: false };
    });
  }

  /**
   * 購入する。
   *
   * 返り値(Promise): { ok, reason }
   *   ok:true                … 買えて、サーバーの検証も通った
   *   reason:"unavailable"   … この環境では買えない
   *   reason:"cancelled"     … 利用者が購入シートを閉じた
   *   reason:"not_verified"  … 買えたが検証が通らなかった(返金・重複購入など)
   *   reason:"failed"        … それ以外の失敗
   *
   * 「買えた」と答えるのは、サーバーが有効だと答えたときだけ。
   */
  function buy() {
    var t = twa();
    if (!t || !t.billingService) return Promise.resolve({ ok: false, reason: "unavailable" });

    return t.billingService().then(function (svc) {
      if (!svc) return { ok: false, reason: "unavailable" };

      // 金額は表示のためだけに使う。実際の請求額はPlay側が決める。
      return svc.getDetails([PRODUCT_ID]).then(function (items) {
        var item = (items || [])[0];
        if (!item) return { ok: false, reason: "unavailable" };

        var request = new PaymentRequest(
          [{ supportedMethods: t.paymentMethod, data: { sku: PRODUCT_ID } }],
          { total: { label: item.title || "艇読みプレミアム", amount: item.price } }
        );

        return request.show().then(function (response) {
          var token = response.details && response.details.purchaseToken;
          if (!token) {
            return response.complete("fail").then(function () {
              return { ok: false, reason: "failed" };
            });
          }
          // サーバーの検証が終わってから購入シートを閉じる。先に閉じると、
          // 検証に失敗したのに「買えた」ように見える瞬間ができる。
          return verify(token).then(function (res) {
            var okNow = !!(res && res.is_active);
            return response.complete(okNow ? "success" : "fail").then(function () {
              if (!okNow) return { ok: false, reason: "not_verified" };
              // 開いている画面すべてを新しい会員状態で描き直す。
              if (window.TeiyomiMembership && TeiyomiMembership.reload) {
                TeiyomiMembership.reload();
              }
              return { ok: true };
            });
          });
        }, function (err) {
          // AbortError = 利用者が閉じた。それ以外は本当の失敗。
          var name = err && err.name;
          return { ok: false, reason: name === "AbortError" ? "cancelled" : "failed" };
        });
      });
    }).catch(function () {
      return { ok: false, reason: "failed" };
    });
  }

  /**
   * すでに持っている購読をサーバーに確かめ直す。
   *
   * 機種変更したとき・解約したあと・支払いが止まったときに、画面の表示を
   * 実際の状態へ寄せるためのもの。呼ぶ場所はタスク⑦で足す。
   */
  function restore() {
    var t = twa();
    if (!t || !t.billingService) return Promise.resolve({ ok: false, reason: "unavailable" });
    return t.billingService().then(function (svc) {
      if (!svc || !svc.listPurchases) return { ok: false, reason: "unavailable" };
      return svc.listPurchases().then(function (list) {
        var mine = (list || []).filter(function (p) { return p.itemId === PRODUCT_ID; });
        if (!mine.length) return { ok: false, reason: "no_purchase" };
        return verify(mine[0].purchaseToken).then(function (res) {
          if (window.TeiyomiMembership && TeiyomiMembership.reload) {
            TeiyomiMembership.reload();
          }
          return { ok: !!(res && res.is_active) };
        });
      });
    }).catch(function () {
      return { ok: false, reason: "failed" };
    });
  }

  window.TeiyomiBilling = {
    productId: PRODUCT_ID,
    available: available,
    price: price,
    priceText: priceText,
    buy: buy,
    restore: restore
  };
})();
