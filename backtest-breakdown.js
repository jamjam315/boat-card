// バックテスト(条件指定・backtest-custom.html)の「年ごとの内訳」と「最長の連敗」(2026-10-20)。
//
// 【何を数えるか】検証の本体(runBacktest / runPlayerBacktest)が1レースずつ決めた
// 「賭け金・払戻・的中したか」を、そのまま受け取って並べ直すだけ。ここで的中を決め直さない。
// 本体と同じ値を足しているので、年ごとの対象数・賭け金・払戻を足すと、全体の数字に一致する。
//
// 【時系列の並べ方】日付 → レース番号 → 会場コード の順。
// データには締切の時刻が無いので、同じ日の中はレース番号の順で代える(全国のときは、
// 同じレース番号の中を会場コードの順に並べる)。番号と会場は m(しぼり込み用のビット詰め、
// build_backtest_custom.py の pack_meta)から取る: bit 0-3 がレース番号、bit 16-20 が会場。
//
// 【見せ方】数字だけを並べる。評価の言葉や色分けは付けない。対象数の少ない年も隠さない。
(function () {
  "use strict";

  var DAY_MS = 86400000;

  /** "2023-05-12" → 1970-01-01 からの日数。 */
  function dayIndex(d) {
    return Math.round(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))) / DAY_MS);
  }
  /** 日数 → "2023/05/12"。 */
  function slashDate(i) {
    var d = new Date(i * DAY_MS);
    var m = d.getUTCMonth() + 1, day = d.getUTCDate();
    return d.getUTCFullYear() + "/" + (m < 10 ? "0" : "") + m + "/" + (day < 10 ? "0" : "") + day;
  }
  /** "2026-10-19" → "10/19"。 */
  function md(d) { return Number(d.slice(5, 7)) + "/" + Number(d.slice(8, 10)); }

  /** 同じ日の中での順番。レース番号(1〜12)が先、会場コード(0〜31)が後。 */
  function orderInDay(m) { return (m & 0xF) * 32 + ((m >>> 16) & 0x1F); }

  /** その年の見出し。窓が年の途中で始まる・終わるときは範囲を書く。 */
  function yearLabel(y, from, to) {
    var start = y + "-01-01", end = y + "-12-31";
    var a = from > start ? from : start;
    var b = to < end ? to : end;
    if (a === start && b === end) return y + "年";
    if (a === start) return y + "年（" + md(b) + "まで）";
    if (b === end) return y + "年（" + md(a) + "から）";
    return y + "年（" + md(a) + "〜" + md(b) + "）";
  }

  function create() {
    var years = Object.create(null);
    // 連敗を数えるための並び。1レースを1つの数にする:
    //   (日数 × 1024 + 同じ日の中での順番) × 2 + 的中(1)/外れ(0)
    // 数の大小がそのまま時系列になるので、型付き配列の並べ替え1回で済む(全国10年で約55万件)。
    var keys = [];

    return {
      /** 1レースぶん。d は "YYYY-MM-DD"、m はビット詰め、stake/payout は円、hit は的中したか。 */
      add: function (d, m, stake, payout, hit) {
        var y = d.slice(0, 4);
        var t = years[y] || (years[y] = { races: 0, hits: 0, stake: 0, payout: 0 });
        t.races++;
        if (hit) t.hits++;
        t.stake += stake;
        t.payout += payout;
        keys.push((dayIndex(d) * 1024 + orderInDay(m)) * 2 + (hit ? 1 : 0));
      },

      /**
       * まとめる。win は集計した窓 {from, to}(データの実在範囲に丸めたもの・見出しの範囲に使う)。
       * showYears が false なら年の表は作らない(短い期間)。
       * 返り値:
       *   years  … null(表を出さない)か、窓が重なる年ごとの行(窓の最初の年〜最後の年)。
       *            行は期間だけで決める。対象0の年も行を出す(隠さない)。データ次第で表が
       *            出たり出なかったりすると、同じ期間でも見え方が変わって読みにくいため
       *   streak … {n, from, to}。外れが一度も無ければ n=0・from/to は null
       */
      result: function (win, showYears) {
        var rows = null;
        if (showYears) {
          var first = Number(win.from.slice(0, 4)), last = Number(win.to.slice(0, 4));
          if (last > first) {
            rows = [];
            for (var y = first; y <= last; y++) {
              var t = years[String(y)] || { races: 0, hits: 0, stake: 0, payout: 0 };
              rows.push({
                year: y, label: yearLabel(String(y), win.from, win.to),
                races: t.races, hits: t.hits, stake: t.stake, payout: t.payout,
                hitRate: t.races ? t.hits / t.races : null,
                returnRate: t.stake ? t.payout / t.stake : null
              });
            }
          }
        }

        var arr = Float64Array.from(keys).sort();
        var cur = 0, curFrom = 0, best = 0, bestFrom = 0, bestTo = 0;
        for (var i = 0; i < arr.length; i++) {
          var k = arr[i];
          var day = Math.floor(k / 2048);
          if (k % 2 === 1) { cur = 0; continue; }
          if (cur === 0) curFrom = day;
          cur++;
          // 同じ長さが2回あれば、先に起きたほうを出す(> で比べる)
          if (cur > best) { best = cur; bestFrom = curFrom; bestTo = day; }
        }
        return {
          years: rows,
          streak: best ? { n: best, from: slashDate(bestFrom), to: slashDate(bestTo) } : { n: 0, from: null, to: null }
        };
      }
    };
  }

  /** 「最長の連敗」の1行。同じ日に収まるときは日付を1つだけ書く。 */
  function streakText(s) {
    if (!s || !s.n) return "最長の連敗　0レース";
    return "最長の連敗　" + s.n.toLocaleString("ja-JP") + "レース（" + s.from + (s.to !== s.from ? "〜" + s.to : "") + "）";
  }

  window.TeiyomiBtBreakdown = {
    create: create, streakText: streakText,
    yearLabel: yearLabel, orderInDay: orderInDay
  };
})();
