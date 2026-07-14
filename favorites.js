// お気に入り選手(登番)の登録状態をlocalStorageで管理する共通ロジック。
// 選手個別ページ(players/{登番}.html)と選手一覧ページ(players/index.html)の
// 両方から読み込む(ページはそれぞれ自己完結のまま、このファイルだけ共有する)。
// サーバー通信・アカウントは一切なし。localStorageが使えない環境でも
// ページ自体が壊れないよう、読み書きは必ずtry/catchで囲む。
(function () {
  var KEY = "teiyomi_favorites_players";

  function readAll() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.map(String) : [];
    } catch (e) {
      return [];
    }
  }

  function writeAll(arr) {
    try {
      localStorage.setItem(KEY, JSON.stringify(arr));
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
      if (idx === -1) arr.push(toban);
      else arr.splice(idx, 1);
      writeAll(arr);
      return idx === -1; // 追加後ならtrue、削除後ならfalse
    }
  };
})();
