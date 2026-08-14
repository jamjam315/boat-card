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
  var MAX = 30;   // 1人あたりの上限。DB側のトリガー(race_alerts_limit)と同じ数に保つこと

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
    // 上限はまずこちらで数えて止める(DB側のトリガーは回避された場合の歯止め)。
    // エラー文はDBトリガーと同じ「◯件までです」の形にして、表示側の判定を揃える。
    return list().then(function (rows) {
      if (rows && rows.length >= MAX) {
        throw new Error("条件アラートは1人" + MAX + "件までです");
      }
      return req("POST", "", [{
        user_id: user.id,
        toban: rec.toban,
        cond: rec.cond || {},
        raw_cond: rec.raw_cond || {},
        label: rec.label || null
      }], { Prefer: "return=representation" });
    });
  }

  function setEnabled(id, on) {
    return req("PATCH", "?id=eq." + encodeURIComponent(id), { enabled: !!on },
      { Prefer: "return=minimal" });
  }

  function remove(id) {
    return req("DELETE", "?id=eq." + encodeURIComponent(id), null,
      { Prefer: "return=minimal" });
  }

  // ---- 二つ名からの通知登録(🔔) ----
  // 殿堂(titles.html)と選手ページのバッジ根拠(career.js)の両方から呼ばれる、
  // 自己完結の小モーダル。称号ごとの条件プリセット・会員判定・保存・購読確認まで
  // ここで面倒を見る(2か所に複製するとプリセット定義がズレるため1か所に置く)。

  // 称号 → condプリセット。朝の照合(AlertCond)で判定できる軸だけを使い、
  // 当日まで分からない条件(天候・風・波・進入・決まり手)は出走通知に落とす。
  var TITLE_PRESETS = {
    "月下の覇王": { cond: { session: "night" }, line: "ナイター開催で走る日に通知します。" },
    "栄冠を狩る者": { cond: { kinds: ["優勝戦", "準優勝戦"] }, line: "優勝戦・準優勝戦に出る日に通知します。" },
    "氷海の王": { cond: { months: [12, 1, 2] }, line: "冬（12〜2月）に走る日に通知します。" },
    "炎海の王": { cond: { months: [6, 7, 8] }, line: "夏（6〜8月）に走る日に通知します。" },
    "荒海の覇者": { cond: {}, line: "出走する日に通知します。", note: "波・風・天候は当日まで分からないため、出走日にお知らせします。" },
    "風神の右腕": { cond: {}, line: "出走する日に通知します。", note: "波・風・天候は当日まで分からないため、出走日にお知らせします。" },
    "雨を統べる者": { cond: {}, line: "出走する日に通知します。", note: "波・風・天候は当日まで分からないため、出走日にお知らせします。" }
  };
  var SKILL_NOTE = "進入・決まり手は当日まで分からないため、出走日にお知らせします。";
  var SKILL_TITLES = ["カド一閃", "差しの匠", "隙間を縫う者", "絶対王政", "最終章の支配者", "音速の申し子", "進入の革命家"];

  /** 称号名(「・頂」付き可)と会場から、保存する条件と説明文を組み立てる。 */
  function titlePreset(title, venue) {
    var base = String(title || "").replace(/・頂$/, "");
    if (venue || /の守護神$/.test(base)) {
      var v = venue || base.replace(/の守護神$/, "");
      return { cond: { venues: [v] }, line: v + "で走る日に通知します。", base: base };
    }
    var p = TITLE_PRESETS[base];
    if (p) return { cond: p.cond, line: p.line, note: p.note || null, base: base };
    if (SKILL_TITLES.indexOf(base) !== -1) {
      return { cond: {}, line: "出走する日に通知します。", note: SKILL_NOTE, base: base };
    }
    return { cond: {}, line: "出走する日に通知します。", base: base };
  }

  /** 通知の受け口(push購読)が1つでもあるか。確認できない時はtrue扱いにして
      誤った誘導を出さない(保存自体は成立しているため)。 */
  function hasPushSubscription() {
    try {
      var c = cfg();
      return TeiyomiAuth.getAccessToken().then(function (token) {
        if (!token) return true;
        return fetch(c.url + "/rest/v1/push_subscriptions?select=id&limit=1", {
          headers: { apikey: c.anonKey, Authorization: "Bearer " + token }
        }).then(function (r) { return r.ok ? r.json() : null; })
          .then(function (rows) { return rows === null ? true : rows.length > 0; })
          .catch(function () { return true; });
      });
    } catch (e) { return Promise.resolve(true); }
  }

  function ensureBellStyle() {
    if (document.getElementById("ttBellStyle")) return;
    var s = document.createElement("style");
    s.id = "ttBellStyle";
    s.textContent =
      ".bell-overlay{position:fixed; inset:0; background:rgba(10,20,25,.45); z-index:70;" +
      "display:flex; align-items:center; justify-content:center; padding:20px;}" +
      ".bell-pop{background:var(--surface,#fff); border:1px solid var(--line2,#d3d8d2);" +
      "border-radius:14px; max-width:340px; width:100%; padding:18px 18px 14px; text-align:left;" +
      "font-size:12.5px; color:var(--ink2,#4a5a61); line-height:1.7;}" +
      ".bell-pop h3{margin:0 0 8px; font-size:14.5px; color:var(--ink,#13242a);}" +
      ".bell-pop .bell-line{color:var(--ink,#13242a);}" +
      ".bell-pop .bell-note{font-size:11px; color:var(--muted,#7c8a90); margin-top:8px;}" +
      ".bell-pop .bell-msg{margin-top:10px; font-weight:600;}" +
      ".bell-pop .bell-cta{display:block; width:100%; margin-top:12px; padding:10px;" +
      "border-radius:9px; border:1px solid var(--accent,#0e7c66); background:var(--accent,#0e7c66);" +
      "color:var(--on-accent,#fff); font:inherit; font-size:13px; font-weight:700; text-align:center;" +
      "cursor:pointer; text-decoration:none; box-sizing:border-box;}" +
      ".bell-pop .bell-cta[disabled]{opacity:.6; cursor:default;}" +
      ".bell-pop a.bell-cta{color:var(--on-accent,#fff);}" +
      ".bell-pop .bell-sub{display:block; width:100%; margin-top:8px; padding:9px;" +
      "border-radius:9px; border:1px solid var(--line2,#d3d8d2); background:none;" +
      "color:var(--ink2,#4a5a61); font:inherit; font-size:12.5px; text-align:center;" +
      "cursor:pointer; text-decoration:none; box-sizing:border-box;}";
    document.head.appendChild(s);
  }

  function escText(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c];
    });
  }

  /**
   * 🔔の一連の流れを開く。
   * opts = { toban, playerName, title(「・頂」付き可), venue(守護神のとき) }
   */
  function bellFlow(opts) {
    ensureBellStyle();
    var preset = titlePreset(opts.title, opts.venue);
    var name = opts.playerName || opts.toban;

    var ov = document.createElement("div");
    ov.className = "bell-overlay";
    function close() { ov.remove(); }
    ov.addEventListener("click", function (ev) { if (ev.target === ov) close(); });
    document.body.appendChild(ov);

    function render(html) { ov.innerHTML = '<div class="bell-pop" role="dialog" aria-modal="true">' + html + "</div>"; }
    function wire(sel, fn) { var el = ov.querySelector(sel); if (el) el.addEventListener("click", fn); }

    render("<h3>🔔 通知の登録</h3><p>確認中…</p>");

    var membershipReady = window.TeiyomiMembership
      ? TeiyomiMembership.load()
      : Promise.resolve(null);

    membershipReady.then(function (state) {
      if (!state || !state.active) {
        // 未ログイン・匿名・非会員はすべてここ(絞り込み通知はプレミアムの機能)。
        // Androidアプリ(TWA)では、購入への導線も購入を促す文言も出さない
        // (Playのポリシーで外部決済への誘導が禁じられているため)。
        var inApp = window.TeiyomiTWA && TeiyomiTWA.isTWA();
        render("<h3>🔔 絞り込み通知はプレミアムの機能です</h3>" +
          "<p>保存した条件に当てはまる出走がある朝だけ、通知でお知らせします。" +
          (inApp ? TeiyomiTWA.gateText() : "プレミアム（月額）でご利用いただけます。") + "</p>" +
          (inApp ? "" : '<a class="bell-cta" href="/premium/">プレミアムを見る</a>') +
          '<button type="button" class="bell-sub bell-close">閉じる</button>');
        wire(".bell-close", close);
        return;
      }
      var noteHtml = preset.note ? '<p class="bell-note">' + escText(preset.note) + "</p>" : "";
      render("<h3>🔔 " + escText(name) + "・" + escText(preset.base) + "</h3>" +
        '<p class="bell-line">' + escText(name) + "選手が" + escText(preset.line) + "</p>" + noteHtml +
        '<button type="button" class="bell-cta bell-save">この条件で通知する</button>' +
        '<button type="button" class="bell-sub bell-close">閉じる</button>' +
        '<p class="bell-msg" style="display:none;"></p>');
      wire(".bell-close", close);
      wire(".bell-save", function () {
        var btn = ov.querySelector(".bell-save");
        var msg = ov.querySelector(".bell-msg");
        btn.disabled = true; btn.textContent = "保存中…";
        list().then(function (rows) {
          if (findSame(rows, opts.toban, preset.cond)) {
            var e = new Error("already-saved");
            e.alreadySaved = true;
            throw e;
          }
          var label = name + "（" + preset.base + "）";
          return create({
            toban: opts.toban, cond: preset.cond,
            raw_cond: { source: "title", title: preset.base },
            label: label.length > 80 ? label.slice(0, 79) + "…" : label
          });
        }).then(function () {
          msg.style.display = "";
          msg.textContent = "保存しました。マイページで確認・整理できます。";
          btn.textContent = "保存しました";
          // 購読ゼロだと「保存だけされて1通も届かない」ので、その場で気づけるようにする。
          return hasPushSubscription().then(function (subscribed) {
            if (subscribed) return;
            msg.innerHTML = "保存しました。ただし、この条件の<b>通知を受け取るには購読が必要です</b>。" +
              '<a href="/mypage.html">マイページの「通知」</a>からONにしてください。';
          });
        }).catch(function (err) {
          msg.style.display = "";
          var text = String((err && (err.message || "")) || "");
          if (err && err.alreadySaved) {
            msg.textContent = "この条件はすでに保存されています。マイページで確認できます。";
            btn.textContent = "保存済み";
            return;
          }
          btn.disabled = false; btn.textContent = "この条件で通知する";
          if (/件までです|check_violation/.test(text)) {
            msg.textContent = "条件アラートは" + MAX + "件までです。マイページで整理できます。";
          } else if (text === "not-logged-in" || text === "not-ready") {
            msg.textContent = "ログインすると保存できます。マイページからログインしてください。";
          } else if (err && (err.status === 403 || /42501|row.level security/i.test(text))) {
            msg.textContent = (window.TeiyomiTWA && TeiyomiTWA.isTWA())
              ? TeiyomiTWA.gateText() : "プレミアムにご登録いただくと保存できます。";
          } else {
            msg.textContent = "保存できませんでした。時間をおいて再度お試しください。";
          }
        });
      });
    }).catch(function () {
      render("<h3>🔔 通知の登録</h3><p>状態を確認できませんでした。時間をおいて再度お試しください。</p>" +
        '<button type="button" class="bell-sub bell-close">閉じる</button>');
      wire(".bell-close", close);
    });
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
    findSame: findSame,
    titlePreset: titlePreset,
    bellFlow: bellFlow
  };
})();
