// テーマ(ライト「翠」/ ダーク「夜の水面」)の切り替え。
//
// 【読み込み方】<head> の中で、theme.css の直後に <script src="/theme.js"></script>。
// defer や async を付けないこと。付けると本文が描かれたあとにテーマが決まり、
// 一瞬明るい画面がちらつく(FOUC)。ここは意図的に読み込みを止めて先に色を決める。
//
// 【決まり方】
//   1. 利用者がボタンで選んでいれば、その選択(localStorage)が最優先
//   2. 選んでいなければ端末の設定(prefers-color-scheme)に従う
//   3. 端末の設定が変わったときも、利用者が選んでいなければ追随する
// 色そのものは theme.css が持つ。ここは <html> に data-theme を付けるだけ。
(function () {
  "use strict";

  var KEY = "teiyomi_theme";      // "light" | "dark"。未設定なら端末に従う
  var root = document.documentElement;

  function saved() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }

  // ---- ここは本文が描かれる前に走る(ちらつき防止) ----
  var pref = saved();
  if (pref === "light" || pref === "dark") root.setAttribute("data-theme", pref);

  function isDark() {
    var p = saved();
    if (p === "light" || p === "dark") return p === "dark";
    return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  }

  function applyButton(btn) {
    var dark = isDark();
    // 押すとどうなるかを出す(今の状態ではなく、行き先を示す)。
    btn.textContent = dark ? "☀️" : "🌙";
    btn.setAttribute("aria-label", dark ? "明るいテーマに切り替える" : "暗いテーマに切り替える");
    btn.title = btn.getAttribute("aria-label");
  }

  function toggle(btn) {
    var next = isDark() ? "light" : "dark";
    try { localStorage.setItem(KEY, next); } catch (e) {}
    root.setAttribute("data-theme", next);
    applyButton(btn);
    // アドレスバー(モバイル)の色も合わせる。
    syncThemeColor();
  }

  // ブラウザのアドレスバーの色。テーマに合わせて濃紺を出し分ける。
  function syncThemeColor() {
    var m = document.querySelector('meta[name="theme-color"]');
    if (!m) return;
    m.setAttribute("content", isDark() ? "#0a1114" : "#0f2a33");
  }

  function mount() {
    var bar = document.querySelector(".topbar");
    if (!bar || bar.querySelector(".theme-toggle")) return;
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "theme-toggle";
    applyButton(btn);
    btn.addEventListener("click", function () { toggle(btn); });
    bar.appendChild(btn);

    // 端末の設定が変わったとき。利用者が自分で選んでいる場合は動かさない。
    if (window.matchMedia) {
      var mq = window.matchMedia("(prefers-color-scheme: dark)");
      var onChange = function () {
        if (saved()) return;
        applyButton(btn);
        syncThemeColor();
      };
      if (mq.addEventListener) mq.addEventListener("change", onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { mount(); syncThemeColor(); });
  } else {
    mount();
    syncThemeColor();
  }
})();
