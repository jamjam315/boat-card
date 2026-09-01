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
  // スナップショットはレース単位で1つだけ持つ。1レース分が約2.2KBあり、
  // 同じレースに何点も買う人(3連単のフォーメーション等)が記録ごとに抱えると、
  // 中身が全く同じものを何十個も置くことになる。
  var SNAP_KEY = "teiyomi_yomi_snapshots";
  var MAX_RECORDS = 500;      // 端末の保存領域を食い潰さないための上限
  // 1レース×1出所タグあたりの上限。同じ読み(出所)で何十点も流すと、
  // 「その読みが当たったか」ではなく「手広く買ったか」の記録になってしまう。
  var MAX_PER_RACE_TAG = 30;
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

  // ---- スナップショット(レース単位で1つ) ----

  function readSnaps() {
    try {
      var raw = localStorage.getItem(SNAP_KEY);
      if (!raw) return {};
      var o = JSON.parse(raw);
      return (o && typeof o === "object" && !Array.isArray(o)) ? o : {};
    } catch (e) {
      return {};
    }
  }

  function writeSnaps(o) {
    try {
      localStorage.setItem(SNAP_KEY, JSON.stringify(o));
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * 記録ごとに抱えていたスナップショットを、レース単位の置き場へ寄せる。
   *
   * P1-1では1件ごとに data.js のレース要素(約2.2KB)を持たせていた。同じレースに
   * 複数記録すると同じ中身が何個も並ぶので、レースキーで1つに畳む。
   * 中身は変えない(「本人が見ていた数字」をそのまま残す、という芯は動かさない)。
   * 同じレースに違うスナップショットが来ることは無い(同じ日の同じレースの
   * data.js要素なので)が、万一来ても先に入っているほうを残す。
   */
  function migrateSnapshots() {
    var all;
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return;
      all = JSON.parse(raw);
    } catch (e) {
      return;
    }
    if (!Array.isArray(all)) return;
    var snaps = readSnaps();
    var moved = 0;
    all.forEach(function (r) {
      if (!r || !r.snapshot) return;
      if (r.key && !snaps[r.key]) snaps[r.key] = r.snapshot;
      delete r.snapshot;
      moved++;
    });
    if (!moved) return;
    if (writeSnaps(snaps)) writeAll(all);
  }

  function newId() {
    // 一意であればよく、推測されにくさは要らない(端末内だけの識別子)。
    return String(Date.now()) + "-" + Math.random().toString(36).slice(2, 8);
  }

  // ---------------------------------------------------------------- 締切

  /**
   * 締切を過ぎているか。data.js の締切予定("HH:MM")と、その開催日で判定する。
   *
   * 【JSTで判定する理由】
   * 締切予定は日本の競走の時刻なので、常に日本時間で読む。端末のタイムゾーン
   * (new Date(...).setHours 等が使うローカル時刻)で判定すると、端末を海外時間に
   * していたり旅行中だったりするだけで判定がずれる。UTCの端末なら9時間ぶん
   * 早く「締切後」になり、記録できるはずのレースが記録できなくなる。
   *
   * 日本は1951年以降サマータイムが無いので、JSTは年間を通して UTC+9 で固定。
   * Date.UTC で「その日のJSTの締切時刻」を世界共通の時刻に直し、
   * 端末のタイムゾーンに一切依存しない形で今と比べる。
   *
   * 時計そのものは端末のものを信じる。ここは不正防止の仕組みではなく、
   * 「結果を見てから記録しても意味がない」ことを本人に伝えるためのもの。
   * 時計を狂わせてまで自分の採点を良く見せたい人を止める必要はない。
   *
   * 締切予定が取れないレースは、判定しようがないので記録を許す
   * (弾いて記録できなくするより、記録できるほうがましと考える)。
   */
  var JST_OFFSET_HOURS = 9;

  function isClosed(dateIso, deadline, nowMs) {
    if (!deadline || !/^\d{1,2}:\d{2}$/.test(deadline)) return false;
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateIso));
    if (!m) return false;
    var hm = deadline.split(":");
    var closeMs = Date.UTC(
      Number(m[1]), Number(m[2]) - 1, Number(m[3]),
      Number(hm[0]) - JST_OFFSET_HOURS, Number(hm[1]), 0, 0
    );
    if (isNaN(closeMs)) return false;
    var now = (typeof nowMs === "number") ? nowMs : Date.now();
    return now > closeMs;
  }

  // ---------------------------------------------------------------- 採点

  // 結果点の配点(30点満点)。読み点(70点)はPhase2で足す。
  var PT_HIT = 20;                              // 当たったこと自体
  var PT_ROI = [[500, 10], [200, 8], [100, 5]]; // 回収率(%)がこれ以上なら、この点
  var MAX_RESULT_PT = 30;

  /**
   * 買い目が当たったか。払戻側の「当たった組」と突き合わせる。
   *
   * 着順から自分で組み立てて判定しない。同着・失格・返還といった扱いは
   * 公式の払戻がすでに答えを出しているので、そちらに従うほうが忠実で、
   * こちらで例外を数え落とす余地も無くなる。
   *
   * 組の表記は券種で違うが、突き合わせ方は3通りしかない:
   *   1艇(単勝・複勝)   … "3"      → 買った艇と一致するか
   *   順番あり(2連単等) … "3-2"    → 押した順のまま一致するか
   *   順番なし(2連複等) … "2-3"    → 並べ替えて一致するか
   * どの券種も「払戻の行のどれかに一致すれば当たり」で統一できる
   * (複勝は2行、拡連複は3行あるため)。
   */
  function matchPay(ken, lanes, rows) {
    var s = KEN_BY_ID[ken];
    if (!s || !Array.isArray(rows)) return null;
    var mine = s.n === 1 ? String(lanes[0])
      : s.ordered ? lanes.join("-")
        : lanes.slice().sort().join("-");
    for (var i = 0; i < rows.length; i++) {
      var c = String(rows[i] && rows[i].c || "");
      var theirs = s.n === 1 ? c
        : s.ordered ? c
          : c.split("-").map(Number).sort().join("-");
      if (theirs === mine) return rows[i];
    }
    return null;
  }

  /** 着順の配列(艇番順)から、1〜3着の艇番を取り出す。 */
  function top3(order) {
    var out = [];
    for (var pos = 1; pos <= 3; pos++) {
      for (var i = 0; i < (order || []).length; i++) {
        if (order[i] === pos) { out.push(i + 1); break; }
      }
    }
    return out;
  }

  function resultPoints(hit, roi) {
    if (!hit) return 0;
    var pt = PT_HIT;
    for (var i = 0; i < PT_ROI.length; i++) {
      if (roi >= PT_ROI[i][0]) { pt += PT_ROI[i][1]; break; }
    }
    return Math.min(pt, MAX_RESULT_PT);
  }

  /**
   * 1件を採点する。payouts の該当レースを渡す。
   * race が無い(その日のファイルに載っていない)場合は null を返し、採点しない。
   */
  function scoreOne(rec, race) {
    if (!race) return null;
    if (race.status) {
      // 中止・返還。当たりでも外れでもないので、点も付けず集計からも外す。
      return { at: new Date().toISOString(), st: "void", pt: null };
    }
    var row = matchPay(rec.ken, rec.lanes, (race.pay || {})[rec.ken]);
    var unit = rec.amount / 100;              // 払戻は100円あたりの金額
    var yen = row ? Math.round(row.y * unit) : 0;
    var roi = rec.amount > 0 ? Math.round(yen / rec.amount * 1000) / 10 : 0;
    return {
      at: new Date().toISOString(),
      st: row ? "hit" : "miss",
      top3: top3(race.order),
      kimarite: race.kimarite || null,
      yen: yen,
      profit: yen - rec.amount,
      roi: roi,
      pop: row && row.p != null ? row.p : null,
      pt: resultPoints(!!row, roi)
    };
  }

  /** 今日(JST)の日付。集計の窓を切るのに使う。端末のTZに依存させない。 */
  function todayJst() {
    return new Date(Date.now() + JST_OFFSET_HOURS * 3600000).toISOString().slice(0, 10);
  }

  // ---------------------------------------------------------------- 公開API

  // 記録ごとに抱えていたスナップショットを、レース単位の置き場へ寄せる。
  // 公開APIを組み立てる前に済ませ、以後は新しい形だけを相手にする。
  migrateSnapshots();

  window.TeiyomiYomi = {
    KEN: KEN,
    MAX_TAG_LEN: MAX_TAG_LEN,
    MAX_AMOUNT: MAX_AMOUNT,
    MAX_PER_RACE_TAG: MAX_PER_RACE_TAG,

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

      var tag = String(opt.tag || "").slice(0, MAX_TAG_LEN);
      var sameTag = all.filter(function (r) {
        return r.key === opt.key && (r.tag || "") === tag;
      }).length;
      if (sameTag >= MAX_PER_RACE_TAG) return { ok: false, reason: "too_many_here" };

      var rec = {
        id: newId(),
        key: opt.key,
        at: new Date().toISOString(),
        ken: opt.ken,
        lanes: opt.lanes.slice(),
        tag: tag,
        amount: amount,
        // 採点はP1-3で入れる。器だけ先に用意しておく
        // (あとから列を足すより、最初から空で持っておくほうが読み書きが素直)。
        score: null
      };

      // スナップショットはレース単位で1つ。2件目以降は保存し直さない
      // (同じレースなら中身も同じで、記録ごとに持つと約2.2KBずつ無駄に増える)。
      if (opt.snapshot) {
        var snaps = readSnaps();
        if (!snaps[opt.key]) {
          snaps[opt.key] = opt.snapshot;
          if (!writeSnaps(snaps)) return { ok: false, reason: "storage" };
        }
      }

      all.push(rec);
      if (!writeAll(all)) return { ok: false, reason: "storage" };
      return { ok: true, record: rec };
    },

    /** そのレースのスナップショット(記録時点の data.js のレース要素)。 */
    snapshot: function (key) {
      return readSnaps()[key] || null;
    },

    /** そのレースの記録数を、出所タグごとに数える。 */
    countByTag: function (key) {
      var c = {};
      readAll().forEach(function (r) {
        if (r.key !== key) return;
        var t = r.tag || "";
        c[t] = (c[t] || 0) + 1;
      });
      return c;
    },

    /** 1件消す。消せたら true。 */
    remove: function (id) {
      var all = readAll();
      var gone = null;
      var next = all.filter(function (r) {
        if (r.id === id) { gone = r; return false; }
        return true;
      });
      if (!gone) return false;
      if (!writeAll(next)) return false;
      // そのレースの記録が全部消えたら、スナップショットも一緒に片付ける。
      // 参照する記録が無いのに約2.2KBが残り続けるのを防ぐ。
      var stillUsed = next.some(function (r) { return r.key === gone.key; });
      if (!stillUsed) {
        var snaps = readSnaps();
        if (snaps[gone.key]) { delete snaps[gone.key]; writeSnaps(snaps); }
      }
      return true;
    },

    MAX_RESULT_PT: MAX_RESULT_PT,
    todayJst: todayJst,
    scoreOne: scoreOne,
    matchPay: matchPay,

    /** まだ採点していない記録の、レース開催日の一覧(古い順・重複なし)。 */
    unscoredDates: function () {
      var seen = {};
      readAll().forEach(function (r) {
        if (!r.score) seen[r.key.split(":")[0]] = true;
      });
      return Object.keys(seen).sort();
    },

    /**
     * その日の結果は手に入らないと諦める。
     *
     * payouts が404で、しかもレース当日でも前日でもない場合に使う。放っておくと
     * マイページを開くたびに同じ404を叩き続け、コンソールにも出続ける。
     * 「取れなかった」という結末も一つの結末なので、記録に書いて先へ進む。
     */
    markNoData: function (dateIso) {
      var all = readAll();
      var n = 0;
      all.forEach(function (r) {
        if (r.score || r.key.split(":")[0] !== dateIso) return;
        r.score = { at: new Date().toISOString(), st: "nodata", pt: null };
        n++;
      });
      if (n) writeAll(all);
      return n;
    },

    /**
     * その日の payouts を渡して、その日の記録をまとめて採点し、書き戻す。
     * 採点した件数を返す。一度採点したら二度と取りに行かない
     * (結果は変わらないので、毎回ネットワークに出る意味が無い)。
     */
    applyPayouts: function (dateIso, doc) {
      var races = (doc && doc.races) || {};
      var all = readAll();
      var n = 0;
      all.forEach(function (r) {
        if (r.score) return;
        if (r.key.split(":")[0] !== dateIso) return;
        var s = scoreOne(r, races[r.key]);
        if (s) { r.score = s; n++; }
      });
      if (n) writeAll(all);
      return n;
    },

    /**
     * 直近days日(レース開催日で数える)の集計。
     * 返り値: {all, byTag:{}, byKen:{}} で、それぞれ
     *   {n, hit, miss, void, bet, yen, profit, roi, hitRate, pt}
     * 不成立(void)は件数だけ数え、的中率・回収率の分母には入れない。
     */
    summary: function (days) {
      days = days || 30;
      var since = new Date(Date.parse(todayJst() + "T00:00:00Z") - (days - 1) * 86400000)
        .toISOString().slice(0, 10);
      function blank() {
        return { n: 0, hit: 0, miss: 0, "void": 0, pending: 0, bet: 0, yen: 0, pt: 0, ptn: 0 };
      }
      function fin(a) {
        var judged = a.hit + a.miss;
        a.profit = a.yen - a.bet;
        a.roi = a.bet > 0 ? Math.round(a.yen / a.bet * 1000) / 10 : null;
        a.hitRate = judged > 0 ? Math.round(a.hit / judged * 1000) / 10 : null;
        a.avgPt = a.ptn > 0 ? Math.round(a.pt / a.ptn * 10) / 10 : null;
        return a;
      }
      var out = { all: blank(), byTag: {}, byKen: {}, since: since, days: days };
      readAll().forEach(function (r) {
        if (r.key.split(":")[0] < since) return;      // 窓の外は集計しない
        var s = r.score;
        var tag = r.tag || "（タグなし）";
        // 記録した数はそのまま数える。採点がまだのものを件数から落とすと、
        // 今日記録したばかりの人に「記録0件」と見えて壊れて見える。
        // 率と金額の勘定にだけ入れない。
        [out.all,
         out.byTag[tag] || (out.byTag[tag] = blank()),
         out.byKen[r.ken] || (out.byKen[r.ken] = blank())].forEach(function (a) {
          a.n++;
          // 採点待ちと「結果が取れなかった」は、率にも金額にも入れない。
          if (!s || s.st === "nodata") { a.pending++; return; }
          if (s.st === "void") { a["void"]++; return; }
          if (s.st === "hit") a.hit++; else a.miss++;
          a.bet += r.amount;
          a.yen += s.yen;
          a.pt += s.pt;
          a.ptn++;
        });
      });
      fin(out.all);
      Object.keys(out.byTag).forEach(function (k) { fin(out.byTag[k]); });
      Object.keys(out.byKen).forEach(function (k) { fin(out.byKen[k]); });
      return out;
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
