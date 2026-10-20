// バックテスト(条件指定・backtest-custom.html)の「艇の材料」(2026-10-20)。
//
// 【何をするか】材料ファイル(backtest-data/mat/、build_bt_materials.py が作る)を読み解いて、
//   (a) しぼり込み … 「1号艇の級別が A1」のような条件にそのレースが当てはまるか
//   (b) 買う艇・軸 … 「全国勝率がいちばん高い艇」など、材料で決まる艇はどれか
// を答える。帯の表と帯の判定は rule-match.js(MATS・inMatBands)を使う(条件アラートと同じ判定)。
//
// 【材料ファイルの形】(v=2・列の形。詳しくは build_bt_materials.py)
//   keys … 日 × 10000 + 会場コード × 100 + レース番号。i 番目のレース = keys[i]
//   k    … 1レース1文字列(6文字・艇番順)。0=A1 1=A2 2=B1 3=B2 7=不明
//   nw / mo … 全国勝率×100 / モーター2連率×100。0=不明
//   st / fm … 平均ST×10000 / 直近平均着×100。-1=不明
//   材料の列は「レース × 6艇」を平らに並べたもの: i 番目のレースの n 号艇 = 列[i × 6 + n - 1]
// 全国の月は材料ごとに別のファイル(使う材料だけ読む)、会場の月は1本にまとまっている。
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

  /** そのレースを材料ファイルで引くための鍵。d は "YYYY-MM-DD"、m はしぼり込み用のビット詰め。 */
  function keyOf(d, m) {
    return Number(d.slice(8, 10)) * 10000 + ((m >>> 16) & 0x1F) * 100 + (m & 0xF);
  }

  /**
   * 読み込んだ材料の入れ物。セット(all か会場のローマ字)×月ごとに持つ。
   *   addChunk(set, month, chunk) … chunk = {keys, k?, nw?, mo?, st?, fm?}。全国の月は keys を先に入れ、
   *                                 材料の列はあとから chunk に足してよい(同じものを指しているので)
   *   find(set, d, m)             … そのレースの参照 [chunk, i]。無ければ null
   */
  function createStore() {
    var sets = Object.create(null);
    return {
      addChunk: function (set, month, chunk) {
        var months = sets[set] || (sets[set] = Object.create(null));
        var map = months[month] || (months[month] = new Map());
        for (var i = 0; i < chunk.keys.length; i++) map.set(chunk.keys[i], [chunk, i]);
      },
      has: function (set, month) { return !!(sets[set] && sets[set][month]); },
      find: function (set, d, m) {
        var months = sets[set];
        var map = months && months[d.slice(0, 7)];
        return (map && map.get(keyOf(d, m))) || null;
      }
    };
  }

  /** 参照 ref の n 号艇の材料 field の値。分からない(・列をまだ読んでいない)なら null。 */
  function value(ref, lane, field) {
    if (!ref || !(lane >= 1 && lane <= 6)) return null;
    var c = ref[0], i = ref[1];
    if (field === "k") {
      var s = c.k && c.k[i];
      var d = s ? s.charCodeAt(lane - 1) - 48 : 7;
      return d >= 0 && d < 4 ? K[d] : null;
    }
    var col = c[field];
    if (!col) return null;
    var v = col[i * 6 + lane - 1];
    if (typeof v !== "number") return null;
    if (field === "nw" || field === "mo") return v > 0 ? v / 100 : null;
    if (field === "st") return v >= 0 ? v / 10000 : null;
    if (field === "fm") return v >= 0 ? v / 100 : null;
    return null;
  }

  /**
   * (a) しぼり込みの条件をすべて満たすか。
   *   conds    … [{lane: 1〜6 または "self", mat, bands}](rule-match.js normMats の形)
   *   selfLane … 選手モードでの、その選手の艇番(通常モードは null)
   */
  function passMats(ref, conds, selfLane) {
    var RM = root.TeiyomiRuleMatch;
    for (var i = 0; i < conds.length; i++) {
      var c = conds[i];
      var lane = c.lane === "self" ? selfLane : c.lane;
      if (!RM.inMatBands(c.mat, value(ref, lane, c.mat), c.bands)) return false;
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
  function pickLane(ref, by) {
    var d = pickDef(by);
    if (!d || !ref) return null;
    var best = null, bestV = null;
    for (var n = 1; n <= 6; n++) {
      var v = value(ref, n, by);
      if (v === null) continue;
      if (bestV === null || (d.high ? v > bestV : v < bestV)) { best = n; bestV = v; }
    }
    return best;
  }

  /** 条件と「材料で決める」に要る材料の列(全国の月はこれだけを読む)。 */
  function fieldsFor(conds, by) {
    var out = [];
    (conds || []).forEach(function (c) { if (out.indexOf(c.mat) === -1) out.push(c.mat); });
    if (by && out.indexOf(by) === -1) out.push(by);
    return out;
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
    PICKS: PICKS, pickDef: pickDef, keyOf: keyOf, createStore: createStore, value: value,
    passMats: passMats, pickLane: pickLane, fieldsFor: fieldsFor, monthsIn: monthsIn
  };
})(typeof window !== "undefined" ? window : globalThis);
