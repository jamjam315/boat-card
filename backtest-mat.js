// バックテスト(条件指定・backtest-custom.html)の「艇の材料」(2026-10-20)。
//
// 【何をするか】材料ファイル(backtest-data/mat/、build_bt_materials.py が作る)を読み解いて、
//   (a) しぼり込み … 「1号艇の級別が A1」のような条件にそのレースが当てはまるか
//   (b) 買う艇・軸 … 「全国勝率がいちばん高い艇」など、材料で決まる艇はどれか
// を答える。帯の表と帯の判定は rule-match.js(MATS・inMatBands)を使う(条件アラートと同じ判定)。
//
// 【材料ファイルの1行】[鍵, 1号艇, …, 6号艇]
//   鍵 = 日 × 10000 + 会場コード × 100 + レース番号
//   艇 = 級別 + 8 × (全国勝率×100 + 1024 × (モーター2連率×100 + 16384 × (平均ST×10000 + 16384 × 直近平均着×100)))
//   (詰め方の説明は build_bt_materials.py。51ビットなので、ビット演算ではなく割り算で取り出す)
//
// 【値が分からない艇】番組表に無い・記録がまだ無い(勝率0.00)・走りが足りない艇は null。
// null はどの帯にも入らず、いちばん高い/速い艇を選ぶときにも数えない(読み採点と同じ扱い)。
(function (root) {
  "use strict";

  var K = ["A1", "A2", "B1", "B2"];
  var PICKS = [
    { key: "nw", label: "全国勝率がいちばん高い艇", high: true },
    { key: "st", label: "平均STがいちばん速い艇", high: false },
    { key: "fm", label: "直近の平均着がいちばん良い艇", high: false }
  ];

  /** 1艇ぶんの整数を材料に戻す。 */
  function decodeBoat(p) {
    if (typeof p !== "number" || !(p >= 0)) return null;
    var k = p % 8; p = Math.floor(p / 8);
    var nw = p % 1024; p = Math.floor(p / 1024);
    var mo = p % 16384; p = Math.floor(p / 16384);
    var st = p % 16384; p = Math.floor(p / 16384);
    var fm = p;
    return {
      k: k < 4 ? K[k] : null,
      // 0.00 は「まだ記録が無い」。読み採点と同じく分からない扱いにする
      nw: nw === 1023 || nw === 0 ? null : nw / 100,
      mo: mo === 16383 || mo === 0 ? null : mo / 100,
      st: st === 16383 ? null : st / 10000,
      fm: fm === 1023 ? null : fm / 100
    };
  }

  /** そのレースを材料ファイルで引くための鍵。d は "YYYY-MM-DD"、m はしぼり込み用のビット詰め。 */
  function keyOf(d, m) {
    return Number(d.slice(8, 10)) * 10000 + ((m >>> 16) & 0x1F) * 100 + (m & 0xF);
  }

  /**
   * 読み込んだ材料を月ごとに持つ入れ物。row(d, m) でそのレースの行(6艇の整数)を返す。
   * add は足し込む(選手モードでは同じ月の会場のファイルを何本か読むため)。
   */
  function createStore() {
    var months = Object.create(null);
    return {
      add: function (month, rows) {
        var map = months[month] || (months[month] = new Map());
        for (var i = 0; i < rows.length; i++) map.set(rows[i][0], rows[i]);
      },
      has: function (month) { return !!months[month]; },
      row: function (d, m) {
        var map = months[d.slice(0, 7)];
        return map ? map.get(keyOf(d, m)) || null : null;
      }
    };
  }

  /** 行から、その艇番の材料。 */
  function boatOf(row, lane) {
    return row && lane >= 1 && lane <= 6 ? decodeBoat(row[lane]) : null;
  }

  /**
   * (a) しぼり込みの条件をすべて満たすか。
   *   conds    … [{lane: 1〜6 または "self", mat, bands}](rule-match.js normMats の形)
   *   selfLane … 選手モードでの、その選手の艇番(通常モードは null)
   */
  function passMats(row, conds, selfLane) {
    var RM = root.TeiyomiRuleMatch;
    for (var i = 0; i < conds.length; i++) {
      var c = conds[i];
      var lane = c.lane === "self" ? selfLane : c.lane;
      var b = boatOf(row, lane);
      if (!b || !RM.inMatBands(c.mat, b[c.mat], c.bands)) return false;
    }
    return true;
  }

  function pickDef(key) {
    for (var i = 0; i < PICKS.length; i++) if (PICKS[i].key === key) return PICKS[i];
    return null;
  }

  /**
   * (b) 材料で決まる艇の艇番。分からなければ null。
   * 並んだときは艇番の小さいほう(読み採点の軸の決め方と同じ。内側ほど1着率が高く、機械的に決まる)。
   */
  function pickLane(row, by) {
    var d = pickDef(by);
    if (!d || !row) return null;
    var best = null, bestV = null;
    for (var n = 1; n <= 6; n++) {
      var b = decodeBoat(row[n]);
      var v = b ? b[by] : null;
      if (v === null) continue;
      if (bestV === null || (d.high ? v > bestV : v < bestV)) { best = n; bestV = v; }
    }
    return best;
  }

  /** 期間の窓 {from, to} に入る月(YYYY-MM)。 */
  function monthsIn(from, to) {
    var out = [];
    var y = Number(from.slice(0, 4)), m = Number(from.slice(5, 7));
    var ey = Number(to.slice(0, 4)), em = Number(to.slice(5, 7));
    // to は必ずデータの最後の日に丸めて渡す(過去N年の窓の to は 9999-12-31 のため)。念のため上限も置く
    while ((y < ey || (y === ey && m <= em)) && out.length < 600) {
      out.push(y + "-" + (m < 10 ? "0" : "") + m);
      m++; if (m > 12) { m = 1; y++; }
    }
    return out;
  }

  root.TeiyomiBtMat = {
    PICKS: PICKS, pickDef: pickDef,
    decodeBoat: decodeBoat, keyOf: keyOf, createStore: createStore, boatOf: boatOf,
    passMats: passMats, pickLane: pickLane, monthsIn: monthsIn
  };
})(typeof window !== "undefined" ? window : globalThis);
