// 選手ページの「キャリア」セクション。players/career/{登番}.json を読んで描く。
//
// 無料で見せるもの: 直近3年の1着率・2連対率(母数つき)と、現在の級別
// プレミアム: データがある全年の推移、級別の階段(期ごと)、公式勝率(点数)の推移
//
// 【壁の作りは5b(backtest-custom.html)と同じ】
// TeiyomiMembership.onChange で active/trialing のときだけ中身を出し、それ以外は
// 案内(pm-gate)を出す。判定の実装はここには書かず membership.js をそのまま使う。
// 5bと同じく、これは「表示上の壁」であって技術的な防御ではない
// (JSONは直接URLを叩けば誰でも取れる)。お金を払っていない人にうっかり
// 見せないための線引きとして置いている。
//
// 【表示の決まりごと】
// - 順位・スコア・評価語は出さない。上昇=緑/下降=赤のような色分けもしない
// - 出走数の少ない年も隠さず、母数(◯走)をそのまま添える
// - 「1着率」は1着数÷出走数。公式の「勝率」は着順点の平均で別物なので、
//   ラベルを「勝率（公式・点数）」と書き分けて混同させない
(function () {
  "use strict";

  var CARD_ID = "careerCard";
  var card = document.getElementById(CARD_ID);
  if (!card) return;
  var toban = card.getAttribute("data-toban");
  if (!toban) return;

  var FREE_YEARS = 3;

  // ---- スタイル(このセクション専用。選手ページ側のCSSは触らない) ----
  function ensureStyle() {
    if (document.getElementById("careerStyle")) return;
    var s = document.createElement("style");
    s.id = "careerStyle";
    s.textContent =
      ".cr-msg{font-size:12.5px; color:var(--muted); margin:0;}" +
      ".cr-now{font-size:13px; color:var(--ink2); margin:0 0 10px; display:flex;" +
      "align-items:baseline; gap:8px; flex-wrap:wrap;}" +
      ".cr-badge{font-size:12px; font-weight:700; color:#fff; background:var(--accent);" +
      "border-radius:999px; padding:2px 10px;}" +
      ".cr-year{margin-top:12px;}" +
      ".cr-year:first-of-type{margin-top:0;}" +
      ".cr-yhead{display:flex; align-items:baseline; justify-content:space-between; gap:8px;" +
      "font-size:12.5px; color:var(--ink); margin-bottom:5px;}" +
      ".cr-yhead b{font-size:13.5px;}" +
      ".cr-n{font-size:11.5px; color:var(--muted);}" +
      ".cr-line{display:flex; align-items:center; gap:8px; margin-top:4px;}" +
      ".cr-lbl{flex:0 0 4.6em; font-size:11.5px; color:var(--muted);}" +
      ".cr-bar{flex:1 1 auto; height:8px; background:var(--bg); border-radius:4px; overflow:hidden;}" +
      ".cr-bar i{display:block; height:100%; background:var(--accent);}" +
      ".cr-bar.sub i{background:var(--line2);}" +
      ".cr-val{flex:0 0 4.2em; text-align:right; font-size:12px;" +
      "font-variant-numeric:tabular-nums lining-nums;}" +
      ".cr-sec{margin-top:16px; padding-top:12px; border-top:1px dashed var(--line2);}" +
      ".cr-sec-ttl{font-size:12.5px; font-weight:600; color:var(--ink2); margin:0 0 8px;}" +
      ".cr-cl{display:flex; align-items:center; gap:8px; margin-top:5px; font-size:12px;}" +
      ".cr-cl-period{flex:0 0 7.6em; color:var(--muted); font-size:11px;" +
      "font-variant-numeric:tabular-nums lining-nums;}" +
      ".cr-steps{flex:0 0 auto; display:grid; grid-template-columns:repeat(4,10px); gap:3px;}" +
      ".cr-steps span{height:10px; border-radius:2px; background:var(--bg);}" +
      ".cr-steps span.on{background:var(--accent);}" +
      ".cr-cl-name{flex:0 0 2.2em; font-weight:600;}" +
      ".cr-cl-rate{flex:1 1 auto; text-align:right; color:var(--muted); font-size:11px;" +
      "font-variant-numeric:tabular-nums lining-nums;}" +
      // 勝ち方のセクション。行の作りは上の cr-line と同じで、ラベルが長い
      // (「まくり差し」)ぶんだけ幅を広げ、右側に母数と基準値を添える。
      // 勝ち方のラベルは最長6文字(「外からの進入」「波高15cm〜」)。5.4emだと
      // この2つが2行に折り返して行の高さが揃わなくなるため、6.4emにしている。
      ".cr-lbl.w{flex:0 0 6.4em;}" +
      ".cr-side{flex:0 0 auto; font-size:11px; color:var(--muted); white-space:nowrap;" +
      "font-variant-numeric:tabular-nums lining-nums;}" +
      ".cr-item{margin-top:9px;}" +
      ".cr-item:first-of-type{margin-top:0;}" +
      ".cr-ihead{display:flex; align-items:baseline; justify-content:space-between; gap:8px;" +
      "font-size:12.5px; color:var(--ink); margin-bottom:4px;}" +
      ".cr-ihead b{font-size:13px; font-weight:600;}" +
      ".cr-vlist{display:grid; grid-template-columns:repeat(auto-fill,minmax(148px,1fr)); gap:4px 14px;}" +
      ".cr-v{display:flex; align-items:baseline; gap:6px; font-size:12px;" +
      "font-variant-numeric:tabular-nums lining-nums;}" +
      ".cr-v-name{flex:1 1 auto; color:var(--ink2); overflow:hidden; text-overflow:ellipsis;" +
      "white-space:nowrap;}" +
      ".cr-v-val{flex:0 0 auto;}" +
      ".cr-v-n{flex:0 0 auto; font-size:11px; color:var(--muted);}" +
      ".cr-none{font-size:12px; color:var(--muted); margin:0;}" +
      ".cr-verify{display:block; padding:11px; border-radius:9px; border:1px solid var(--accent);" +
      "color:var(--accent); font-size:13.5px; font-weight:700; text-align:center;" +
      "text-decoration:none;}" +
      ".cr-fine{font-size:11px; color:var(--muted); margin-top:8px; line-height:1.6;}" +
      ".cr-note{font-size:11px; color:var(--muted); margin-top:10px; line-height:1.6;}" +
      ".cr-gate{background:var(--surface); border:1px solid var(--accent); border-radius:10px;" +
      "margin-top:14px; padding:14px 16px;}" +
      ".cr-gate h3{margin:0 0 6px; font-size:13.5px;}" +
      ".cr-gate p{margin:0; font-size:12.5px; color:var(--ink2); line-height:1.7;}" +
      ".cr-gate p.sub{margin-top:6px; font-size:11.5px; color:var(--muted);}" +
      ".cr-gate .cta{display:block; margin-top:12px; padding:11px; border-radius:9px;" +
      "background:var(--accent); color:#fff; font-size:13.5px; font-weight:700;" +
      "text-align:center; text-decoration:none;}" +
      // ---- 二つ名バッジ(ヒーロー欄・選手名の直下) ----
      // 通常はシルバー系、「頂」だけ金枠+👑。緑基調のサイトから浮きすぎない
      // よう、塗りはせず枠と文字色だけで質感を出す。375pxでは折り返して並ぶ。
      ".tt-badges{display:flex; flex-wrap:wrap; justify-content:center; gap:6px; margin-top:10px;}" +
      ".tt-badge{font-size:11.5px; font-weight:700; line-height:1; padding:6px 11px;" +
      "border-radius:999px; cursor:pointer; -webkit-tap-highlight-color:transparent;" +
      "font-family:inherit; background:var(--surface); white-space:nowrap;" +
      "border:1px solid #a8b4b9; color:#5d6b71;}" +
      "@media (prefers-color-scheme: dark){.tt-badge{border-color:#5a686e; color:#aebcc0;}}" +
      ".tt-badge.top{border-color:#c9922a; color:#a2731c; box-shadow:0 0 0 1px #c9922a inset;}" +
      "@media (prefers-color-scheme: dark){.tt-badge.top{border-color:#e0b054; color:#e0b054;" +
      "box-shadow:0 0 0 1px #e0b054 inset;}}" +
      // 根拠の小モーダル。ページ遷移させず、その場で開いてタップで閉じる。
      ".tt-overlay{position:fixed; inset:0; background:rgba(10,20,25,.45); z-index:60;" +
      "display:flex; align-items:center; justify-content:center; padding:20px;}" +
      ".tt-pop{background:var(--surface); border:1px solid var(--line2); border-radius:14px;" +
      "max-width:340px; width:100%; padding:18px 18px 14px; text-align:left;}" +
      ".tt-pop h3{margin:0; font-size:15px;}" +
      ".tt-pop .tt-rank{font-size:11.5px; color:var(--muted); margin:3px 0 10px;}" +
      ".tt-pop p{margin:0; font-size:12.5px; color:var(--ink2); line-height:1.7;}" +
      ".tt-pop .tt-fine{font-size:11px; color:var(--muted); margin-top:10px; padding-top:10px;" +
      "border-top:1px dashed var(--line2); line-height:1.6;}" +
      ".tt-pop .tt-close{display:block; width:100%; margin-top:12px; padding:9px;" +
      "border-radius:9px; border:1px solid var(--line2); background:none; color:var(--ink2);" +
      "font:inherit; font-size:12.5px; cursor:pointer;}" +
      ".tt-pop .tt-verify{display:block; margin-top:12px; padding:10px; border-radius:9px;" +
      "border:1px solid var(--accent); color:var(--accent); font-size:12.5px; font-weight:700;" +
      "text-align:center; text-decoration:none;}" +
      ".tt-pop .tt-bell{display:block; width:100%; margin-top:8px; padding:10px;" +
      "border-radius:9px; border:1px solid var(--line2); background:none; color:var(--ink2);" +
      "font:inherit; font-size:12.5px; font-weight:700; text-align:center; cursor:pointer;}" +
      ".tt-pop .tt-bell[disabled]{opacity:.6; cursor:default;}";
    document.head.appendChild(s);
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c];
    });
  }
  function pct(v) { return v == null ? "―" : (v * 100).toFixed(1) + "%"; }
  function width(v) { return Math.max(0, Math.min(100, (v || 0) * 100)).toFixed(1); }

  /** 1年ぶんの行(1着率・2連対率・母数)。 */
  function yearRow(y) {
    return '<div class="cr-year">' +
      '<div class="cr-yhead"><b>' + y.year + '年</b>' +
      '<span class="cr-n">' + y.starts.toLocaleString("ja-JP") + '走</span></div>' +
      '<div class="cr-line"><span class="cr-lbl">1着率</span>' +
      '<span class="cr-bar"><i style="width:' + width(y.win_rate) + '%"></i></span>' +
      '<span class="cr-val">' + pct(y.win_rate) + '</span></div>' +
      '<div class="cr-line"><span class="cr-lbl">2連対率</span>' +
      '<span class="cr-bar sub"><i style="width:' + width(y.top2_rate) + '%"></i></span>' +
      '<span class="cr-val">' + pct(y.top2_rate) + '</span></div>' +
      '</div>';
  }

  // 級別を4段の目盛りで表す(A1が4段目)。段の色は1色だけで、良し悪しの色分けはしない。
  var CLASS_LEVEL = { "B2": 1, "B1": 2, "A2": 3, "A1": 4 };
  function classRow(c) {
    var level = CLASS_LEVEL[c["class"]] || 0;
    var cells = "";
    for (var i = 1; i <= 4; i++) cells += '<span class="' + (i === level ? "on" : "") + '"></span>';
    var period = c.from.slice(0, 7).replace("-", "/") + "〜" + c.to.slice(0, 7).replace("-", "/");
    var rate = c.official_win_rate == null ? "" : "勝率（公式・点数）" + c.official_win_rate.toFixed(2);
    return '<div class="cr-cl"><span class="cr-cl-period">' + esc(period) + '</span>' +
      '<span class="cr-steps">' + cells + '</span>' +
      '<span class="cr-cl-name">' + esc(c["class"]) + '</span>' +
      '<span class="cr-cl-rate">' + esc(rate) + '</span></div>';
  }

  // ---- 勝ち方の表示 ----
  var KIMARITE = ["逃げ", "差し", "まくり", "まくり差し", "抜き", "恵まれ"];
  var COURSE_KEYS = ["1", "2", "3", "4", "5", "6"];

  function n(v) { return (v || 0).toLocaleString("ja-JP"); }
  function ratio(a, b) { return b ? a / b : null; }

  /** ラベル・バー・値の1行。side には母数や基準値を添える(無いときは省く)。 */
  function bar(label, rate, side, sub) {
    return '<div class="cr-line"><span class="cr-lbl w">' + esc(label) + '</span>' +
      '<span class="cr-bar' + (sub ? " sub" : "") + '"><i style="width:' + width(rate) + '%"></i></span>' +
      '<span class="cr-val">' + pct(rate) + '</span>' +
      (side ? '<span class="cr-side">' + esc(side) + '</span>' : "") + '</div>';
  }
  function section(title, inner) {
    return '<div class="cr-sec"><p class="cr-sec-ttl">' + esc(title) + '</p>' + inner + '</div>';
  }
  function none(msg) { return '<p class="cr-none">' + esc(msg) + '</p>'; }

  /** 年別を足した本人の通算。条件別・大舞台の「本人全体」の基準に使う。 */
  function overall(doc) {
    var s = 0, w = 0, t = 0;
    (doc.years || []).forEach(function (y) { s += y.starts; w += y.wins; t += y.top2; });
    return { starts: s, wins: w, top2: t, win_rate: ratio(w, s), top2_rate: ratio(t, s) };
  }

  /** 【無料】1着したときの決まり手の内訳。全国の構成比を併記する。 */
  function kimariteSection(doc, nat) {
    var k = doc.kimarite || {};
    var total = k.total_wins || 0;
    if (!total) {
      return section("勝ち方（1着したときの決まり手）",
        none("まだ1着がありません。1着が出ると、その決まり方をここに出します。"));
    }
    var counts = k.counts || {};
    var natCounts = (nat && nat.kimarite && nat.kimarite.counts) || null;
    var natTotal = (nat && nat.kimarite && nat.kimarite.total_wins) || 0;
    var rows = KIMARITE.map(function (name) {
      var c = counts[name] || 0;
      var side = n(c) + "本";
      if (natCounts && natTotal) {
        side += "／全国" + pct(ratio(natCounts[name] || 0, natTotal));
      }
      return bar(name, ratio(c, total), side);
    }).join("");
    return section("勝ち方（1着したときの決まり手）",
      '<p class="cr-fine">1着 ' + n(total) + '本の内訳です。' +
      (natCounts ? "「全国」は同じ期間の全レースでの構成比です。" : "") + '</p>' + rows);
  }

  /** コース別の1着率。基準は全国の同じコースの1着率。 */
  function coursesSection(doc, nat) {
    var cs = doc.courses || {};
    var natCs = (nat && nat.courses) || null;
    var inner = COURSE_KEYS.map(function (c) {
      var x = cs[c] || {};
      if (!x.starts) return bar(c + "コース", null, "データなし");
      var side = n(x.starts) + "走";
      if (natCs && natCs[c] && natCs[c].win_rate != null) {
        side += "／平均" + pct(natCs[c].win_rate);
      }
      var kim = x.kimarite || {};
      var top = null;
      Object.keys(kim).forEach(function (name) {
        if (!top || kim[name] > kim[top]) top = name;
      });
      return bar(c + "コース", x.win_rate, side) +
        (top ? '<p class="cr-fine" style="margin-top:2px;">主に ' + esc(top) +
               '（' + n(kim[top]) + '本）</p>' : "");
    }).join("");
    return section("コース別の1着率", inner +
      '<p class="cr-fine">「平均」は同じ期間の全国のコース別1着率です。</p>');
  }

  /** 会場別。出走数の多い順に並べるだけで、順位や優劣の色は付けない。 */
  function venuesSection(doc) {
    var v = doc.venues || {};
    var names = Object.keys(v);
    if (!names.length) return section("会場別の1着率", none("データなし"));
    names.sort(function (a, b) { return v[b].starts - v[a].starts; });
    var items = names.map(function (name) {
      return '<div class="cr-v"><span class="cr-v-name">' + esc(name) + '</span>' +
        '<span class="cr-v-val">' + pct(v[name].win_rate) + '</span>' +
        '<span class="cr-v-n">' + n(v[name].starts) + '走</span></div>';
    }).join("");
    return section("会場別の1着率（" + names.length + "場）",
      '<div class="cr-vlist">' + items + '</div>' +
      '<p class="cr-fine">出走数の多い順です。並び順に良し悪しの意味はありません。</p>');
  }

  /** 条件別。基準は本人の通算1着率(全国平均は全選手合計すると必ず1/6になり使えない)。 */
  function conditionsSection(doc, own, nat) {
    var c = doc.conditions || {};
    var th = (nat && nat.thresholds) || {};
    var wind = th.strong_wind_m || 8, wave = th.high_wave_cm || 15;
    var defs = [
      ["rain", "雨"],
      ["strong_wind", "強風" + wind + "m〜"],
      ["high_wave", "波高" + wave + "cm〜"],
    ];
    var base = own.win_rate;
    var inner = defs.map(function (d) {
      var x = c[d[0]] || {};
      if (!x.starts) return bar(d[1], null, "データなし");
      return bar(d[1], x.win_rate, n(x.starts) + "走／本人全体" + pct(base));
    }).join("");
    return section("条件別の1着率", inner +
      '<p class="cr-fine">比べる相手はこの選手自身の通算1着率（' + pct(base) + '・' +
      n(own.starts) + '走）です。母数が少ない条件もそのまま出しています。</p>');
  }

  /** 大舞台。優勝戦・準優勝戦。基準は本人全体。 */
  function finalsSection(doc, own) {
    var f = doc.finals || {};
    var inner = ["優勝戦", "準優勝戦"].map(function (name) {
      var x = f[name] || {};
      if (!x.starts) return bar(name, null, "出走なし");
      // 下段のラベルに字下げの全角スペースを入れるとラベル枠(5.4em)を超えて
      // 2行に折り返すため、字下げは付けない。薄いバー(sub)で従属関係を示す。
      return bar(name, x.win_rate, n(x.starts) + "走／本人全体" + pct(own.win_rate)) +
        bar("2連対率", x.top2_rate, n(x.starts) + "走／本人全体" + pct(own.top2_rate), true);
    }).join("");
    return section("大舞台（優勝戦・準優勝戦）", inner);
  }

  /** 進入の癖。内に入ったのか外になったのかを分ける(意味が正反対のため)。 */
  function entrySection(doc) {
    var m = doc.maezuke || {};
    var u = m.uchi || {}, s = m.soto || {};
    var inner =
      bar("枠なり", m.wakunari_rate, n(m.wakunari_starts) + "走") +
      bar("内に入った", u.rate, n(u.starts) + "走") +
      (u.starts ? bar("その1着率", u.win_rate, n(u.wins) + "本", true) : "") +
      bar("外からの進入", s.rate, n(s.starts) + "走") +
      (s.starts ? bar("その1着率", s.win_rate, n(s.wins) + "本", true) : "");
    var fine = '<p class="cr-fine">「内に入った」は枠より内のコースから、' +
      '「外からの進入」は枠より外のコースからスタートした出走です。' +
      '上3つは全出走に占める割合、その下は各々の中での1着率です。</p>';
    var fl = (doc.flying || []).filter(function (r) { return r.F || r.L; });
    if (fl.length) {
      fine += '<p class="cr-fine">フライング・出遅れ：' + fl.map(function (r) {
        var parts = [];
        if (r.F) parts.push("F" + r.F);
        if (r.L) parts.push("L" + r.L);
        return r.year + "年 " + parts.join("・");
      }).join(" / ") + '</p>';
    }
    return section("進入の癖", inner + fine);
  }

  /** 「読む」から「検証する」への導線。5b側が ?toban= を読んで初期選択する。 */
  function verifyLink(doc) {
    return '<div class="cr-sec"><a class="cr-verify" href="/backtest-custom.html?toban=' +
      encodeURIComponent(doc.toban) + '">この選手で検証する →</a>' +
      '<p class="cr-fine">この選手の舟券を毎レース買い続けていたら、いくらになっていたかを調べられます。</p></div>';
  }

  function waysHtml(doc, nat, premium) {
    var html = kimariteSection(doc, nat);
    if (!premium) return html;
    var own = overall(doc);
    return html + coursesSection(doc, nat) + venuesSection(doc) +
      conditionsSection(doc, own, nat) + finalsSection(doc, own) + entrySection(doc) +
      verifyLink(doc);
  }

  function render(doc, premium) {
    var years = doc.years || [];
    var classes = doc.classes || [];
    if (years.length === 0 && classes.length === 0) {
      return '<p class="cr-msg">この選手のキャリアのデータはまだありません。</p>';
    }

    var html = "";
    var latest = classes.length ? classes[classes.length - 1] : null;
    if (latest) {
      html += '<p class="cr-now">現在の級別 <span class="cr-badge">' + esc(latest["class"]) + '</span>' +
        '<span class="cr-n">' + esc(latest.from.slice(0, 7).replace("-", "/")) + '〜' +
        esc(latest.to.slice(0, 7).replace("-", "/")) + ' 適用</span></p>';
    }

    var shown = premium ? years : years.slice(-FREE_YEARS);
    html += shown.map(yearRow).join("");
    if (!premium && years.length > FREE_YEARS) {
      html += '<p class="cr-note">直近' + FREE_YEARS + '年ぶんを表示しています（記録は' +
        years[0].year + '年から）。</p>';
    }

    if (premium) {
      if (classes.length) {
        html += '<div class="cr-sec"><p class="cr-sec-ttl">級別の変遷（' + classes.length + '期）</p>' +
          classes.map(classRow).join("") + '</div>';
      }
      html += waysHtml(doc, national, true);
      html += '<p class="cr-note">1着率＝1着数÷出走数、2連対率＝2着以内÷出走数。' +
        '「勝率（公式・点数）」は着順に応じた点数の平均で、1着率とは計算方法が異なります。</p>';
    } else {
      html += waysHtml(doc, national, false);
      html += '<p class="cr-note">1着率＝1着数÷出走数、2連対率＝2着以内÷出走数。</p>';
    }
    return html;
  }

  function gateHtml() {
    return '<div class="cr-gate"><h3>この先はプレミアム限定です</h3>' +
      '<p>データがある全年の推移、級別の変遷、そしてコース別・会場別・条件別・大舞台・' +
      '進入の癖といった「勝ち方」の内訳は、プレミアムにご登録いただくとご覧いただけます。</p>' +
      '<p class="sub">直近' + FREE_YEARS + '年の成績は、これまで通り無料でご覧いただけます。</p>' +
      '<a class="cta" href="/premium/">プレミアムを見る</a></div>';
  }

  // ---- 読み込みと描画 ----
  ensureStyle();
  var body = document.getElementById("careerBody");
  // ---- 二つ名バッジ(無料表示。会員判定を待たずに出す) ----
  // 付与基準の一行説明。titles.jsonの判定(build_player_career.py)と対で更新する。
  var TITLE_DESC = {
    "荒海の覇者": "高波15cm以上のレースで、1着率が通常時比{M}（{N}走）。",
    "風神の右腕": "風速8m以上のレースで、1着率が通常時比{M}（{N}走）。",
    "雨を統べる者": "雨のレースで、1着率が通常時比{M}（{N}走）。",
    "月下の覇王": "ナイター開催で、1着率が通常時比{M}（{N}走）。",
    "栄冠を狩る者": "優勝戦・準優勝戦で、1着率が通常時比{M}（{N}走）。",
    "氷海の王": "冬（12〜2月）のレースで、1着率が通常時比{M}（{N}走）。",
    "炎海の王": "夏（6〜8月）のレースで、1着率が通常時比{M}（{N}走）。",
    "カド一閃": "4〜6コースからの「まくり」勝率が全国平均比{M}（進入{N}走）。",
    "差しの匠": "2〜4コースからの「差し」勝率が全国平均比{M}（進入{N}走）。",
    "隙間を縫う者": "「まくり差し」での勝率が全国平均比{M}（{N}走）。",
    "絶対王政": "1コースからの「逃げ」成功率が全国平均比{M}（{N}走）。",
    "最終章の支配者": "「抜き」での勝率が全国平均比{M}（{N}走）。",
    "音速の申し子": "平均スタートタイミング{M}（{N}走）。F率が全国平均以下の選手だけが対象。",
    "進入の革命家": "自ら内のコースを取りにいく「前づけ」での1着率が、全国の前づけ平均比{M}（前づけ{N}走）。"
  };
  var TT_DISCLAIMER = "これは過去データの機械的集計です。予想でも推奨でもありません。";

  function baseTitle(t) { return String(t).replace(/・頂$/, ""); }

  function titleGrounds(t) {
    var base = baseTitle(t.title);
    var isGuardian = !!t.venue || /の守護神$/.test(base);
    var m = base === "音速の申し子" ? t.metric.toFixed(3)
                                    : "+" + (t.metric * 100).toFixed(1) + "pt";
    var text, rank;
    if (isGuardian) {
      var venue = t.venue || base.replace(/の守護神$/, "");
      text = venue + "での1着率が、本人の通算比" + m + "（当地" + n(t.n) + "走）。";
      rank = "この場でただ1人の称号";
    } else {
      text = (TITLE_DESC[base] || "").replace("{M}", m).replace("{N}", n(t.n));
      text += base === "音速の申し子"
        ? "全国最速級の上位10名だけが名乗れる称号。"
        : "全国上位10名だけが名乗れる称号。";
      rank = t.rank + "位／10人中" + (t.is_top ? "（1位＝頂）" : "");
    }
    return { text: text, rank: rank };
  }

  // alerts.js(🔔の共通フロー)は選手ページには最初から入っていない。1,644ページの
  // 再生成を避けるため、必要になった時にここから読み込む(読むのは1回だけ)。
  var alertsLibPromise = null;
  function ensureAlertsLib() {
    if (window.TeiyomiAlerts && TeiyomiAlerts.bellFlow) return Promise.resolve();
    if (alertsLibPromise) return alertsLibPromise;
    alertsLibPromise = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = "/alerts.js";
      s.onload = function () { resolve(); };
      s.onerror = function () { alertsLibPromise = null; reject(new Error("load-failed")); };
      document.head.appendChild(s);
    });
    return alertsLibPromise;
  }

  function openTitlePop(t) {
    var g = titleGrounds(t);
    var ov = document.createElement("div");
    ov.className = "tt-overlay";
    ov.innerHTML = '<div class="tt-pop" role="dialog" aria-modal="true">' +
      "<h3>" + (t.is_top ? "👑 " : "") + esc(t.title) + "</h3>" +
      '<p class="tt-rank">' + esc(g.rank) + "</p>" +
      "<p>" + esc(g.text) + "</p>" +
      // 二つ名は1着率の傾向で、舟券の妙味(回収率)とは別物。答えではなく
      // 仮説の入口として、5bでの検証へつなぐ(5b側が ?toban= を読んで初期選択する)。
      '<a class="tt-verify" href="/backtest-custom.html?toban=' + encodeURIComponent(toban) +
      '">この選手をバックテストで検証する →</a>' +
      '<button type="button" class="tt-bell">🔔 この条件の通知を登録する</button>' +
      '<p class="tt-fine">' + esc(TT_DISCLAIMER) +
      "よく勝つことと、舟券として儲かること（回収率）は別です。</p>" +
      '<button type="button" class="tt-close">閉じる</button></div>';
    function close() { ov.remove(); }
    ov.addEventListener("click", function (ev) { if (ev.target === ov) close(); });
    ov.querySelector(".tt-close").addEventListener("click", close);
    ov.querySelector(".tt-bell").addEventListener("click", function () {
      var btn = this;
      btn.disabled = true;
      ensureAlertsLib().then(function () {
        close();   // 🔔のモーダルに切り替える(重ねると375pxで窮屈なため)
        TeiyomiAlerts.bellFlow({
          toban: toban,
          playerName: (loaded && loaded.name) || toban,
          title: t.title,
          venue: t.venue || null
        });
      }).catch(function () {
        btn.disabled = false;
        btn.textContent = "🔔 読み込めませんでした。再度お試しください";
      });
    });
    document.body.appendChild(ov);
  }

  function renderTitleBadges(doc) {
    var titles = doc.titles || [];
    if (!titles.length) return;
    var hero = document.querySelector(".hero-body");
    if (!hero || hero.querySelector(".tt-badges")) return;
    var box = document.createElement("div");
    box.className = "tt-badges";
    titles.forEach(function (t) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "tt-badge" + (t.is_top ? " top" : "");
      b.textContent = (t.is_top ? "👑 " : "") + t.title;
      b.addEventListener("click", function () { openTitlePop(t); });
      box.appendChild(b);
    });
    // 選手名(pname)・基本情報(pmeta)の直下、キャッチコピーの上に置く。
    var meta = hero.querySelector(".pmeta");
    if (meta && meta.nextSibling) hero.insertBefore(box, meta.nextSibling);
    else hero.appendChild(box);
  }

  var loaded = null;
  var national = null;    // players/career/_national.json(全国の基準値)
  var painted = false;

  // #careerCard を指して来たとき、着地位置がずれるのを直す。
  // このカードはページの最後にあり、中身が入る前はページ自体が短いため、
  // ブラウザはアンカーへ飛ぼうとしてもスクロール量の上限で打ち切られる。
  // そのあと中身が入ってページが伸びても、スクロール位置は戻らない
  // (マイページの⭐から来ると数百px下にずれた状態になっていた)。
  // 描画が終わった時点で一度だけ位置を合わせ直す。
  // 位置合わせは2回に分ける。1回目は中身を入れた直後、2回目はブラウザ自身が
  // 遅れて行うアンカー移動のあと(そちらが後から上書きしてしまうため)。
  // 2回目は「まだずれている場合」だけ動かすので、読み終えて自分でスクロールした
  // 人の画面を勝手に動かすことはない。
  var anchorFixed = false;
  function fixAnchor() {
    if (anchorFixed || window.location.hash !== "#" + CARD_ID) return;
    anchorFixed = true;
    setTimeout(function () { card.scrollIntoView(); }, 0);
    setTimeout(function () {
      if (card.getBoundingClientRect().top > 40) card.scrollIntoView();
    }, 300);
  }

  function paint(premium) {
    if (!loaded) return;
    painted = true;
    body.innerHTML = render(loaded, premium) + (premium ? "" : gateHtml());
    fixAnchor();
  }

  // 全国の基準値。全選手で同じ内容なのでブラウザのキャッシュに任せる
  // (選手ページを見て回っても取得は1回で済む)。取れなくても本人の数字は
  // そのまま出すので、失敗は静かに握りつぶして null のままにする。
  var natReady = fetch("/players/career/_national.json")
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) { national = d; })
    .catch(function () { national = null; });

  Promise.all([
    fetch("/players/career/" + encodeURIComponent(toban) + ".json", { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      }),
    natReady,
  ])
    .then(function (res) {
      var doc = res[0];
      loaded = doc;
      renderTitleBadges(doc);   // 二つ名は無料(会員判定と無関係に出す)
      paint(false);   // まず無料部分を出す(会員判定を待たせない)
      if (!window.TeiyomiMembership) return;
      TeiyomiMembership.onChange(function (state) {
        paint(!!(state && state.active));
      });
    })
    .catch(function () {
      // データが無い選手・取得に失敗した場合は静かに済ませる(エラー表示にしない)。
      body.innerHTML = '<p class="cr-msg">この選手のキャリアのデータはまだありません。</p>';
    });

  // 会員判定がいつまでも返らない場合も、無料部分は出したままにする(何もしない)。
  setTimeout(function () {
    if (!painted && loaded) paint(false);
  }, 8000);
})();
