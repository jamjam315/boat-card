// 条件アラート(保存した絞り込みと今日の出走表を朝に照合して知らせる)の
// 保存・一覧・オンオフ・削除。5b(backtest-custom.html)とマイページの両方から使う。
//
// 【condの形は勝手に決めない】
// 照合する側の仕様は supabase/functions/_shared/morning-message.ts の AlertCond に
// 1つだけ書いてある。ここはそれに合わせて書き込むだけで、独自に項目を足さない。
// 保存側と照合側で形がずれると、保存はできるのに朝いつまでも鳴らない、という
// いちばん気づきにくい壊れ方をするため。
//
//   venues  会場名の配列 / races 1〜12 / months 1〜12 / frames 枠1〜6
//   kinds   優勝戦・準優勝戦・予選・一般・その他 / dists 1800・1200
//   fixed   true=固定戦のみ false=固定を除く / session "night" | "day"
// どのキーも省略可で、省略は「その条件では絞らない」。
//
// 【通信はREST直叩き】
// 5bもマイページも supabase-js のクライアントを持っていない(favorites.jsが内部で
// 持っているだけ)。TeiyomiAuth が公開している url/anonKey/アクセストークンを使って
// PostgRESTを直接呼ぶ。RLSで本人の行しか触れないので、user_idは必ず自分のものを入れる。
(function () {
  "use strict";

  var TABLE = "race_alerts";
  var MAX = 10;   // 1人あたりの上限。DB側のトリガーと同じ数(理由は通知の文面が破綻するため)

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
        method: method,
        headers: headers,
        body: body ? JSON.stringify(body) : undefined
      });
    }).then(function (res) {
      if (res.status === 204) return null;
      return res.json().then(function (j) {
        if (!res.ok) {
          var err = new Error((j && (j.message || j.hint)) || ("HTTP " + res.status));
          err.status = res.status;
          err.payload = j;
          throw err;
        }
        return j;
      });
    });
  }

  // ---- 表示用の文言 ----

  var KIND_ORDER = ["優勝戦", "準優勝戦", "予選", "一般", "その他"];

  /** condを「会場：下関」の形の配列にする。指定の無い軸は出さない。 */
  function condLabels(cond) {
    var c = cond || {};
    var out = [];
    function join(a) { return a.join("・"); }
    if (c.venues && c.venues.length) out.push("会場：" + join(c.venues));
    if (c.races && c.races.length) out.push("レース番号：" + join(c.races.map(function (n) { return n + "R"; })));
    if (c.months && c.months.length) out.push("月：" + join(c.months.map(function (n) { return n + "月"; })));
    if (c.frames && c.frames.length) out.push("枠：" + join(c.frames.map(function (n) { return n + "枠"; })));
    if (c.kinds && c.kinds.length) {
      var ks = KIND_ORDER.filter(function (k) { return c.kinds.indexOf(k) !== -1; });
      out.push("種別：" + join(ks.length ? ks : c.kinds));
    }
    if (c.dists && c.dists.length) out.push("距離：" + join(c.dists.map(function (n) { return n + "m"; })));
    if (typeof c.fixed === "boolean") out.push("進入固定：" + (c.fixed ? "固定戦のみ" : "固定戦を除く"));
    if (c.session === "night") out.push("開催区分：ナイター場");
    if (c.session === "day") out.push("開催区分：デイ場");
    return out;
  }

  /** 一覧に出す1行の要約。条件が無ければ「すべてのレース」。 */
  function condSummary(cond) {
    var l = condLabels(cond);
    return l.length ? l.join(" ／ ") : "すべてのレース";
  }

  // ---- 読み書き ----

  function list() {
    return req("GET", "?select=id,toban,cond,raw_cond,label,enabled,created_at&order=created_at.asc");
  }

  function create(rec) {
    var user = window.TeiyomiAuth && TeiyomiAuth.getUser();
    if (!user || !user.id) return Promise.reject(new Error("not-logged-in"));
    return req("POST", "", [{
      user_id: user.id,
      toban: rec.toban,
      cond: rec.cond || {},
      raw_cond: rec.raw_cond || {},
      label: rec.label || null
    }], { Prefer: "return=representation" });
  }

  function setEnabled(id, on) {
    return req("PATCH", "?id=eq." + encodeURIComponent(id), { enabled: !!on },
      { Prefer: "return=minimal" });
  }

  function remove(id) {
    return req("DELETE", "?id=eq." + encodeURIComponent(id), null,
      { Prefer: "return=minimal" });
  }

  /** 同じ選手・同じ条件が既にあるか(完全一致のみ見る)。 */
  function findSame(rows, toban, cond) {
    var key = JSON.stringify(sortedKeys(cond));
    for (var i = 0; i < (rows || []).length; i++) {
      if (rows[i].toban !== toban) continue;
      if (JSON.stringify(sortedKeys(rows[i].cond)) === key) return rows[i];
    }
    return null;
  }
  // キーの順番が違うだけの同じ条件を「別物」と見ないように、並べ直してから比べる。
  function sortedKeys(o) {
    if (!o || typeof o !== "object") return o;
    if (Array.isArray(o)) return o.slice().sort();
    var out = {};
    Object.keys(o).sort().forEach(function (k) { out[k] = sortedKeys(o[k]); });
    return out;
  }

  window.TeiyomiAlerts = {
    MAX: MAX,
    list: list,
    create: create,
    setEnabled: setEnabled,
    remove: remove,
    condLabels: condLabels,
    condSummary: condSummary,
    findSame: findSame
  };
})();
