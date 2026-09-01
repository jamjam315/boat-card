// レースページに「予想を記録」欄を差し込む。
//
// ページ側に埋め込まれた <script type="application/json" id="raceSnapshot"> を
// 読み、そのレース要素まるごとを記録のスナップショットとして渡す。
// (data.js を取りに行かないのは、レースページが静的で自己完結しているため。
//  それに、あとから data.js を読むと「記録した日の数字」ではなくなる。)
//
// 保存は yomi.js(TeiyomiYomi)に任せる。ここは画面だけを受け持つ。
// yomi.js が読めていない・スナップショットが無い場合は、何も描かずに黙って
// 終わる(ページの他の部分は普通に読める)。
(function () {
  "use strict";

  var box = document.getElementById("yomiBox");
  var raw = document.getElementById("raceSnapshot");
  var Y = window.TeiyomiYomi;
  if (!box || !raw || !Y) return;

  var snap;
  try {
    snap = JSON.parse(raw.textContent);
  } catch (e) {
    return;
  }
  if (!snap || !snap.key) return;

  var closed = Y.isClosed(snap.date, snap.dl);
  var picked = [];          // 選んだ艇番(押した順)
  var ken = "3連単";        // いちばん買われる券種を初期値にする
  var open = false;

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function spec() {
    for (var i = 0; i < Y.KEN.length; i++) if (Y.KEN[i].id === ken) return Y.KEN[i];
    return Y.KEN[0];
  }

  /** 保存済みの一覧。P1-3で採点欄がここに増える。 */
  function listHtml() {
    var rows = Y.listByRace(snap.key);
    if (!rows.length) return "";
    return '<ul class="ylist">' + rows.map(function (r) {
      return '<li><span class="yken">' + esc(r.ken) + '</span>' +
        '<span class="ybet nums">' + esc(Y.betText(r.ken, r.lanes)) + '</span>' +
        (r.tag ? '<span class="ytag">' + esc(r.tag) + '</span>' : '') +
        '<span class="yamt nums">' + r.amount + '円</span>' +
        '<button class="ydel" data-id="' + esc(r.id) + '" aria-label="この記録を削除">×</button></li>';
    }).join("") + '</ul>';
  }

  function formHtml() {
    var s = spec();
    var kens = Y.KEN.map(function (k) {
      return '<button class="ychip' + (k.id === ken ? " on" : "") + '" data-ken="' +
        esc(k.id) + '">' + esc(k.label) + '</button>';
    }).join("");

    var lanes = "";
    for (var n = 1; n <= 6; n++) {
      var at = picked.indexOf(n);
      // 順番に意味がある券種は「何着に選んだか」を数字で出す。
      // 意味が無い券種は選択の有無だけ分かればよい。
      var mark = at === -1 ? "" : (s.ordered ? '<i>' + (at + 1) + '</i>' : '<i>✓</i>');
      lanes += '<button class="ylane l' + n + (at === -1 ? "" : " on") +
        '" data-lane="' + n + '">' + n + mark + '</button>';
    }

    var tags = Y.tags();
    var opts = tags.map(function (t) { return '<option value="' + esc(t) + '">'; }).join("");

    var need = s.n - picked.length;
    var hint = need > 0
      ? "あと" + need + "艇えらぶ"
      : "買い目 " + Y.betText(ken, picked);

    return '<div class="yform">' +
      '<div class="yrow ykens">' + kens + '</div>' +
      '<div class="yrow ylanes">' + lanes + '</div>' +
      '<div class="yhint' + (need > 0 ? "" : " ok") + '">' + esc(hint) + '</div>' +
      '<div class="yrow yin">' +
        '<input id="yTag" class="ytagin" type="text" placeholder="出所タグ（例: 1号艇軸）" ' +
          'maxlength="' + Y.MAX_TAG_LEN + '" list="yTagList" autocomplete="off">' +
        '<datalist id="yTagList">' + opts + '</datalist>' +
        '<input id="yAmt" class="yamtin nums" type="number" inputmode="numeric" ' +
          'value="100" min="100" step="100" aria-label="金額">' +
        '<span class="yyen">円</span>' +
      '</div>' +
      '<div class="yrow yamts">' +
        '<button class="ychip yq" data-amt="100">100</button>' +
        '<button class="ychip yq" data-amt="500">500</button>' +
        '<button class="ychip yq" data-amt="1000">1000</button>' +
      '</div>' +
      '<div class="yrow yact">' +
        '<button id="ySave" class="ysave"' + (need > 0 ? " disabled" : "") + '>記録する</button>' +
        '<button id="yCancel" class="ycancel">閉じる</button>' +
      '</div>' +
      '<p id="yMsg" class="ymsg" role="status"></p>' +
    '</div>';
  }

  function render() {
    var n = Y.listByRace(snap.key).length;
    var head = '<div class="yhead"><b>予想を記録</b>' +
      (n ? '<span class="ycount">' + n + '件</span>' : '') + '</div>';

    if (closed) {
      // 締切後は記録できないが、既に記録したものは読めるようにしておく。
      box.innerHTML = head + '<p class="yclosed">締切後は記録できません。</p>' + listHtml();
      bindList();
      return;
    }
    box.innerHTML = head +
      (open ? formHtml() : '<button id="yOpen" class="yopen">＋ 予想を記録</button>') +
      listHtml();
    bindList();
    if (open) bindForm(); else byId("yOpen").onclick = function () { open = true; render(); };
  }

  function byId(id) { return document.getElementById(id); }

  function bindList() {
    Array.prototype.forEach.call(box.querySelectorAll(".ydel"), function (b) {
      b.onclick = function () {
        if (Y.remove(b.getAttribute("data-id"))) render();
      };
    });
  }

  function bindForm() {
    Array.prototype.forEach.call(box.querySelectorAll(".ychip[data-ken]"), function (b) {
      b.onclick = function () {
        var next = b.getAttribute("data-ken");
        if (next === ken) return;
        ken = next;
        // 券種を変えると必要な艇数が変わる。選び直しのほうが分かりやすい。
        picked = [];
        keepAndRender();
      };
    });
    Array.prototype.forEach.call(box.querySelectorAll(".ylane"), function (b) {
      b.onclick = function () {
        var n = Number(b.getAttribute("data-lane"));
        var at = picked.indexOf(n);
        if (at !== -1) picked.splice(at, 1);          // もう一度押したら取り消し
        else if (picked.length < spec().n) picked.push(n);
        else return;                                  // 必要数に達していたら無視
        keepAndRender();
      };
    });
    Array.prototype.forEach.call(box.querySelectorAll(".yq"), function (b) {
      b.onclick = function () { byId("yAmt").value = b.getAttribute("data-amt"); };
    });
    byId("yCancel").onclick = function () { open = false; picked = []; render(); };
    byId("ySave").onclick = save;
  }

  /** 券種・艇番を押し直したときに、入力済みのタグと金額を保たせる。 */
  function keepAndRender() {
    var t = byId("yTag"), a = byId("yAmt");
    var tag = t ? t.value : "", amt = a ? a.value : "100";
    render();
    var t2 = byId("yTag"), a2 = byId("yAmt");
    if (t2) t2.value = tag;
    if (a2) a2.value = amt;
  }

  var REASON = {
    closed: "締切後は記録できません。",
    bad_bet: "買い目の形が正しくありません。",
    bad_amount: "金額を確かめてください。",
    bad_key: "このレースを特定できませんでした。",
    too_many: "記録が上限に達しました。古いものを消してください。",
    storage: "この端末に保存できませんでした（プライベートモード等）。"
  };

  function save() {
    var msg = byId("yMsg");
    var res = Y.add({
      key: snap.key,
      ken: ken,
      lanes: picked,
      tag: byId("yTag").value,
      amount: Number(byId("yAmt").value),
      deadline: snap.dl,
      // ここが企画の芯。記録した時点のレース要素をそのまま預ける。
      snapshot: snap
    });
    if (!res.ok) {
      msg.textContent = REASON[res.reason] || "記録できませんでした。";
      msg.className = "ymsg ng";
      // 締切をまたいだ場合は、以後の入力自体を閉じる。
      if (res.reason === "closed") { closed = true; setTimeout(render, 1200); }
      return;
    }
    open = false;
    picked = [];
    render();
  }

  render();
})();
