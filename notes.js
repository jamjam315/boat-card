// 検証ノート(5bで試した条件と、そのときの結果)の保存・一覧・削除。
// 5b(backtest-custom.html)とマイページの両方から使う。
//
// 【条件アラート(alerts.js)とは別物】
// あちらの cond は「朝に判定できる条件だけ」を正規化したもので、照合のための形。
// こちらの cond は「画面をそっくり元に戻す」ためのもので、券種・買い目・期間まで持つ。
// 目的が違うので同じ形にはしない。
//
// 【resultを一緒に残す理由】
// 艇読みのデータは毎晩伸びるので、同じ条件でも1か月後には数字が変わる。
// 条件だけ残すと「あのとき何%だったか」が二度と分からなくなる。実行時点の
// 主要な数字と「データの最終日」を一緒に残し、開き直したときに並べて出す。
(function () {
  "use strict";

  var TABLE = "verification_notes";
  var MAX = 50;

  function cfg() {
    var c = window.TeiyomiAuth && TeiyomiAuth.getConfig();
    if (!c) throw new Error("not-ready");
    return c;
  }

  function req(method, path, body, extraHeaders) {
    var c = cfg();
    return TeiyomiAuth.getAccessToken().then(function (token) {
      if (!token) throw new Error("not-logged-in");
      var headers = {
        apikey: c.anonKey,
        Authorization: "Bearer " + token,
        "Content-Type": "application/json"
      };
      for (var k in (extraHeaders || {})) headers[k] = extraHeaders[k];
      return fetch(c.url + "/rest/v1/" + TABLE + path, {
        method: method, headers: headers,
        body: body ? JSON.stringify(body) : undefined
      });
    }).then(function (res) {
      if (res.status === 204) return null;
      return res.json().then(function (j) {
        if (!res.ok) {
          var err = new Error((j && (j.message || j.hint)) || ("HTTP " + res.status));
          err.status = res.status;
          throw err;
        }
        return j;
      });
    });
  }

  var COLS = "id,mode,cond,result,memo,label,created_at";

  function list() {
    return req("GET", "?select=" + COLS + "&order=created_at.desc");
  }

  function get(id) {
    return req("GET", "?select=" + COLS + "&id=eq." + encodeURIComponent(id))
      .then(function (rows) { return (rows && rows[0]) || null; });
  }

  function create(rec) {
    var user = window.TeiyomiAuth && TeiyomiAuth.getUser();
    if (!user || !user.id) return Promise.reject(new Error("not-logged-in"));
    return req("POST", "", [{
      user_id: user.id,
      mode: rec.mode || "normal",
      cond: rec.cond || {},
      result: rec.result || {},
      memo: rec.memo || null,
      label: rec.label || null
    }], { Prefer: "return=representation" });
  }

  function remove(id) {
    return req("DELETE", "?id=eq." + encodeURIComponent(id), null, { Prefer: "return=minimal" });
  }

  /** 「2026/08/01」の形。表示にしか使わない。 */
  function ymd(iso) {
    if (!iso) return "";
    var d = String(iso).slice(0, 10).split("-");
    return d.length === 3 ? d[0] + "/" + d[1] + "/" + d[2] : String(iso);
  }

  function pct(v) {
    return (typeof v === "number") ? (v * 100).toFixed(1) + "%" : "―";
  }

  /**
   * 記録時の数字の1行。「いつ時点の検証か」が分かるよう、実行日とデータの最終日を必ず添える。
   * 良し悪しの評価語は入れない(数字が動いていれば見た人が自分で気づく)。
   */
  function resultLine(result, createdAt) {
    var r = result || {};
    var when = ymd(r.runAt || createdAt);
    var dataTo = r.dataTo ? ("・データ〜" + ymd(r.dataTo).slice(5) + "時点") : "";
    var races = (typeof r.races === "number") ? r.races.toLocaleString("ja-JP") + "レース" : "";
    return "記録時（" + when + dataTo + "）：回収率 " + pct(r.returnRate) +
      "・的中率 " + pct(r.hitRate) + (races ? "・" + races : "");
  }

  window.TeiyomiNotes = {
    MAX: MAX,
    list: list,
    get: get,
    create: create,
    remove: remove,
    resultLine: resultLine,
    ymd: ymd,
    pct: pct
  };
})();
