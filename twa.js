// Androidアプリ(TWA)として開かれているかの判定と、それに応じた課金導線の出し分け。
//
// 【なぜ要るのか】
// 艇読みのAndroidアプリは、このサイトをそのまま表示するTWA(Trusted Web Activity)。
// Google Playのポリシーでは、アプリ内からアプリ外の決済へ誘導することが禁じられており、
// 「外部サイトで買えます」というリンクや案内も対象になる。そのため、アプリとして
// 開かれたときだけ購入への導線を隠す。ブラウザで開いたときは今までどおり。
//
// 【判定の考え方】
// TWAから起動されたページは document.referrer が "android-app://<パッケージ名>" になる。
// これはアプリ起動直後の1ページ目にしか付かないので、一度判定したらsessionStorageに
// 覚えておき、サイト内を移動しても維持する。
//   - localStorageではなくsessionStorageなのは、ブラウザで ?twa=1 を試したあと、
//     その端末のブラウザでずっと導線が消えたままになるのを避けるため。
//   - 「スタンドアロン表示かどうか」だけでは判定しない。ブラウザからホーム画面に
//     追加したPWAも同じ扱いになってしまい、ただのWeb利用者にまで導線が消えるため。
//
// 【将来ポリシーが緩んだら】
// 判定はこのファイル1つに閉じている。TeiyomiTWA.isTWA() が常に false を返すように
// すれば、サイト全体が元の表示に戻る(呼び出し側は一切触らなくてよい)。
(function () {
  "use strict";

  var PACKAGE = "com.mtpworks.teiyomi";
  var KEY = "teiyomi_twa";

  // アプリ内で有料機能に触れたときの案内。購入を促さず、外部への導線も置かない。
  var GATE_TEXT = "この機能は艇読みプレミアム（Web版）でご利用いただけます。";

  function detect() {
    try {
      if (sessionStorage.getItem(KEY) === "1") return true;
      var ref = document.referrer || "";
      // 動作確認用の手動指定。sessionStorageに入るので、タブを閉じれば元に戻る。
      var forced = /[?&]twa=1(&|$)/.test(location.search);
      if (forced || ref.indexOf("android-app://" + PACKAGE) === 0) {
        sessionStorage.setItem(KEY, "1");
        return true;
      }
    } catch (e) {
      // プライベートモード等でsessionStorageが使えない場合。referrerだけで判定する。
      return (document.referrer || "").indexOf("android-app://" + PACKAGE) === 0;
    }
    return false;
  }

  var isTWA = detect();

  // HTMLに印を付ける。静的に書かれた購入ボタンは、この印を見てCSSで隠す
  // (JSで1つずつ消すと、消し忘れが起きるうえ一瞬見えてしまう)。
  if (isTWA) {
    var el = document.documentElement;
    el.setAttribute("data-twa", "1");
    var s = document.createElement("style");
    s.id = "twaStyle";
    // data-premium-cta を付けた要素が、アプリでは最初から表示されない。
    s.textContent = '[data-twa="1"] [data-premium-cta]{display:none !important;}';
    (document.head || el).appendChild(s);
  }

  window.TeiyomiTWA = {
    /** Androidアプリ(TWA)として開かれているか。 */
    isTWA: function () { return isTWA; },
    /** アプリ内で有料機能に触れたときの案内文(購入を促さない)。 */
    gateText: function () { return GATE_TEXT; },
    packageName: PACKAGE
  };
})();
