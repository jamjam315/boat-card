// iOSアプリ(殻)として開かれているかの判定と、それに応じた出し分け。
//
// 【なぜ要るのか】
// 艇読みのiOSアプリは、ネイティブのタブバーの中にこのサイトを表示する殻。
// App Store Review Guideline 3.1.1 は、アプリの中からアプリ外の決済へ
// 誘導することを禁じている。「Google Playで買えます」という案内も対象になる。
// そのため、iOSアプリとして開かれたときだけ、Android/Playに触れる文言と
// PWA(ホーム画面に追加)の案内を出さないようにする。
//
// 【twa.js と同じ形にしてある】
// Androidの判定(twa.js)と役割が対になっているので、作りも合わせた。
// どちらも「隠すための判定」と「出すための判定」の2段になっている。
//   twa.js : isTWA()     / billingAvailable()
//   ios.js : isIOSApp()  / billingAvailable()
// 両方が同時に true になることはない(TWAはAndroid、殻はiOS)。
//
// 【判定の考え方】
// 殻がWebViewのUser-Agentの末尾に "TeiyomiIOS/1" を足している。既定のUAに
// 足すだけなので、iOS判定・スタンドアロン判定など他の見分け方は今までどおり動く。
//   - referrer方式(twa.js)にしなかったのは、WKWebViewの初回読み込みでは
//     referrerが空で、アプリから来たことが分からないため。
//   - sessionStorageに覚え直す必要も無い。UAはどのページでも同じように読める。
//
// 【ブラウザ・Androidでは何も変わらない】
// UAに印が無ければ isIOSApp() は false を返し、このファイルは画面に一切触れない。
// 読み込んでも表示は変わらない。
(function () {
  "use strict";

  // 殻がUAの末尾に足す印。**iOS側 lib/shell/user_agent.dart と一字一句そろえること。**
  var UA_MARKER = "TeiyomiIOS/1";

  // 殻が用意するネイティブへの窓口。**iOS側 lib/shell/native_bridge.dart と同じ名前。**
  var CHANNEL = "TeiyomiNative";

  function detect() {
    try {
      return (navigator.userAgent || "").indexOf(UA_MARKER) !== -1;
    } catch (e) {
      // UAが読めない環境。アプリではない側に倒す(隠す判定なので、
      // 間違えても「今までどおり出る」だけで済む)。
      return false;
    }
  }

  var isIOSApp = detect();

  // HTMLに印を付ける。ページ側がアプリかどうかで見た目を変えたいときに使う。
  // 付くのはアプリのときだけなので、ブラウザのDOMは1文字も変わらない。
  if (isIOSApp) {
    document.documentElement.setAttribute("data-ios-app", "1");
  }

  window.TeiyomiIOS = {
    /**
     * iOSアプリ(殻)として開かれているか。
     *
     * 使い道は「出してはいけないものを隠す」ほう。判定に失敗したら false に
     * 倒れる＝今までどおり出るので、**隠し損ねる方向に壊れる**。3.1.1に
     * 関わる文言(Google Play・Androidアプリ)をこれ1つで隠すのは危ないので、
     * そこは呼び出し側でも「Webから見たときの文言」を別に用意しておくこと。
     */
    isIOSApp: function () { return isIOSApp; },

    /**
     * このアプリの中で購入手続きを頼めるか。
     *
     * 【isIOSApp() とは別物】
     * isIOSApp() は「アプリとして開かれているか」で、文言を*隠す*ための判定。
     * こちらは「ネイティブに購入を頼めるか」で、購入UIを*出す*ための判定。
     * 引き算(隠す)ではなく足し算(出す)にしてあるのは、判定に失敗したときに
     * 必ず「買えない側」へ倒れるようにするため。
     *
     * 窓口 window.TeiyomiNative は、殻がページのどのスクリプトより先に
     * 生やしている(WKUserScriptをdocument-startで注入)。だから読み込み直後に
     * 見てよい。
     *
     * 【twa.js と違って Promise ではない】
     * あちらは getDigitalGoodsService() の橋渡しに往復が要るので Promise。
     * こちらは窓口があるかを見るだけなので同期で返す。Promiseが要る側
     * (billing-ios.js の available())は、そちらで包む。
     */
    billingAvailable: function () {
      return isIOSApp && !!window[CHANNEL];
    },

    /** ネイティブへの窓口。無ければ null。billing-ios.js が使う。 */
    channel: function () {
      return (isIOSApp && window[CHANNEL]) || null;
    },

    uaMarker: UA_MARKER,
    channelName: CHANNEL
  };
})();
