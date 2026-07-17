// お気に入り選手(登番)の登録状態をlocalStorageで管理する共通ロジック。
// 選手個別ページ(players/{登番}.html)と選手一覧ページ(players/index.html)の
// 両方から読み込む(ページはそれぞれ自己完結のまま、このファイルだけ共有する)。
// サーバー通信・アカウントは一切なし。localStorageが使えない環境でも
// ページ自体が壊れないよう、読み書きは必ずtry/catchで囲む。
//
// 「ホーム画面に追加」の案内は、自動ポップアップより常設ボタンを主役にする
// (押し付けない思想に合わせた見直し)。自動で出すのはお気に入りを初めて
// ★オンにした時の1回だけ(以降は自動で出さない、再表示の間引き等も入れない)。
// トップページの常設ボタンから呼ぶ分は、この「初回だけ」の制限を受けず
// いつでも開ける(showAddToHomeGuide)。サービスワーカー・プッシュ購読・
// サーバー連携は今回含まない。
(function () {
  var FAV_KEY = "teiyomi_favorites_players";
  var A2HS_KEY = "teiyomi_a2hs_prompted";

  // ==== Supabaseクラウド同期(端末をまたいだお気に入りの引き継ぎの土台) ====
  // ログイン画面は無く、匿名認証(supabase.auth.signInAnonymously)で端末ごとに
  // 発行されるユーザーIDにお気に入りを紐づけて保存する。個人情報は一切扱わない。
  //
  // 【localStorageとの優先関係(重要・データが消えない設計)】
  // 起動時、Supabase側とlocalStorage側のお気に入りを「和集合」でまとめる。
  // 片方にしか無い項目も消さず両方に反映する(後勝ち等にしない)。既存ユーザーが
  // この更新後はじめて開いたときも、端末内のお気に入りが消えずSupabaseに
  // 引き継がれるのはこの和集合方式のため。明示的な★解除だけが削除として働く。
  //
  // 【できること・できないこと】
  // 同じ端末・同じブラウザを使い続ける限りクラウドにもバックアップされる。
  // ただし匿名認証には「同じ人」を跨ぐ概念が無いため、別端末・別ブラウザは
  // 別々の匿名IDになり、今回の実装だけでは自動で同じお気に入りは見えない。
  // 本当の端末間同期には、将来ログイン機能(メール等)を足す必要がある。
  //
  // Supabase未接続・オフライン・タイムアウト等はすべてtry/catchで握りつぶし、
  // これまで通りlocalStorageだけで動作する(サーバーが落ちても主要機能は
  // 生き残る、という艇読み全体の設計思想をここでも守る)。
  var SUPA_CONFIG_URL = "/supabase-config.json";
  var SUPA_SDK_URL = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";
  var SUPA_TABLE = "favorite_players";
  var supaClient = null;
  var supaUserId = null;
  var supaReady = false;

  function loadSupaSdk() {
    return new Promise(function (resolve, reject) {
      if (window.supabase && window.supabase.createClient) { resolve(); return; }
      var s = document.createElement("script");
      s.src = SUPA_SDK_URL;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error("supabase sdk load failed")); };
      document.head.appendChild(s);
    });
  }

  function initCloudSync() {
    fetch(SUPA_CONFIG_URL, { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("config fetch failed: " + r.status);
        return r.json();
      })
      .then(function (cfg) {
        if (!cfg || !cfg.url || !cfg.anonKey || cfg.url.indexOf("YOUR_") === 0) {
          throw new Error("supabase-config.json 未設定");
        }
        return loadSupaSdk().then(function () { return cfg; });
      })
      .then(function (cfg) {
        supaClient = window.supabase.createClient(cfg.url, cfg.anonKey);
        return supaClient.auth.getSession();
      })
      .then(function (res) {
        var session = res && res.data && res.data.session;
        if (session) return session;
        return supaClient.auth.signInAnonymously().then(function (r) {
          if (r.error) throw r.error;
          return r.data.session;
        });
      })
      .then(function (session) {
        supaUserId = session.user.id;
        supaReady = true;
        return syncOnLoad();
      })
      .catch(function () {
        // 接続できなくても致命的にしない。以降はlocalStorageのみで動作する。
        supaReady = false;
      });
  }

  function syncOnLoad() {
    return supaClient
      .from(SUPA_TABLE)
      .select("toban")
      .eq("user_id", supaUserId)
      .then(function (res) {
        if (res.error) throw res.error;
        var remote = (res.data || []).map(function (row) { return String(row.toban); });
        var local = readAll();
        var localSet = {}, remoteSet = {};
        local.forEach(function (t) { localSet[t] = true; });
        remote.forEach(function (t) { remoteSet[t] = true; });

        // 和集合をlocalStorageへ反映(リモートにしか無かった分を取り込む)。
        var merged = local.slice();
        remote.forEach(function (t) { if (!localSet[t]) merged.push(t); });
        if (merged.length !== local.length) writeAll(merged);

        // ローカルにしか無かった分をSupabaseへ引き継ぐ(既存ユーザー対応)。
        local.forEach(function (t) { if (!remoteSet[t]) pushAdd(t); });

        try {
          window.dispatchEvent(new CustomEvent("teiyomi-favorites-synced", { detail: { list: merged } }));
        } catch (e) {}
      })
      .catch(function () {});
  }

  function pushAdd(toban) {
    if (!supaReady) return;
    supaClient
      .from(SUPA_TABLE)
      .upsert({ user_id: supaUserId, toban: String(toban) }, { onConflict: "user_id,toban", ignoreDuplicates: true })
      .then(function () {}, function () {});
  }

  function pushRemove(toban) {
    if (!supaReady) return;
    supaClient
      .from(SUPA_TABLE)
      .delete()
      .eq("user_id", supaUserId)
      .eq("toban", String(toban))
      .then(function () {}, function () {});
  }

  function readAll() {
    try {
      var raw = localStorage.getItem(FAV_KEY);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.map(String) : [];
    } catch (e) {
      return [];
    }
  }

  function writeAll(arr) {
    try {
      localStorage.setItem(FAV_KEY, JSON.stringify(arr));
    } catch (e) {
      // 保存できない環境(プライベートモード等)ではお気に入りが次回に
      // 引き継がれないだけにし、それ以外の動作は妨げない。
    }
  }

  window.TeiyomiFavorites = {
    list: function () {
      return readAll();
    },
    has: function (toban) {
      return readAll().indexOf(String(toban)) !== -1;
    },
    toggle: function (toban) {
      toban = String(toban);
      var arr = readAll();
      var idx = arr.indexOf(toban);
      var added = idx === -1;
      if (added) arr.push(toban);
      else arr.splice(idx, 1);
      writeAll(arr);   // 即時反映(localStorage、Supabaseの結果を待たない)
      try {
        if (added) pushAdd(toban); else pushRemove(toban);
      } catch (e) {
        // クラウド同期の失敗は無視。次回起動時のsyncOnLoadで再同期される。
      }
      if (added) maybeShowA2HS();
      return added; // 追加後ならtrue、削除後ならfalse
    },
    // トップページの常設ボタン用。スタンドアロン起動中・PC幅では出す意味が
    // 無いため、ボタン自体を出すかどうかの判定にそのまま使える。
    canShowAddToHome: function () {
      return !isStandalone() && isMobile();
    },
    // 常設ボタンから明示的に呼ばれた場合は、初回だけの制限(a2hsAlreadyPrompted)
    // を経由せずいつでも案内を開ける(押しに来た人には毎回応える)。
    showAddToHomeGuide: function () {
      showA2HSBanner();
    }
  };

  // ==== ホーム画面への追加案内(A2HS) ====

  // beforeinstallpromptはブラウザが好きなタイミングで発火するため、
  // スクリプト読み込み時点で(★を押す前から)必ず購読しておき、実際に
  // 使うのは案内を出す時点まで取っておく。
  var deferredInstallPrompt = null;
  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    deferredInstallPrompt = e;
  });

  function a2hsAlreadyPrompted() {
    try {
      return localStorage.getItem(A2HS_KEY) === "1";
    } catch (e) {
      return true; // 読み書きできない環境では二度と出さない(安全側)
    }
  }

  function markA2hsPrompted() {
    try {
      localStorage.setItem(A2HS_KEY, "1");
    } catch (e) {
      // 保存できなければ次回また出てしまうが、ページは壊さない。
    }
  }

  function isStandalone() {
    return (
      (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
      window.navigator.standalone === true // iOS Safariの独自プロパティ
    );
  }

  function isIOS() {
    return /iPhone|iPad|iPod/.test(navigator.userAgent) && !window.MSStream;
  }

  function isAndroid() {
    return /Android/.test(navigator.userAgent);
  }

  function isMobile() {
    // PCでは出さない。UAに加えビューポート幅でも二重に確認する。
    return (isIOS() || isAndroid()) && window.innerWidth <= 768;
  }

  function maybeShowA2HS() {
    if (a2hsAlreadyPrompted()) return;
    if (isStandalone()) return;
    if (!isMobile()) return;
    markA2hsPrompted();
    showA2HSBanner();
  }

  function ensureBannerStyle() {
    if (document.getElementById("teiyomiA2hsStyle")) return;
    var style = document.createElement("style");
    style.id = "teiyomiA2hsStyle";
    style.textContent =
      "#teiyomiA2hsBanner{position:fixed; left:0; right:0; bottom:0; z-index:9999;" +
      "background:var(--surface,#fff); border-top:1px solid var(--line,#e2e5e0);" +
      "box-shadow:0 -4px 16px rgba(0,0,0,.10); padding:14px 16px calc(14px + env(safe-area-inset-bottom));" +
      "font-family:inherit;}" +
      "#teiyomiA2hsBanner .teiyomi-a2hs-inner{max-width:680px; margin:0 auto; position:relative; padding-right:26px;}" +
      "#teiyomiA2hsBanner .teiyomi-a2hs-close{position:absolute; top:-8px; right:-8px; background:none; border:none;" +
      "font-size:20px; line-height:1; color:var(--muted,#7c8a90); cursor:pointer; padding:8px;" +
      "-webkit-tap-highlight-color:transparent;}" +
      "#teiyomiA2hsBanner .teiyomi-a2hs-text{margin:0; font-size:12.5px; color:var(--ink,#13242a); line-height:1.6;}" +
      "#teiyomiA2hsBanner .teiyomi-a2hs-steps{margin:7px 0 0; font-size:12px; color:var(--ink2,#4a5a61);" +
      "display:flex; align-items:center; gap:6px; line-height:1.5;}" +
      "#teiyomiA2hsBanner .teiyomi-a2hs-icon{flex:0 0 auto; color:var(--accent,#0e7c66);}" +
      "#teiyomiA2hsBanner .teiyomi-a2hs-install{margin-top:9px; font:inherit; font-size:13px; font-weight:600;" +
      "color:#fff; background:var(--accent,#0e7c66); border:none; border-radius:9px; padding:9px 14px;" +
      "cursor:pointer; -webkit-tap-highlight-color:transparent;}";
    document.head.appendChild(style);
  }

  var SHARE_ICON_SVG =
    '<svg class="teiyomi-a2hs-icon" width="16" height="20" viewBox="0 0 20 24" fill="none" ' +
    'xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<path d="M10 1v13" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
    '<path d="M5.5 5.5L10 1l4.5 4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<rect x="2" y="9" width="16" height="14" rx="2.5" stroke="currentColor" stroke-width="1.6"/>' +
    "</svg>";

  function bannerBodyHtml() {
    var intro =
      "ホーム画面に追加すると、次から一発で開けます。今後、更新のお知らせも受け取れるようになる予定です。";
    if (isIOS()) {
      return (
        '<p class="teiyomi-a2hs-text">' + intro + "</p>" +
        '<p class="teiyomi-a2hs-steps">' + SHARE_ICON_SVG + " 共有ボタンをタップ →「ホーム画面に追加」</p>"
      );
    }
    if (deferredInstallPrompt) {
      return (
        '<p class="teiyomi-a2hs-text">' + intro + "</p>" +
        '<button type="button" class="teiyomi-a2hs-install">ホーム画面に追加</button>'
      );
    }
    return (
      '<p class="teiyomi-a2hs-text">' + intro + "</p>" +
      '<p class="teiyomi-a2hs-steps">ブラウザメニュー(⋮)の「ホーム画面に追加」または「アプリをインストール」から追加できます。</p>'
    );
  }

  function showA2HSBanner() {
    if (document.getElementById("teiyomiA2hsBanner")) return; // 二重表示を防ぐ
    ensureBannerStyle();
    var el = document.createElement("div");
    el.id = "teiyomiA2hsBanner";
    el.setAttribute("role", "region");
    el.setAttribute("aria-label", "ホーム画面への追加案内");
    el.innerHTML =
      '<div class="teiyomi-a2hs-inner">' +
      '<button type="button" class="teiyomi-a2hs-close" aria-label="閉じる">×</button>' +
      bannerBodyHtml() +
      "</div>";
    document.body.appendChild(el);

    el.querySelector(".teiyomi-a2hs-close").addEventListener("click", function () {
      el.remove();
    });

    var installBtn = el.querySelector(".teiyomi-a2hs-install");
    if (installBtn) {
      installBtn.addEventListener("click", function () {
        if (!deferredInstallPrompt) return;
        deferredInstallPrompt.prompt();
        deferredInstallPrompt.userChoice.then(function () {
          deferredInstallPrompt = null;
        });
        el.remove();
      });
    }
  }

  initCloudSync();   // ページ読み込み時にバックグラウンドで開始(失敗しても致命的にしない)
})();
