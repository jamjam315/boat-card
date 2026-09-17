// 買い目を記録する欄(部品)と、レースページへの差し込み。
//
// 【部品】TeiyomiYomiRecord.mount(box, store, opts)
//   box   … 欄を描く要素
//   store … 記録の置き場。list() / countByTag() / tags() / add({ken, lanes, tag, amount}) /
//           remove(id) / isClosed() を持つ。add は {ok:true} か {ok:false, reason} を返す
//   opts  … 見出し・件数の呼び名・締切後の文言(省略時はレースページと同じ)、
//           lockWhenClosed(締切後は一覧の削除ボタンも出さない)、onChange(描き直すたびに呼ぶ)
// レースページ(下)は端末の読み採点の記録(yomi.js)を、今日の一問(quiz.js)は出題日ごとの
// 記録を store として渡す。欄の見た目と操作は同じものを使う。
//
// 【レースページ】ページ側に埋め込まれた <script type="application/json" id="raceSnapshot"> を
// 読み、そのレース要素まるごとを記録のスナップショットとして渡す。
// (data.js を取りに行かないのは、レースページが静的で自己完結しているため。
//  それに、あとから data.js を読むと「記録した日の数字」ではなくなる。)
// 保存は yomi.js(TeiyomiYomi)に任せる。ここは画面だけを受け持つ。
// yomi.js が読めていない・スナップショットが無い場合は、何も描かずに黙って
// 終わる(ページの他の部分は普通に読める)。
//
// 部品をこのファイルの中に置いているのは、7日分残っている古いレースページが
// このファイルだけを読んでいるため(別ファイルに分けると、古いページが部品を読めずに欄が消える)。
(function () {
  "use strict";

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function mount(box, store, opts) {
    var Y = window.TeiyomiYomi;
    opts = opts || {};
    var TITLE = opts.title || "予想を記録";
    var SCOPE = opts.scopeLabel || "このレース";
    var OPEN_LABEL = opts.openLabel || "＋ 予想を記録";
    var CLOSED_TEXT = opts.closedText || "締切後は記録できません。";
    // レースページは締切後も記録を消せる(自分の記録の整理)。今日の一問は結果を見たあとに
    // 買い目を消すと答案が変わってしまうので、締切後は消せなくする
    var LOCK_WHEN_CLOSED = !!opts.lockWhenClosed;

    var closed = store.isClosed();
    var picked = [];          // 選んだ艇番(押した順)
    var ken = "3連単";        // いちばん買われる券種を初期値にする
    var open = false;

    function spec() {
      for (var i = 0; i < Y.KEN.length; i++) if (Y.KEN[i].id === ken) return Y.KEN[i];
      return Y.KEN[0];
    }

    /** 保存済みの一覧。P1-3で採点欄がここに増える。 */
    function listHtml() {
      var rows = store.list();
      if (!rows.length) return "";
      return '<ul class="ylist">' + rows.map(function (r) {
        return '<li><span class="yken">' + esc(r.ken) + '</span>' +
          '<span class="ybet nums">' + esc(Y.betText(r.ken, r.lanes)) + '</span>' +
          (r.tag ? '<span class="ytag">' + esc(r.tag) + '</span>' : '') +
          '<span class="yamt nums">' + r.amount + '円</span>' +
          (closed && LOCK_WHEN_CLOSED ? '' : '<button class="ydel" data-id="' + esc(r.id) + '" aria-label="この記録を削除">×</button>') +
          '</li>';
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

      var tags = store.tags();
      var tagOpts = tags.map(function (t) { return '<option value="' + esc(t) + '">'; }).join("");

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
          '<datalist id="yTagList">' + tagOpts + '</datalist>' +
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
      var n = store.list().length;
      // 出所タグごとの内訳も出す。上限が「1レース×1出所タグ」なので、
      // どの読みであと何点記録できるかが分かる形にしておく。
      var byTag = store.countByTag();
      var parts = Object.keys(byTag).map(function (t) {
        return esc(t || "タグなし") + " " + byTag[t];
      });
      var head = '<div class="yhead"><b>' + esc(TITLE) + '</b>' +
        (n ? '<span class="ycount">' + esc(SCOPE) + ': ' + n + '件' +
          (parts.length > 1 ? '（' + parts.join('・') + '）' : '') + '</span>' : '') +
        '</div>';

      if (closed) {
        // 締切後は記録できないが、既に記録したものは読めるようにしておく。
        box.innerHTML = head + '<p class="yclosed">' + esc(CLOSED_TEXT) + '</p>' + listHtml();
        bindList();
        if (opts.onChange) opts.onChange();
        return;
      }
      box.innerHTML = head +
        (open ? formHtml() : '<button id="yOpen" class="yopen">' + esc(OPEN_LABEL) + '</button>') +
        listHtml();
      bindList();
      if (open) bindForm(); else byId("yOpen").onclick = function () { open = true; render(); };
      if (opts.onChange) opts.onChange();
    }

    function byId(id) { return document.getElementById(id); }

    function bindList() {
      Array.prototype.forEach.call(box.querySelectorAll(".ydel"), function (b) {
        b.onclick = function () {
          if (store.remove(b.getAttribute("data-id"))) render();
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
      closed: CLOSED_TEXT,
      bad_bet: "買い目の形が正しくありません。",
      bad_amount: "金額を確かめてください。",
      bad_key: "このレースを特定できませんでした。",
      too_many: "記録が上限に達しました。古いものを消してください。",
      too_many_here: SCOPE + "・この出所は" + Y.MAX_PER_RACE_TAG + "点まで記録できます。",
      storage: "この端末に保存できませんでした（プライベートモード等）。"
    };

    function save() {
      var msg = byId("yMsg");
      var res = store.add({
        ken: ken,
        lanes: picked,
        tag: byId("yTag").value,
        amount: Number(byId("yAmt").value)
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
    return {
      /** 記録を締め切る(今日の一問で「スタート」を押したとき)。 */
      close: function () { closed = true; open = false; picked = []; render(); },
      render: render
    };
  }

  window.TeiyomiYomiRecord = { mount: mount };

  // ---- レースページ ----
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

  mount(box, {
    list: function () { return Y.listByRace(snap.key); },
    countByTag: function () { return Y.countByTag(snap.key); },
    tags: function () { return Y.tags(); },
    remove: function (id) { return Y.remove(id); },
    isClosed: function () { return Y.isClosed(snap.date, snap.dl); },
    add: function (x) {
      return Y.add({
        key: snap.key,
        ken: x.ken,
        lanes: x.lanes,
        tag: x.tag,
        amount: x.amount,
        deadline: snap.dl,
        // ここが企画の芯。記録した時点のレース要素をそのまま預ける。
        snapshot: snap
      });
    }
  });
})();
