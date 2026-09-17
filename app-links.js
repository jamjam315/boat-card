// ストア(App Store / Google Play)へのリンク。**アプリの中では出さない。**
//
// 置き場所は HTML 側の `<p data-app-links hidden></p>`。このファイルが中身を入れて
// hidden を外す。読み込まなければ何も起きない(枠は hidden のまま)。
//
// 【アプリの中で出さない理由】
// ・iOSアプリ: App Store Review Guideline 3.1.1。アプリの中から外の購入経路へ
//   誘導できない。Google Play のリンクはまさにそれにあたる
// ・Androidアプリ(TWA): 入れている人に入れ直しの案内は要らない。Playのポリシーでも
//   他のストアへの誘導は避けたい
// どちらの判定も、既にある ios.js / twa.js と**同じ条件**にしてある
// (tests/app-links.test.mjs が文字列で突き合わせている)。
(function () {
  "use strict";

  // ios.js の UA_MARKER と同じ。
  var IOS_APP_MARKER = "TeiyomiIOS/1";
  // twa.js の PACKAGE / KEY と同じ。
  var TWA_PACKAGE = "com.mtpworks.teiyomi";
  var TWA_KEY = "teiyomi_twa";

  var APP_STORE = "https://apps.apple.com/jp/app/id6810243272";
  var GOOGLE_PLAY = "https://play.google.com/store/apps/details?id=" + TWA_PACKAGE;

  function isIOSApp() {
    try {
      return (navigator.userAgent || "").indexOf(IOS_APP_MARKER) !== -1;
    } catch (e) {
      return false;
    }
  }

  function isTWA() {
    var ref = "";
    try {
      if (sessionStorage.getItem(TWA_KEY) === "1") return true;
      if (/[?&]twa=1(&|$)/.test(location.search)) return true;
    } catch (e) { /* プライベートモード等。referrer だけで判定する */ }
    try { ref = document.referrer || ""; } catch (e) { ref = ""; }
    return ref.indexOf("android-app://" + TWA_PACKAGE) === 0;
  }

  function link(href, text) {
    var a = document.createElement("a");
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = text;
    return a;
  }

  function render() {
    // アプリの中なら、枠は hidden のまま(HTMLに文字が無いので、読まれることもない)。
    if (isIOSApp() || isTWA()) return;
    var boxes = document.querySelectorAll("[data-app-links]");
    for (var i = 0; i < boxes.length; i++) {
      var box = boxes[i];
      box.textContent = "";
      box.appendChild(document.createTextNode("スマホアプリ（無料）："));
      box.appendChild(link(APP_STORE, "App Store（iPhone）"));
      box.appendChild(document.createTextNode(" ／ "));
      box.appendChild(link(GOOGLE_PLAY, "Google Play（Android）"));
      box.hidden = false;
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", render);
  } else {
    render();
  }

  window.TeiyomiAppLinks = { APP_STORE: APP_STORE, GOOGLE_PLAY: GOOGLE_PLAY, render: render };
})();
