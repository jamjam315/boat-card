// 今日の一問のドット再生(AI-14 v1⑤)。「スタート」を押したあと、結果と答案の前に流す。
//
// 【再生するのは実際の結果だけ】シミュレーションはしない。使う数字は出題ファイルの answer にある
// 競走成績の値だけ: 進入コース(in)・ST(st)・着順(order)・レースタイム(rt)。どれも艇番順。
//   1. 進入 … 枠番の並び → 実際に入ったコースの並びへ(縦に動く)
//   2. スタート … STの早い順にスタートラインを越える(越えたところにSTを出す)
//   3. ゴール … 着順どおりにゴールへ。着と着の間はレースタイムの差から(無い艇は前後の間を等間隔で埋める)
// ラインとラインの間は直線でつないでいる(実際の航跡ではない)。画面にもそう書く。
// 列(コース → 着順)の入れ替えは、スタートラインを越えた直後に短く(SWAP)済ませ、あとはまっすぐゴールへ。
// 進入の入れ替え(枠番 → コース)も、はじめの短い間(ENTRY_MOVE)で済ませて、残りは止めて見せる。
// ゴールまでずっと斜めに走らせると、入れ替わる艇どうし(並んで走る1着と2着など)が長く重なって
// 艇番が読めなかった(⑤b・375pxで実測)。ゴールする時刻と位置は変わらない。
// スタート展示は再生しない。完走しなかった艇のいるレースは再生しない(plan が null を返す。
// 出題の側でも6艇完走のレースしか選んでいない)。
//
// 【動きを減らす設定】prefers-reduced-motion: reduce のときは動かさず、最後の並びだけを出す。
// Web Animations API(element.animate)が無いブラウザも同じ扱い。
//
// 【部品】HTML の要素を並べて、それぞれに element.animate で位置を動かす(canvas は使わない)。
// 艇は「真上から見た小さなボート」のインラインSVG(オリジナルの図形・画像ファイルは使わない・⑤b)。
// 艇首は進行方向(右・ゴールの向き)。色は艇番の6色で、白と黒だけ細い縁取り。航跡・水しぶき・引き波は描かない
// (「実際の航跡ではない」ので、それらしく見せる演出を足さない)。
//   TeiyomiQuizReplay.plan(answer)                 … 時間割(テスト用にも出す)。再生できなければ null
//   TeiyomiQuizReplay.play(el, answer, opts)       … 再生。opts.lanes(艇の色)・opts.onDone(終わったら1回)
//   TeiyomiQuizReplay.showFinal(el, answer, opts)  … 最後の並びだけ(開き直したとき)。「再生する」付き
(function () {
  "use strict";

  // 再生の速さ。**ここ1か所で全体の長さを変える。** すべての時間にこの倍率を掛けるので、
  // 進入・スタート・ゴールの比率は変わらない。1 = 最初の版(約8〜9秒)。
  // 2026-09-19 JAM: 1.5倍ゆっくり(約12〜13秒)
  var SLOW = 1.5;
  function ms(x) { return Math.round(x * SLOW); }

  // 時間(ミリ秒・倍率を掛ける前の値で書く)。スタートまでの助走に、ST 1秒ぶんを SCALE_ST として足して、越える順と間を出す
  var T_ENTRY = ms(1000);         // 1. 進入
  var T_START = ms(1400);         // 2. スタートの助走を始める時刻
  var RUNUP = ms(900);            // 助走(ST 0 の艇がラインに着くまで)
  var SCALE_ST = ms(3000);        // ST 1.00秒 = 3秒で見せる(0.10秒の差 = 0.3秒)
  var AFTER_START = ms(300);      // 全艇が越えてからゴールへ向かうまでの間
  var TO_GOAL = ms(2600);         // ラインから1着がゴールするまで
  var GAP_MS_PER_SEC = ms(350);   // 着差: レースタイム1秒 = 0.35秒で見せる
  var GAP_MAX_MS = ms(2000);      // ただし1着から最下位までを2秒に収める
  var GAP_MIN_SEC = 0.2;          // 着の順を崩さないための最小の差(秒・レースタイムの単位)
  var HOLD = ms(700);             // 最後の並びを見せてから終わる
  var SWAP = ms(600);             // ラインを越えてから、着順の列へ移り終えるまで
  var ENTRY_MOVE = ms(600);       // 進入: 枠番の列からコースの列へ移り終えるまで(残りは止まって見せる。入れ替えで長く重ならないように)
  var FADE = ms(150);             // STの数字が出るまで
  var ST_SHOW = ms(900), ST_GONE = ms(1300);   // ゴールへ向かい始めてから、STを消し始める・消し終わる
  var RANK_IN = ms(200);          // 最後の艇がゴールする少し前に「n着」を出す

  // 画面の位置。横は %(幅に合わせて伸び縮み)、縦は px(6列)
  // 艇(幅34px)の後ろが左端で切れないよう、待機の位置は 7%
  var X_WAIT = 7, X_LINE = 27, X_GOAL = 80, X_RANK = 89;
  var TOP = 26, ROW = 30;

  function isPerm(a) {
    return Array.isArray(a) && a.length === 6 &&
      a.slice().sort().join(",") === "1,2,3,4,5,6";
  }
  function isNum(x) { return typeof x === "number" && isFinite(x); }
  function rowTop(r) { return TOP + (r - 1) * ROW + 11; }

  /**
   * 着順ごとの着差(秒)。1着のタイムからの差。無いところは前後の間を等間隔で埋め、
   * 後ろが無ければそれまでの1着ぶんの平均の差で伸ばす。1着のタイムが無ければ全部等間隔(1秒)。
   */
  function gaps(order, rt) {
    var byRank = [];
    for (var k = 1; k <= 6; k++) {
      var boat = order.indexOf(k) + 1;
      byRank.push(isNum(rt[boat - 1]) ? rt[boat - 1] : null);
    }
    var g = byRank.map(function () { return null; });
    if (byRank[0] == null) return { sec: [0, 1, 2, 3, 4, 5], filled: true };
    var filled = false;
    for (var i = 0; i < 6; i++) if (byRank[i] != null) g[i] = byRank[i] - byRank[0];
    var lastKnown = 0;
    for (i = 1; i < 6; i++) if (g[i] != null) lastKnown = i;
    var step = lastKnown > 0 ? g[lastKnown] / lastKnown : 1;
    if (!(step > 0)) step = 1;
    for (i = 1; i < 6; i++) {
      if (g[i] != null) continue;
      filled = true;
      var next = -1;
      for (var j = i + 1; j < 6; j++) if (g[j] != null) { next = j; break; }
      g[i] = next === -1 ? g[i - 1] + step : g[i - 1] + (g[next] - g[i - 1]) / (next - i + 1);
    }
    for (i = 1; i < 6; i++) if (g[i] < g[i - 1] + GAP_MIN_SEC) g[i] = g[i - 1] + GAP_MIN_SEC;
    return { sec: g, filled: filled };
  }

  /** 時間割。完走しなかった艇がいる・数字が崩れているなら null(再生しない)。 */
  function plan(A) {
    if (!A || !isPerm(A.order) || !isPerm(A["in"]) || !Array.isArray(A.st) || A.st.length !== 6) return null;
    if (!A.st.every(function (x) { return isNum(x) && x >= 0 && x < 1; })) return null;
    var rt = Array.isArray(A.rt) && A.rt.length === 6 ? A.rt : [null, null, null, null, null, null];
    var gp = gaps(A.order, rt);
    var maxGap = gp.sec[5] || 0;
    var scale = maxGap > 0 ? Math.min(GAP_MS_PER_SEC, GAP_MAX_MS / maxGap) : GAP_MS_PER_SEC;

    var boats = [];
    var lastLine = 0;
    for (var n = 1; n <= 6; n++) {
      var tLine = T_START + RUNUP + Math.round(A.st[n - 1] * SCALE_ST);
      if (tLine > lastLine) lastLine = tLine;
      boats.push({ n: n, lane: n, course: A["in"][n - 1], rank: A.order[n - 1], st: A.st[n - 1], tLine: tLine });
    }
    var tGo = lastLine + AFTER_START;
    var end = 0;
    boats.forEach(function (b) {
      b.tArr = tGo + TO_GOAL + Math.round(gp.sec[b.rank - 1] * scale);
      // 列の入れ替えを終える時刻と、そのときの横の位置(ラインからゴールまでの直線の上)
      b.tSwap = b.tLine + SWAP;
      b.xSwap = Math.round((X_LINE + (X_GOAL - X_LINE) * SWAP / (b.tArr - b.tLine)) * 100) / 100;
      if (b.tArr > end) end = b.tArr;
    });
    return {
      boats: boats, tEntry: T_ENTRY, tStart: T_START, tGo: tGo, tEnd: end, total: end + HOLD,
      gapFilled: gp.filled,
      entryChanged: boats.some(function (b) { return b.course !== b.lane; })
    };
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function stText(st) { return "." + String(Math.round(st * 100)).padStart(2, "0"); }

  /**
   * 真上から見た小さなボート(34×18)。艇首は右。色は艇番の色、白(1)と黒(2)だけ細い縁取り。
   * 船尾に小さくモーターの影を置いて、ボートと読めるようにする。数字は艇体の後ろ寄りに。
   */
  function boatSvg(n, c) {
    var stroke = n === 1 ? ' stroke="#5a5a5a" stroke-width="1"' : n === 2 ? ' stroke="#b5b5b5" stroke-width="1"' : "";
    return '<svg viewBox="0 0 34 18" width="34" height="18" aria-hidden="true" focusable="false">' +
      '<rect x="0.5" y="6.5" width="3" height="5" rx="1" fill="#6b6b6b"/>' +
      '<path d="M3 2.5 H21 Q30.5 2.5 33 9 Q30.5 15.5 21 15.5 H3 Z" fill="' + esc(c[0]) + '"' + stroke + '/>' +
      '<text x="15" y="9.6" text-anchor="middle" dominant-baseline="middle" font-size="11" font-weight="700" fill="' +
        esc(c[1]) + '">' + n + '</text>' +
    '</svg>';
  }

  /** 再生の枠を描く。点は最後の並び(ゴール・着順の列)に置いておく。 */
  function frame(el, P, lanes) {
    var order = P.boats.slice().sort(function (a, b) { return a.rank - b.rank; });
    var label = "最後の並び: " + order.map(function (b) { return b.rank + "着 " + b.n + "号艇"; }).join("、");
    var dots = P.boats.map(function (b) {
      var c = (lanes && lanes[b.n]) || ["#888", "#fff"];
      // 重なったときは着順の良い艇を上に描く(抜いた艇の艇番が読めるように)
      return '<span class="q-rp-dot" data-n="' + b.n + '" style="left:' + X_GOAL + '%;top:' + rowTop(b.rank) +
        'px;z-index:' + (10 - b.rank) + '">' +
        boatSvg(b.n, c) + '</span>' +
        // STはラインの手前(左)に、艇の半分の長さより離して出す(CSS の translateX)。
        // 出るのはその艇がラインを越えたあとなので、船尾と重ならない。越えた列(コース)に残るので、
        // 艇が着順の列へ移ったあとも取り違えないよう艇番を添える(「6 .24」)
        '<span class="q-rp-st nums" data-n="' + b.n + '" style="left:' + X_LINE + '%;top:' + rowTop(b.course) + 'px">' +
        '<b>' + b.n + '</b> ' + esc(stText(b.st)) + '</span>';
    }).join("");
    var ranks = "";
    for (var r = 1; r <= 6; r++) {
      ranks += '<span class="q-rp-rank" style="left:' + X_RANK + '%;top:' + rowTop(r) + 'px">' + r + '着</span>';
    }
    el.innerHTML = '<div class="card q-rp">' +
      '<div class="card-head"><div class="ttl">レースの再生</div>' +
        '<button type="button" class="q-rp-btn" id="quizReplayBtn"></button></div>' +
      '<p class="q-rp-cap" id="quizReplayCap" aria-live="polite"></p>' +
      '<div class="q-rp-track" role="img" aria-label="' + esc(label) + '">' +
        '<div class="q-rp-line" style="left:' + X_LINE + '%"><span>スタート</span></div>' +
        '<div class="q-rp-line" style="left:' + X_GOAL + '%"><span>ゴール</span></div>' +
        ranks + dots +
      '</div>' +
      '<p class="q-rp-note">進入・ST・着順・レースタイムは競走成績の値です。' +
        'ラインとラインの間は直線でつないだもので、実際の航跡ではありません' +
        (P.gapFilled ? '（タイムの無い艇の着差は、前後の間を等間隔で埋めています）' : '') + '。</p>' +
    '</div>';
  }

  function reduced() {
    try {
      return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    } catch (e) { return false; }
  }

  /** 最後の並びだけを出す。canReplay なら「再生する」を付ける。 */
  function showFinal(el, A, opts) {
    opts = opts || {};
    var P = plan(A);
    if (!P) { el.hidden = true; el.innerHTML = ""; return false; }
    el.hidden = false;
    frame(el, P, opts.lanes);
    Array.prototype.forEach.call(el.querySelectorAll(".q-rp-rank"), function (x) { x.style.opacity = 1; });
    var cap = el.querySelector("#quizReplayCap");
    var btn = el.querySelector("#quizReplayBtn");
    var still = reduced() || typeof el.animate !== "function";
    cap.textContent = still ? "最後の並び（動きを減らす設定のため、動かしていません）" : "最後の並び";
    if (still) btn.hidden = true;
    else {
      btn.textContent = "再生する";
      btn.onclick = function () { play(el, A, { lanes: opts.lanes }); };
    }
    return true;
  }

  /** 再生する。終わったら(とばしても)opts.onDone を1回だけ呼ぶ。再生できなければ false。 */
  function play(el, A, opts) {
    opts = opts || {};
    var P = plan(A);
    if (!P) { el.hidden = true; el.innerHTML = ""; return false; }
    var done = false;
    function finishOnce() {
      if (done) return;
      done = true;
      if (opts.onDone) opts.onDone();
    }
    if (reduced() || typeof el.animate !== "function") {
      showFinal(el, A, opts);
      finishOnce();
      return true;
    }

    el.hidden = false;
    frame(el, P, opts.lanes);
    var cap = el.querySelector("#quizReplayCap");
    var btn = el.querySelector("#quizReplayBtn");
    var T = P.total;
    var anims = [], timers = [];
    function off(t) { return Math.min(1, Math.max(0, t / T)); }

    P.boats.forEach(function (b) {
      var dot = el.querySelector('.q-rp-dot[data-n="' + b.n + '"]');
      var st = el.querySelector('.q-rp-st[data-n="' + b.n + '"]');
      var yLane = rowTop(b.lane) + "px", yCourse = rowTop(b.course) + "px", yRank = rowTop(b.rank) + "px";
      anims.push(dot.animate([
        { offset: 0, left: X_WAIT + "%", top: yLane },
        { offset: off(ENTRY_MOVE), left: X_WAIT + "%", top: yCourse },
        { offset: off(P.tEntry), left: X_WAIT + "%", top: yCourse },
        { offset: off(P.tStart), left: X_WAIT + "%", top: yCourse },
        { offset: off(b.tLine), left: X_LINE + "%", top: yCourse },
        { offset: off(b.tSwap), left: b.xSwap + "%", top: yRank },
        { offset: off(b.tArr), left: X_GOAL + "%", top: yRank },
        { offset: 1, left: X_GOAL + "%", top: yRank }
      ], { duration: T, easing: "linear", fill: "both" }));
      // STはラインを越えたところで出し、ゴールへ向かう間に消す
      anims.push(st.animate([
        { offset: 0, opacity: 0 },
        { offset: off(b.tLine), opacity: 0 },
        { offset: off(b.tLine + FADE), opacity: 1 },
        { offset: off(P.tGo + ST_SHOW), opacity: 1 },
        { offset: off(P.tGo + ST_GONE), opacity: 0 },
        { offset: 1, opacity: 0 }
      ], { duration: T, easing: "linear", fill: "both" }));
    });
    Array.prototype.forEach.call(el.querySelectorAll(".q-rp-rank"), function (x) {
      anims.push(x.animate([
        { offset: 0, opacity: 0 }, { offset: off(P.tEnd - RANK_IN), opacity: 0 }, { offset: 1, opacity: 1 }
      ], { duration: T, easing: "linear", fill: "both" }));
    });

    function say(t, text) { timers.push(setTimeout(function () { cap.textContent = text; }, t)); }
    say(0, P.entryChanged ? "進入（枠番の並び → 実際に入ったコース）" : "進入（枠なり）");
    say(P.tStart, "スタート（STの早い順にラインを越える）");
    say(P.tGo, "ゴールへ（着順どおり・着差はレースタイムから）");
    say(P.tEnd, "結果");

    // 終わり方は3つ(自然に終わる・とばす・時間切れ)。どれで来ても1回だけ片づける。
    // 終わりの合図を onfinish だけに頼らない: 画面が描かれていない間(裏のタブ等)は onfinish が来ず、
    // 結果と答案がいつまでも出ないことになる(手元の確認で実際に起きた)
    var ended = false;
    function end() {
      if (ended) return;
      ended = true;
      timers.forEach(clearTimeout);
      anims.forEach(function (a) { try { a.finish(); } catch (e) { /* 終わっている */ } });
      cap.textContent = "結果";
      btn.textContent = "もう一度";
      btn.onclick = function () { play(el, A, { lanes: opts.lanes }); };
      finishOnce();
    }
    btn.textContent = "とばす";
    btn.onclick = end;
    anims[0].onfinish = end;
    timers.push(setTimeout(end, T + 150));
    return true;
  }

  window.TeiyomiQuizReplay = { plan: plan, play: play, showFinal: showFinal, SLOW: SLOW,
    X_LINE: X_LINE, X_GOAL: X_GOAL };
})();
