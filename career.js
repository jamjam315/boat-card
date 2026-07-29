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
      ".cr-note{font-size:11px; color:var(--muted); margin-top:10px; line-height:1.6;}" +
      ".cr-gate{background:var(--surface); border:1px solid var(--accent); border-radius:10px;" +
      "margin-top:14px; padding:14px 16px;}" +
      ".cr-gate h3{margin:0 0 6px; font-size:13.5px;}" +
      ".cr-gate p{margin:0; font-size:12.5px; color:var(--ink2); line-height:1.7;}" +
      ".cr-gate p.sub{margin-top:6px; font-size:11.5px; color:var(--muted);}" +
      ".cr-gate .cta{display:block; margin-top:12px; padding:11px; border-radius:9px;" +
      "background:var(--accent); color:#fff; font-size:13.5px; font-weight:700;" +
      "text-align:center; text-decoration:none;}";
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
      html += '<p class="cr-note">1着率＝1着数÷出走数、2連対率＝2着以内÷出走数。' +
        '「勝率（公式・点数）」は着順に応じた点数の平均で、1着率とは計算方法が異なります。</p>';
    } else {
      html += '<p class="cr-note">1着率＝1着数÷出走数、2連対率＝2着以内÷出走数。</p>';
    }
    return html;
  }

  function gateHtml() {
    return '<div class="cr-gate"><h3>この先はプレミアム限定です</h3>' +
      '<p>データがある全年の推移と、級別の変遷はプレミアムにご登録いただくとご覧いただけます。</p>' +
      '<p class="sub">直近' + FREE_YEARS + '年の成績は、これまで通り無料でご覧いただけます。</p>' +
      '<a class="cta" href="/premium/">プレミアムを見る</a></div>';
  }

  // ---- 読み込みと描画 ----
  ensureStyle();
  var body = document.getElementById("careerBody");
  var loaded = null;
  var painted = false;

  function paint(premium) {
    if (!loaded) return;
    painted = true;
    body.innerHTML = render(loaded, premium) + (premium ? "" : gateHtml());
  }

  fetch("/players/career/" + encodeURIComponent(toban) + ".json", { cache: "no-store" })
    .then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then(function (doc) {
      loaded = doc;
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
