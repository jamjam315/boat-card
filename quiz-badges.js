// 今日の一問の実績(AI-15)。他人と比べない、自分との勝負の称号。
//
// 【端末の中だけ】計算に使うのは、この端末に貯まった今日の一問の記録だけ。サーバーには何も送らない・置かない。
// 別の端末・ブラウザとアプリの間では引き継がれない(ログインしても同期しない)。
//
// 【通算の記録を別に持つ】(teiyomi_quiz_stats_v1)
// 出題日ごとの記録(teiyomi_quiz_v1)は60日で古いものから消えるので、実績の元にはしない。
// 解いた日ごとに「その日の点のまとめ」を1件だけ残し、こちらは消さない(1日数十バイト・1年で数十KB)。
// まとめはスタートを押した時点の答案から作る(quiz.js の daySummary)。採点の規則があとで変わっても、
// その日の点は変わらない。9/17(今日の一問の始まり)以降に解いた日は、開いたときに一度だけ出題ファイルから作る。
//
// 【数え方】
//   解いた問 … スタートまで進んだ出題日の数(あとから ?d= で解いた日も数える)
//   連続日数 … 出題日の当日(JST)に解いた日が、出題日として続いている数。あとから解いた日は数えない
//             いまの連続は、今日か昨日まで続いている分(今日の分をまだ解いていなくても、今日のうちは切れない)
//   実績は「いつ付いたか」を解いた順(スタートを押した時刻の順)に並べて決める
//
// 【見せ方】煽らない事実の名前。演出はしない(新しく付いたときに答案の下へ1行)。
(function () {
  "use strict";

  var STATS_KEY = "teiyomi_quiz_stats_v1";
  var JST_MS = 9 * 3600000;
  var KENS = ["単勝", "複勝", "2連単", "2連複", "拡連複", "3連単", "3連複"];

  // 実績の一覧(並びは画面の並び)。kind: once = 1回きり / best = 更新型(値と日付)
  var BADGES = [
    { id: "first", name: "はじめての一問", desc: "はじめてスタートまで進んだ", kind: "once" },
    { id: "streak3", name: "3日つづけて", desc: "出題日の当日に、3日続けて解いた", kind: "once", streak: 3 },
    { id: "streak7", name: "7日つづけて", desc: "出題日の当日に、7日続けて解いた", kind: "once", streak: 7 },
    { id: "streak30", name: "30日つづけて", desc: "出題日の当日に、30日続けて解いた", kind: "once", streak: 30 },
    { id: "count10", name: "10問", desc: "解いた問が10問になった", kind: "once", count: 10 },
    { id: "count30", name: "30問", desc: "解いた問が30問になった", kind: "once", count: 30 },
    { id: "count100", name: "100問", desc: "解いた問が100問になった", kind: "once", count: 100 },
    { id: "yomi40", name: "読み点40", desc: "1問で読み点が40点以上", kind: "once", yomi: 40 },
    { id: "yomi50", name: "読み点50", desc: "1問で読み点が50点以上", kind: "once", yomi: 50 },
    { id: "bestAxis", name: "いちばん材料のある艇を軸に", desc: "その問で読み点がいちばん高くなる艇を軸にした", kind: "once", counted: true },
    { id: "yomiBest", name: "読み点の自己ベスト", desc: "これまでの読み点のいちばん高い点", kind: "best", field: "yomi", unit: "点" },
    { id: "hit", name: "はじめての的中", desc: "はじめて的中した", kind: "once" },
    { id: "hit3t", name: "3連単で的中", desc: "3連単で的中した", kind: "once" },
    { id: "kens7", name: "7券種を記録", desc: "7つの券種をどれも1回は記録した", kind: "once" },
    { id: "finBest", name: "持ち点の自己ベスト", desc: "これまでの最後の持ち点のいちばん高い額", kind: "best", field: "fin", unit: "円" }
  ];

  function isDate(s) { return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s); }
  function isNum(x) { return typeof x === "number" && isFinite(x); }
  function jstDate(ms) { return new Date(ms + JST_MS).toISOString().slice(0, 10); }
  function addDays(date, n) { return new Date(Date.parse(date + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10); }

  /** 1日ぶんのまとめを、形を確かめて整える。崩れていれば null(無かったことにする)。 */
  function cleanDay(date, x) {
    if (!isDate(date) || !x || typeof x !== "object") return null;
    var at = typeof x.at === "string" && !isNaN(Date.parse(x.at)) ? x.at : null;
    if (!at) return null;
    return {
      at: at,
      onDay: x.onDay === true,
      yomi: isNum(x.yomi) ? x.yomi : null,
      yomiMax: isNum(x.yomiMax) ? x.yomiMax : null,
      hit: x.hit === true,
      hit3t: x.hit3t === true,
      fin: isNum(x.fin) ? x.fin : null,
      kens: Array.isArray(x.kens) ? x.kens.filter(function (k) { return KENS.indexOf(k) !== -1; }) : [],
      v: typeof x.v === "string" ? x.v : ""
    };
  }

  function read(ls) {
    var out = { v: 1, days: Object.create(null) };
    try {
      var o = JSON.parse(ls.getItem(STATS_KEY) || "null");
      if (o && o.days && typeof o.days === "object" && !Array.isArray(o.days)) {
        Object.keys(o.days).forEach(function (d) {
          var c = cleanDay(d, o.days[d]);
          if (c) out.days[d] = c;
        });
      }
    } catch (e) { /* 壊れていたら無かったことにする */ }
    return out;
  }

  function write(ls, o) {
    try {
      var days = {};
      Object.keys(o.days).sort().forEach(function (d) { days[d] = o.days[d]; });
      ls.setItem(STATS_KEY, JSON.stringify({ v: 1, days: days }));
      return true;
    } catch (e) {
      return false;
    }
  }

  /** 解いた順(スタートを押した時刻の順・同じなら出題日の順)に並べる。 */
  function ordered(stats) {
    return Object.keys(stats.days).map(function (d) {
      var x = stats.days[d];
      return { date: d, at: x.at, x: x };
    }).sort(function (a, b) {
      return a.at < b.at ? -1 : a.at > b.at ? 1 : a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
    });
  }

  /**
   * 実績の計算。stats(通算の記録)と今日(JST)から、数字と実績の一覧を返す。
   *   { solved, streakNow, streakBest, list: [{id, name, desc, kind, earned(日付|null), value?, count?}] }
   */
  function evaluate(stats, today) {
    var rows = ordered(stats);
    var earned = Object.create(null);
    var counts = Object.create(null);
    var bests = Object.create(null);
    var kens = Object.create(null);
    var onDay = Object.create(null);
    var run = 0, runBest = 0, solved = 0;

    function earn(id, day) { if (!earned[id]) earned[id] = jstDate(Date.parse(day.at)); }
    function runEnding(date) {
      var n = 0;
      while (onDay[addDays(date, -n)]) n++;
      return n;
    }

    rows.forEach(function (row) {
      var x = row.x;
      solved++;
      earn("first", row);
      BADGES.forEach(function (b) {
        if (b.count && solved >= b.count) earn(b.id, row);
        if (b.yomi && x.yomi != null && x.yomi >= b.yomi) earn(b.id, row);
      });
      if (x.onDay) {
        onDay[row.date] = true;
        // あとから解いた日で前後がつながることがあるので、その日を含む連続を数え直す
        var n = runEnding(row.date);
        var after = 1;
        while (onDay[addDays(row.date, after)]) { n++; after++; }
        run = n;
        if (run > runBest) runBest = run;
        BADGES.forEach(function (b) { if (b.streak && runBest >= b.streak) earn(b.id, row); });
      }
      if (x.yomi != null && x.yomiMax != null && x.yomiMax > 0 && x.yomi === x.yomiMax) {
        earn("bestAxis", row);
        counts.bestAxis = (counts.bestAxis || 0) + 1;
      }
      if (x.hit) earn("hit", row);
      if (x.hit3t) earn("hit3t", row);
      x.kens.forEach(function (k) { kens[k] = true; });
      if (KENS.every(function (k) { return kens[k]; })) earn("kens7", row);
      BADGES.forEach(function (b) {
        if (b.kind !== "best" || x[b.field] == null) return;
        var cur = bests[b.id];
        if (!cur || x[b.field] > cur.value) bests[b.id] = { value: x[b.field], date: jstDate(Date.parse(row.at)) };
      });
    });

    // いまの連続: 今日か昨日で終わっている連続(今日の分をまだ解いていなくても、今日のうちは切れない)
    var streakNow = onDay[today] ? runEnding(today) : runEnding(addDays(today, -1));

    return {
      solved: solved,
      streakNow: streakNow,
      streakBest: runBest,
      list: BADGES.map(function (b) {
        var o = { id: b.id, name: b.name, desc: b.desc, kind: b.kind, earned: null };
        if (b.kind === "best") {
          if (bests[b.id]) { o.earned = bests[b.id].date; o.value = bests[b.id].value; o.unit = b.unit; }
        } else {
          o.earned = earned[b.id] || null;
          if (b.counted) o.count = counts[b.id] || 0;
        }
        return o;
      })
    };
  }

  /**
   * 前と後の計算を比べて、新しく付いた実績の文を返す(答案の下に1行で出す)。
   * 更新型は、前に値があって、それを上回ったときだけ「更新」と出す(初めての日は数えない)。
   */
  function fresh(before, after) {
    var prev = Object.create(null);
    before.list.forEach(function (b) { prev[b.id] = b; });
    var out = [];
    after.list.forEach(function (b) {
      var p = prev[b.id];
      if (b.kind === "best") {
        if (p && p.value != null && b.value != null && b.value > p.value) {
          out.push(b.name + "を更新（" + b.value.toLocaleString() + b.unit + "）");
        }
      } else if (b.earned && !(p && p.earned)) {
        out.push(b.name);
      }
    });
    return out;
  }

  /** 1日ぶんのまとめを足す(同じ出題日がすでにあれば足さない)。{added, fresh:[...]} を返す。 */
  function addDay(ls, date, summary, today) {
    var stats = read(ls);
    if (stats.days[date]) return { added: false, fresh: [] };
    var c = cleanDay(date, summary);
    if (!c) return { added: false, fresh: [] };
    var before = evaluate(stats, today);
    stats.days[date] = c;
    var after = evaluate(stats, today);
    return { added: write(ls, stats), fresh: fresh(before, after) };
  }

  /** 上部の1行(「解いた問 12・いまの連続 3日（最長 7日）」)。まだ1問も無ければ空。 */
  function statusText(ev) {
    if (!ev.solved) return "";
    return "解いた問 " + ev.solved + "・いまの連続 " + ev.streakNow + "日（最長 " + ev.streakBest + "日）";
  }

  window.TeiyomiQuizBadges = {
    STATS_KEY: STATS_KEY, BADGES: BADGES, KENS: KENS,
    read: read, write: write, evaluate: evaluate, fresh: fresh, addDay: addDay, statusText: statusText,
    jstDate: jstDate
  };
})();
