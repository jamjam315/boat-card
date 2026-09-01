// 「読み採点」の記録を端末内(localStorage)で管理する共通ロジック。
// レースページ(race/…)とマイページの両方から読み込む。
//
// 【この段階(P1-1)でやること・やらないこと】
// やる    … 締切前に買い目を記録する / 一覧する / 消す
// やらない… 的中判定・回収率・採点(P1-3)、サーバー同期、書き出し
//
// 【サーバーには送らない】
// 買い目と金額は、その人がいくら賭けたかという極めて私的な記録になる。
// この段階では端末の外へ出さない。お気に入りのようなクラウド同期も付けない
// (付けるならデータセーフティの申告から見直す必要がある)。
//
// 【スナップショットを持つ理由 — この機能の芯】
// 記録した時点の data.js のレース要素を、まるごとそのまま保存する。
// 採点する日に事実を組み立て直さない。番組表は訂正されることがあり、
// 選手の当地成績や今節の流れは毎日動くので、後から引き直すと
// 「その人が見て判断した数字」ではなくなる。
// 「+15: 1号艇を軸(当地の逃げ率61%)」と言えるのは、その61%を
// 本人が見ていた時のものとして保存してあるからで、そこが崩れると企画が崩れる。
//
// 【localStorageが使えない環境】
// プライベートモード等で読み書きが例外になる。favorites.js と同じく
// 読み書きは必ず try/catch で囲み、失敗しても画面は壊さない
// (記録が次回に残らないだけにする)。
//
// 【Play版(TWA)とWeb版】
// TWAはWebViewではなく端末のChrome本体でページを動かすため、
// teiyomi.com というオリジンの localStorage はブラウザと共有される。
// アプリで記録したものは、同じ端末のChromeで開いても見える。
// (端末をまたぐ引き継ぎは無い。それはサーバー同期の話で、ここでは扱わない。)
(function () {
  "use strict";

  var KEY = "teiyomi_yomi_records";
  var MAX_RECORDS = 500;      // 端末の保存領域を食い潰さないための上限
  var MAX_TAG_LEN = 20;       // 出所タグの長さ
  var MAX_AMOUNT = 1000000;   // 金額の上限(入力ミスでとんでもない額が残らないように)

  // 券種ごとの「艇番を何個選ぶか」と「順番に意味があるか」。
  // 買い目の形を検算するのに使う。表示順もこの順。
  var KEN = [
    { id: "単勝",   n: 1, ordered: false, label: "単勝" },
    { id: "複勝",   n: 1, ordered: false, label: "複勝" },
    { id: "2連単",  n: 2, ordered: true,  label: "2連単" },
    { id: "2連複",  n: 2, ordered: false, label: "2連複" },
    { id: "拡連複", n: 2, ordered: false, label: "拡連複" },
    { id: "3連単",  n: 3, ordered: true,  label: "3連単" },
    { id: "3連複",  n: 3, ordered: false, label: "3連複" }
  ];
  var KEN_BY_ID = {};
  KEN.forEach(function (k) { KEN_BY_ID[k.id] = k; });

  // ---------------------------------------------------------------- 形の検算

  /** "2026-08-31:児島:7" の形か。結果データの重複排除キーと同じ規約。 */
  function isKey(s) {
    return typeof s === "string" && /^\d{4}-\d{2}-\d{2}:[^:]+:([1-9]|1[0-2])$/.test(s);
  }

  function isLane(n) {
    return typeof n === "number" && n >= 1 && n <= 6 && n === Math.floor(n);
  }

  /**
   * 買い目が券種の形に合っているか。
   * 順番に意味がある券種(2連単・3連単)は並び順まで含めて1点、
   * 意味が無い券種は集合として扱う。どちらも同じ艇番の重複は認めない。
   */
  function isBet(ken, lanes) {
    var spec = KEN_BY_ID[ken];
    if (!spec || !Array.isArray(lanes) || lanes.length !== spec.n) return false;
    if (!lanes.every(isLane)) return false;
    var seen = {};
    for (var i = 0; i < lanes.length; i++) {
      if (seen[lanes[i]]) return false;
      seen[lanes[i]] = true;
    }
    return true;
  }

  /** 保存されている1件が読める形か。1つでも欠けていたら無かったことにする。 */
  function isRecord(r) {
    return !!r && typeof r === "object" &&
      isKey(r.key) &&
      typeof r.ken === "string" && KEN_BY_ID[r.ken] &&
      isBet(r.ken, r.lanes) &&
      typeof r.amount === "number" && r.amount > 0 && r.amount <= MAX_AMOUNT &&
      typeof r.at === "string" &&
      typeof r.id === "string";
  }

  // ---------------------------------------------------------------- 読み書き

  function readAll() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      // 端末の保存領域は外から書き換えられうるので、読むたびに形を確かめる。
      // おかしな値は無かったことにする(黙って落とす)。favorites.js と同じ流儀。
      return Array.isArray(arr) ? arr.filter(isRecord) : [];
    } catch (e) {
      return [];
    }
  }

  function writeAll(arr) {
    try {
      localStorage.setItem(KEY, JSON.stringify(arr));
      return true;
    } catch (e) {
      // 保存できない環境(プライベートモード・容量超過)では記録が次回に
      // 残らないだけにし、それ以外の動作は妨げない。
      // ただし「保存したつもりで消えていた」は困るので、呼び出し側が
      // 気づけるように false を返す。
      return false;
    }
  }

  function newId() {
    // 一意であればよく、推測されにくさは要らない(端末内だけの識別子)。
    return String(Date.now()) + "-" + Math.random().toString(36).slice(2, 8);
  }

  // ---------------------------------------------------------------- 締切

  /**
   * 締切を過ぎているか。data.js の締切予定("HH:MM")と、その開催日で判定する。
   *
   * 端末の時計を信じる。ここは不正防止の仕組みではなく、
   * 「結果を見てから記録しても意味がない」ことを本人に伝えるためのもの。
   * 時計を狂わせてまで自分の採点を良く見せたい人を止める必要はない。
   *
   * 締切予定が取れないレースは、判定しようがないので記録を許す
   * (弾いて記録できなくするより、記録できるほうがましと考える)。
   */
  function isClosed(dateIso, deadline, now) {
    if (!deadline || !/^\d{1,2}:\d{2}$/.test(deadline)) return false;
    var parts = deadline.split(":");
    var d = new Date(dateIso + "T00:00:00");
    if (isNaN(d.getTime())) return false;
    d.setHours(Number(parts[0]), Number(parts[1]), 0, 0);
    return (now || new Date()).getTime() > d.getTime();
  }

  // ---------------------------------------------------------------- 公開API

  window.TeiyomiYomi = {
    KEN: KEN,
    MAX_TAG_LEN: MAX_TAG_LEN,
    MAX_AMOUNT: MAX_AMOUNT,

    /** 新しい順に全件。 */
    list: function () {
      return readAll().sort(function (a, b) { return a.at < b.at ? 1 : a.at > b.at ? -1 : 0; });
    },

    /** 1レース分だけ。同じレースに複数の買い目を記録できる(出所タグ違い等)。 */
    listByRace: function (key) {
      return readAll().filter(function (r) { return r.key === key; });
    },

    count: function () {
      return readAll().length;
    },

    /** これまでに使った出所タグを、よく使う順に返す(入力候補にする)。 */
    tags: function () {
      var c = {};
      readAll().forEach(function (r) {
        if (r.tag) c[r.tag] = (c[r.tag] || 0) + 1;
      });
      return Object.keys(c).sort(function (a, b) { return c[b] - c[a]; });
    },

    isClosed: isClosed,
    isBet: isBet,

    /**
     * 1件記録する。
     * 返り値: {ok:true, record} / {ok:false, reason}
     *   reason: "bad_key" | "bad_bet" | "bad_amount" | "closed" | "too_many" | "storage"
     *
     * snapshot は記録した時点の data.js のレース要素そのもの。
     * ここで加工・間引きをしない(あとから「何が見えていたか」を復元するため)。
     */
    add: function (opt) {
      opt = opt || {};
      if (!isKey(opt.key)) return { ok: false, reason: "bad_key" };
      if (!isBet(opt.ken, opt.lanes)) return { ok: false, reason: "bad_bet" };

      var amount = Number(opt.amount);
      if (!isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) {
        return { ok: false, reason: "bad_amount" };
      }
      amount = Math.floor(amount);

      var dateIso = opt.key.split(":")[0];
      if (isClosed(dateIso, opt.deadline)) return { ok: false, reason: "closed" };

      var all = readAll();
      if (all.length >= MAX_RECORDS) return { ok: false, reason: "too_many" };

      var rec = {
        id: newId(),
        key: opt.key,
        at: new Date().toISOString(),
        ken: opt.ken,
        lanes: opt.lanes.slice(),
        tag: String(opt.tag || "").slice(0, MAX_TAG_LEN),
        amount: amount,
        // 採点はP1-3で入れる。器だけ先に用意しておく
        // (あとから列を足すより、最初から空で持っておくほうが読み書きが素直)。
        score: null,
        snapshot: opt.snapshot || null
      };
      all.push(rec);
      if (!writeAll(all)) return { ok: false, reason: "storage" };
      return { ok: true, record: rec };
    },

    /** 1件消す。消せたら true。 */
    remove: function (id) {
      var all = readAll();
      var next = all.filter(function (r) { return r.id !== id; });
      if (next.length === all.length) return false;
      return writeAll(next);
    },

    /** 買い目を "1-2-3"(順番あり) / "1=2"(順番なし) の形にする。 */
    betText: function (ken, lanes) {
      var spec = KEN_BY_ID[ken];
      if (!spec) return "";
      if (spec.ordered) return lanes.join("-");
      return lanes.slice().sort().join("=");
    }
  };
})();
