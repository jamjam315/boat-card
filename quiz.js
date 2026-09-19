// 今日の一問(過去の実レースで読む練習)のページ本体。AI-14 v1④。
//
// 流れ: 出題(quiz/{出題日}.json の question)を読む → 買い目を記録する(yomi-race.js の記録欄) →
//       「スタート」で記録を締め切り、結果(answer)と答案(yomi-paper.js)とつづきを出す。
// 採点は読み採点と同じエンジン(yomi.js)。{...answer, wx: question.wx} を払戻として scoreOne に、
// {boats: question.boats} をスナップショットとして buildPaper に渡す。
//
// 【文字は必ず esc() を通す】出題ファイルの文字列(会場・種別・選手名・級・支部・気象など)は
// すべて esc() を通して描く。数値は数値であることを確かめてから桁をそろえて出す。
//
// 【端末の保存】localStorage の teiyomi_quiz_v1 に、出題日ごとに {records, revealed, ai} を持つ。
// 実レースの読み採点の記録(teiyomi_yomi_records)とは混ぜない(マイページの成績に入れないため)。
// AI講評も出題日ごとに残し、開き直しても送り直さない(回数は減らない)。
//
// 【持ち点】1問あたり持ち点1,000円・100円単位・10点まで(2026-09-18 便D)。超える記録は受け付けず、
// 残りを出す。スタートは1点以上で押せる(使い切らなくてよい)。答案は「持ち点 1,000円 → 最後の持ち点（増減）」を
// 主に出し、使わなかったぶんは手元に残る扱い(最後の持ち点 = 1,000 − 使った額 + 払戻)。
// **持ち点の数字を「回収率」と呼ばない。** 回収率はサイト内で「払戻 ÷ 賭け金」の1つだけ(答案にも同じ定義で並べる)。
// 先々ランキング(v2)を作るときも、副指標は「持ち点の増減」の名前で出す(2026-09-18 JAM)。
//
// 【実績(AI-15)】スタートを押した時点の答案から「その日の点のまとめ」(daySummary)を作り、
// 通算の記録(quiz-badges.js・消さない)へ1件足す。新しく付いた実績は答案の下に1行で出す。
// 上部には「解いた問・いまの連続(最長)」を1行。9/17以降に解いてまとめの無い日は、開いたときに一度だけ作る。
//
// 【スタート】記録を締め切り、ドット再生(quiz-replay.js・⑤)を流してから結果と答案を出す。
// 再生できないレース(完走しなかった艇がいる等)や、読み込めなかったときは、すぐ結果と答案を出す。
// 開き直したとき(スタート済み)は、最後の並びと「再生する」を出す。
(function () {
  "use strict";

  var STORE_KEY = "teiyomi_quiz_v1";
  var KEEP_DAYS = 60;          // 端末に残す出題日の数(古いものから消す)
  var BUDGET = 1000;           // 1問あたりの持ち点(円)
  var UNIT = 100;              // 記録は100円単位
  var MAX_PER_QUIZ = 10;       // 1問あたりの買い目の上限(持ち点1,000円 ÷ 100円)
  var JST_MS = 9 * 3600000;
  var LANES = {
    1: ["#ffffff", "#1a1a1a"], 2: ["#2b2b2b", "#ffffff"], 3: ["#d83a36", "#ffffff"],
    4: ["#2f6fd0", "#ffffff"], 5: ["#f2c200", "#3a2e00"], 6: ["#1f9e54", "#ffffff"]
  };
  var MEASURED_NOTE = "競走成績に記録された、レース時点の値です。";
  var FIRST_DATE = "2026-09-17";   // 今日の一問の始まり。これより前の日は実績の元にしない

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function isNum(x) { return typeof x === "number" && isFinite(x); }
  function num(x, d) { return isNum(x) ? x.toFixed(d) : "—"; }

  function todayJst(nowMs) {
    return new Date((typeof nowMs === "number" ? nowMs : Date.now()) + JST_MS).toISOString().slice(0, 10);
  }
  function isDate(s) { return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s); }

  /** 開く出題日。?d=YYYY-MM-DD は今日以前だけ受け付ける(先の出題は開かない)。 */
  function pickDate(search, today) {
    var m = /[?&]d=(\d{4}-\d{2}-\d{2})(?:&|#|$)/.exec(String(search || ""));
    var d = m ? m[1] : null;
    return isDate(d) && d <= today ? d : today;
  }

  function mdLabel(date) {
    return Number(date.slice(5, 7)) + "月" + Number(date.slice(8, 10)) + "日";
  }

  // ---------------------------------------------------------------- 端末の保存

  function readAllDays(ls) {
    try {
      var o = JSON.parse(ls.getItem(STORE_KEY) || "null");
      if (o && o.days && typeof o.days === "object" && !Array.isArray(o.days)) return o;
    } catch (e) { /* 壊れていたら無かったことにする */ }
    return { v: 1, days: {} };
  }

  function writeAllDays(ls, o) {
    var keys = Object.keys(o.days).filter(isDate).sort();
    while (keys.length > KEEP_DAYS) delete o.days[keys.shift()];
    try {
      ls.setItem(STORE_KEY, JSON.stringify(o));
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * 1つの出題日の記録の置き場。記録欄(TeiyomiYomiRecord.mount)に store として渡せる形。
   * reveal() を呼ぶと記録は締め切られ、以後は足すことも消すこともできない。
   */
  function dayStore(ls, date, Y) {
    function load() {
      var o = readAllDays(ls);
      var d = o.days[date];
      if (!d || typeof d !== "object") d = { records: [], revealed: false };
      if (!Array.isArray(d.records)) d.records = [];
      return { o: o, d: d };
    }
    function save(x) {
      x.o.days[date] = x.d;
      return writeAllDays(ls, x.o);
    }
    function valid(r) {
      return r && typeof r.id === "string" && Y.isBet(r.ken, r.lanes) &&
        isNum(r.amount) && r.amount > 0 && r.amount <= Y.MAX_AMOUNT;
    }
    function records() { return load().d.records.filter(valid); }
    function spentOf(list) { return list.reduce(function (s, r) { return s + r.amount; }, 0); }

    return {
      list: records,
      countByTag: function () {
        var c = Object.create(null);   // 出所タグで数える入れ物は素の辞書(yomi.js の tags() と同じ理由)
        records().forEach(function (r) { var t = r.tag || ""; c[t] = (c[t] || 0) + 1; });
        return c;
      },
      /** 出所タグの候補。今日の一問で使ったものと、読み採点で使ったものを合わせる。 */
      tags: function () {
        var c = Object.create(null);
        var all = readAllDays(ls).days;
        Object.keys(all).forEach(function (k) {
          ((all[k] && all[k].records) || []).forEach(function (r) {
            if (r && r.tag) c[r.tag] = (c[r.tag] || 0) + 1;
          });
        });
        var mine = Object.keys(c).sort(function (a, b) { return c[b] - c[a]; });
        var other = (Y.tags ? Y.tags() : []).filter(function (t) { return !c[t]; });
        return mine.concat(other);
      },
      isClosed: function () { return !!load().d.revealed; },
      /** スタートを押した時刻(ISO)。まだなら null。 */
      revealedAt: function () { var d = load().d; return d.revealed && typeof d.revealedAt === "string" ? d.revealedAt : null; },
      /** 持ち点。記録欄(opts.budget)と答案(1,000円基準)が使う。 */
      budget: function () {
        var list = records(), spent = spentOf(list);
        return { total: BUDGET, unit: UNIT, max: MAX_PER_QUIZ, spent: spent,
          left: Math.max(0, BUDGET - spent), points: list.length };
      },
      add: function (x) {
        var cur = load();
        if (cur.d.revealed) return { ok: false, reason: "closed" };
        if (!Y.isBet(x.ken, x.lanes)) return { ok: false, reason: "bad_bet" };
        var amount = Number(x.amount);
        if (!isFinite(amount) || amount <= 0 || amount > Y.MAX_AMOUNT) return { ok: false, reason: "bad_amount" };
        if (amount % UNIT !== 0) return { ok: false, reason: "bad_unit" };
        var have = cur.d.records.filter(valid);
        if (have.length >= MAX_PER_QUIZ) return { ok: false, reason: "too_many_here" };
        // 持ち点を超える記録は受け付けない。残りを返して画面に出させる
        var left = BUDGET - spentOf(have);
        if (amount > left) return { ok: false, reason: "over_budget", left: Math.max(0, left) };
        cur.d.records.push({
          id: String(Date.now()) + "-" + Math.random().toString(36).slice(2, 8),
          at: new Date().toISOString(),
          ken: x.ken,
          lanes: x.lanes.slice(),
          tag: String(x.tag || "").slice(0, Y.MAX_TAG_LEN),
          amount: Math.floor(amount)
        });
        return save(cur) ? { ok: true } : { ok: false, reason: "storage" };
      },
      remove: function (id) {
        var cur = load();
        if (cur.d.revealed) return false;
        var n = cur.d.records.length;
        cur.d.records = cur.d.records.filter(function (r) { return r.id !== id; });
        return cur.d.records.length !== n && save(cur);
      },
      /** スタート。記録を締め切る。 */
      reveal: function () {
        var cur = load();
        if (!cur.d.revealed) {
          cur.d.revealed = true;
          cur.d.revealedAt = new Date().toISOString();
        }
        return save(cur);
      },
      ai: function () { return load().d.ai || null; },
      setAi: function (ai) {
        var cur = load();
        cur.d.ai = { text: String(ai.text || ""), model: String(ai.model || ""), at: new Date().toISOString() };
        return save(cur);
      },
      setAiReported: function () {
        var cur = load();
        if (!cur.d.ai) return false;
        cur.d.ai.reported = true;
        return save(cur);
      }
    };
  }

  // ---------------------------------------------------------------- 出題の形

  /** 出題ファイルとして使える形か(崩れていたら出さない)。 */
  function isQuiz(q) {
    var Q = q && q.question, A = q && q.answer;
    return !!(Q && A && isDate(q.date) && Array.isArray(Q.boats) && Q.boats.length === 6 &&
      Q.wx && Array.isArray(A.order) && A.order.length === 6 && A.pay && typeof A.key === "string");
  }

  // ---------------------------------------------------------------- 出題を描く

  function laneBadge(n, cls) {
    var L = LANES[n] || ["#ccc", "#111"];
    return '<span class="' + cls + '" style="background:' + L[0] + ';color:' + L[1] + '">' + esc(n) + '</span>';
  }

  function fBadge(f) {
    if (!isNum(f) || f <= 0) return "";
    return '<span class="fbadge" title="F＝フライング(スタート事故)。直近半年でF' + esc(f) +
      '回。持っていると次のスタートを警戒し慎重になりやすい">F' + esc(f) + '</span>';
  }

  /** 当地勝率。レースページ(build_race_pages.py の lw_display)と同じ見分け方。 */
  function lwHtml(b) {
    if (!isNum(b.lw)) return '<div class="v">—</div>';
    if (b.lw === 0) {
      if (!b.lwn) {
        return b.sn === 0 ? '<div class="v lwthin">当地初</div>'
          : '<div class="v lwthin lwnodata">当地データなし</div>';
      }
      if (b.lwn < 10) return '<div class="v lwthin">0.00</div>';
    }
    return '<div class="v">' + b.lw.toFixed(2) + '</div>';
  }

  function nums(list) {
    return (Array.isArray(list) ? list : []).filter(isNum);
  }

  /** 今節/直近の進入の傾向(レースページの course_hint と同じ基準)。 */
  function courseHint(ks) {
    var c = nums(ks && ks.c), r = Array.isArray(ks && ks.r) ? ks.r : [];
    if (r.length < 2 || !c.length) return null;
    var avg = c.reduce(function (a, b) { return a + b; }, 0) / c.length;
    if (avg <= 2.0) return "進入ほぼイン";
    if (avg >= 4) return "進入は外めが多い";
    return null;
  }

  function konHtml(ks) {
    var label = (ks && typeof ks.which === "string" && ks.which) || "今節";
    var r = Array.isArray(ks && ks.r) ? ks.r : [];
    if (!r.length) return '<div class="kon thin">' + esc(label) + 'の走行データが見当たりません</div>';
    if (r.length < 2) return '<div class="kon thin">' + esc(label) + 'データ少なめ（' + r.length + '走）</div>';
    var flow = r.slice(-3).map(function (c) { return isNum(c) && c <= 3 ? c + "着" : "着外"; }).join("→");
    var hint = courseHint(ks);
    var tail = r.length < 4 ? '<span class="thin">（' + esc(label) + r.length + '走）</span>' : "";
    return '<div class="kon"><b>' + esc(label) + '</b> ' + esc(flow) + (hint ? " / " + esc(hint) : "") + " " + tail + '</div>';
  }

  /** 今節/直近のST平均(読み点の「平均ST」と同じ数字)。 */
  function avgSt(ks) {
    var s = nums(ks && ks.s);
    if (!s.length) return null;
    return s.reduce(function (a, b) { return a + b; }, 0) / s.length;
  }

  function wxText(wx) {
    var parts = [];
    if (wx["天候"]) parts.push(esc(wx["天候"]));
    if (wx["風向"] || isNum(wx["風速"])) {
      parts.push((wx["風向"] ? esc(wx["風向"]) + "の風 " : "風 ") + (isNum(wx["風速"]) ? wx["風速"] + "m" : "—"));
    }
    parts.push("波高 " + (isNum(wx["波高"]) ? wx["波高"] + "cm" : "—"));
    return parts.join("・");
  }

  function questionHtml(q) {
    var Q = q.question;
    var head = [];
    if (Q.kind) head.push(esc(Q.kind));
    if (isNum(Q.dist)) head.push(Q.dist + "m");
    if (Q.fixed === true) head.push("進入固定");

    var cmpRows = Q.boats.map(function (b) {
      var st = avgSt(b.ks);
      var hint = courseHint(b.ks);
      return '<tr><td class="cmp-boat">' + laneBadge(b.n, "cmp-lane") + '</td>' +
        '<td class="cmp-nm"><span class="cmp-nm-txt">' + esc(b.name) + '</span>' + fBadge(b.f) + '</td>' +
        '<td class="cmp-course-col">' + (hint === "進入ほぼイン" ? "内" : hint === "進入は外めが多い" ? "外" : '<span class="cmp-course-na">—</span>') + '</td>' +
        '<td class="nums cmp-num">' + num(b.nw, 2) + '</td>' +
        '<td class="nums cmp-num">' + (isNum(b.mo) ? Math.round(b.mo) + "%" : "—") + '</td>' +
        '<td class="nums cmp-num">' + (st == null ? "—" : st.toFixed(2)) + '</td>' +
        '<td class="nums cmp-num q-ex">' + num(b.ex, 2) + '</td></tr>';
    }).join("");

    var boats = Q.boats.map(function (b) {
      var mo = isNum(b.mo) ? Math.round(b.mo * 10) / 10 : 0;
      var st = avgSt(b.ks);
      var meta = [];
      if (isNum(b.age)) meta.push(b.age + "歳");
      if (b.br) meta.push(esc(b.br));
      if (isNum(b.wt)) meta.push(b.wt + "kg");
      return '<div class="boat">' +
        '<div class="badge" style="background:' + (LANES[b.n] || ["#ccc"])[0] + ';color:' + (LANES[b.n] || ["", "#111"])[1] + '">' + esc(b.n) + '</div>' +
        '<div>' +
          '<div class="bname">' + esc(b.name) +
            (b.k ? '<span class="bk term" title="級別＝選手のランク。強い順にA1＞A2＞B1＞B2">' + esc(b.k) + '</span>' : '') +
            fBadge(b.f) + '</div>' +
          '<div class="bmeta">' + meta.join(" ・ ") +
            (st == null ? "" : ' ・ <span class="term" title="平均ST＝' + esc((b.ks && b.ks.which) || "今節") + 'のスタートタイミングの平均。0に近いほど早い">平均ST ' + st.toFixed(2) + '</span>') +
            ' ・ <span class="q-exm">展示 ' + num(b.ex, 2) + '</span></div>' +
          konHtml(b.ks) +
        '</div>' +
        '<div class="stats nums">' +
          '<div class="stat nw"><div class="l term" title="全国勝率＝全国での成績を点数化した競艇独自の指数(％ではありません)">全国勝率</div><div class="v">' + num(b.nw, 2) + '</div></div>' +
          '<div class="stat lw"><div class="l term" title="当地勝率＝この会場だけに絞った、全国勝率と同じ仕組みの指数">当地勝率</div>' + lwHtml(b) + '</div>' +
          '<div class="stat mo"><div class="l term" title="モーター2連率＝このモーターが過去に2着以内に入った割合">モーター2率</div><div class="v">' + mo + '%</div>' +
            '<div class="bar"><i style="width:' + mo + '%"></i></div></div>' +
        '</div>' +
      '</div>';
    }).join("");

    return '<div class="card">' +
      '<div class="card-head"><div class="ttl">' + esc(Q.venue) + ' <span>' + esc(Q.no) + 'R</span></div>' +
        '<div class="dl nums">' + head.join("・") + '</div></div>' +
      '<div class="q-wx"><span class="q-k">気象</span> ' + wxText(Q.wx) +
        '<p class="q-note">気象と展示タイムは、' + MEASURED_NOTE + '</p></div>' +
      '<div class="cmp"><div class="cmp-ttl">比べる一覧</div>' +
        '<table class="cmp-table"><thead><tr><th class="cmp-boat">艇</th><th class="cmp-left">選手</th><th class="cmp-course-col">進入</th>' +
        '<th class="cmp-num">全国<br>勝率</th><th class="cmp-num">ﾓｰﾀｰ<br>2率</th><th class="cmp-num">平均<br>ST</th><th class="cmp-num">展示</th></tr></thead>' +
        '<tbody>' + cmpRows + '</tbody></table>' +
        '<div class="cmp-note">数字は事実（全国勝率・モーター2率・平均ST・展示タイム）の並びで、予想印ではありません。</div></div>' +
      boats +
    '</div>';
  }

  /** 結果(スタートのあと)。どのレースだったかは、ここで初めて出す。 */
  function resultHtml(q) {
    var Q = q.question, A = q.answer;
    var name = {};
    Q.boats.forEach(function (b) { name[b.n] = b.name; });
    var top = [1, 2, 3].map(function (c) { return A.order.indexOf(c) + 1; });
    var order = top.map(function (lane, i) {
      return '<li><span class="q-rank">' + (i + 1) + '着</span>' + laneBadge(lane, "q-lane") +
        '<span class="q-nm">' + esc(name[lane]) + '</span></li>';
    }).join("");
    var tri = ((A.pay && A.pay["3連単"]) || [])[0];
    var meta = [];
    if (A.kimarite) meta.push("決まり手 " + esc(A.kimarite));
    if (tri) {
      meta.push("3連単 " + esc(tri.c) + " " + (isNum(tri.y) ? tri.y.toLocaleString() : "—") + "円" +
        (isNum(tri.p) ? "（" + tri.p + "番人気）" : ""));
    }
    var waku = Array.isArray(A["in"]) && A["in"].every(function (c, i) { return c === i + 1; });
    if (Array.isArray(A["in"]) && !waku) {
      var byCourse = [];
      A["in"].forEach(function (c, i) { if (isNum(c)) byCourse[c - 1] = i + 1; });
      meta.push("進入 " + byCourse.join("") + "（内から艇番）");
    }
    return '<div class="card q-result">' +
      '<div class="card-head"><div class="ttl">結果</div>' +
        '<div class="dl nums">' + esc(A.date) + '　' + esc(Q.venue) + ' ' + esc(Q.no) + 'R</div></div>' +
      '<ol class="q-order">' + order + '</ol>' +
      '<p class="q-meta">' + meta.join("　／　") + '</p>' +
    '</div>';
  }

  /** 答案(採点済みの記録から)。 */
  function paperOf(q, records, ai, Y) {
    var race = {};
    Object.keys(q.answer).forEach(function (k) { race[k] = q.answer[k]; });
    race.wx = q.question.wx;
    var scored = records.map(function (r) {
      var x = {};
      Object.keys(r).forEach(function (k) { x[k] = r[k]; });
      x.key = q.answer.key;
      x.score = Y.scoreOne(x, race);
      return x;
    });
    var p = Y.buildPaper(scored, { boats: q.question.boats });
    p.key = q.answer.key;     // AI講評が会場を読む。日付は答案のヘッダーに出さない(when で差し替える)
    p.tag = "";
    p.ai = p.settled ? ai : null;
    return p;
  }

  /**
   * その日の点のまとめ(実績の元・AI-15)。答案と同じ作り方(paperOf)で、スタートを押した時点の点を残す。
   *   yomi … 読み点 / yomiMax … 6艇のどれかを軸にしたときの読み点の最高(「いちばん材料のある艇」)
   *   hit / hit3t … 的中 / 3連単で的中 / fin … 最後の持ち点(1,000円基準。基準にできない日は null)
   *   kens … 記録した券種 / onDay … 出題日の当日(JST)に解いたか / at … スタートを押した時刻
   */
  function daySummary(q, records, Y, revealedAt) {
    var p = paperOf(q, records, null, Y);
    var yomiMax = null;
    for (var n = 1; n <= 6; n++) {
      var pn = paperOf(q, [{ id: "m" + n, at: "x", ken: "単勝", lanes: [n], tag: "", amount: UNIT }], null, Y);
      if (pn.yomi && isNum(pn.yomi.pt) && (yomiMax == null || pn.yomi.pt > yomiMax)) yomiMax = pn.yomi.pt;
    }
    var res = p.result || {};
    var spent = records.reduce(function (s, r) { return s + r.amount; }, 0);
    var settled = res.status === "hit" || res.status === "miss";
    return {
      at: revealedAt,
      onDay: !!revealedAt && new Date(Date.parse(revealedAt) + JST_MS).toISOString().slice(0, 10) === q.date,
      yomi: p.yomi && isNum(p.yomi.pt) ? p.yomi.pt : null,
      yomiMax: yomiMax,
      hit: res.status === "hit",
      hit3t: p.records.some(function (r) { return r.ken === "3連単" && r.score && r.score.st === "hit"; }),
      fin: settled && spent <= BUDGET && isNum(res.bet) && isNum(res.yen) ? BUDGET - res.bet + res.yen : null,
      kens: records.map(function (r) { return r.ken; }).filter(function (k, i, a) { return a.indexOf(k) === i; }),
      v: Y.YOMI_VERSION
    };
  }

  /** 端末にある、スタートまで進んだ出題日の一覧(実績のまとめを作り直すときに使う)。 */
  function revealedDays(ls, Y) {
    var o = readAllDays(ls);
    return Object.keys(o.days).filter(isDate).sort().map(function (date) {
      var d = o.days[date];
      if (!d || !d.revealed || typeof d.revealedAt !== "string" || !Array.isArray(d.records)) return null;
      var recs = d.records.filter(function (r) {
        return r && typeof r.id === "string" && Y.isBet(r.ken, r.lanes) && isNum(r.amount) && r.amount > 0;
      });
      return recs.length ? { date: date, records: recs, revealedAt: d.revealedAt } : null;
    }).filter(Boolean);
  }

  function headerWhen(q, today) {
    return (q.date === today ? "今日の一問" : mdLabel(q.date) + "の一問") + "　" + q.question.venue + " " + q.question.no + "R";
  }

  // ---------------------------------------------------------------- ページ

  function boot() {
    var Y = window.TeiyomiYomi, REC = window.TeiyomiYomiRecord, PAPER = window.TeiyomiYomiPaper;
    var app = document.getElementById("quizApp");
    var today = todayJst();
    var date = pickDate(location.search, today);
    var pill = document.getElementById("quizDate");
    if (pill) pill.textContent = mdLabel(date);   // 出題日(レースの日付ではない)

    function fail(msg) {
      app.innerHTML = '<div class="card q-empty"><p>' + esc(msg) + '</p></div>';
    }
    if (!Y || !REC || !PAPER) { fail("読み込みに失敗しました。ページを再読み込みしてお試しください。"); return; }

    fetch("/quiz/" + date + ".json", { cache: "no-cache" })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (q) {
        if (!isQuiz(q) || q.date !== date) {
          fail(date === today ? "今日の一問を準備しています。時間をおいてお試しください。" : "この日の一問はありません。");
          return;
        }
        show(q);
      })
      .catch(function () { fail("通信に失敗しました。通信状況をご確認のうえ、再読み込みしてお試しください。"); });

    var B = window.TeiyomiQuizBadges;
    var statusEl = document.getElementById("quizStatus");
    /** 上部の1行(解いた問・いまの連続)。 */
    function renderStatus() {
      if (!B || !statusEl) return;
      var t = B.statusText(B.evaluate(B.read(localStorage), today));
      statusEl.textContent = t;
      statusEl.hidden = !t;
    }
    /** 9/17以降に解いてまとめの無い日を、出題ファイルから一度だけ作る(1日ずつ順に)。 */
    function backfill() {
      if (!B) return;
      var have = B.read(localStorage).days;
      var todo = revealedDays(localStorage, Y).filter(function (d) { return d.date >= FIRST_DATE && !have[d.date]; });
      var chain = Promise.resolve();
      todo.forEach(function (d) {
        chain = chain.then(function () {
          return fetch("/quiz/" + d.date + ".json", { cache: "no-cache" })
            .then(function (res) { return res.ok ? res.json() : null; })
            .then(function (q2) {
              if (isQuiz(q2) && q2.date === d.date) B.addDay(localStorage, d.date, daySummary(q2, d.records, Y, d.revealedAt), today);
            })
            .catch(function () { /* 取れなければ次に開いたときにもう一度 */ });
        });
      });
      chain.then(renderStatus);
    }
    renderStatus();
    backfill();

    function show(q) {
      var store = dayStore(localStorage, date, Y);
      document.getElementById("quizQuestion").innerHTML = questionHtml(q);
      document.getElementById("quizStage").hidden = false;
      var go = document.getElementById("quizGo");
      var startBox = document.getElementById("quizStart");

      function updateStart() {
        var revealed = store.isClosed();
        startBox.hidden = revealed;
        go.disabled = !store.list().length;
      }

      var rec = REC.mount(document.getElementById("quizRecord"), store, {
        title: "買い目を記録",
        scopeLabel: "この問題",
        openLabel: "＋ 買い目を記録",
        closedText: "結果を見たので、この問題の記録は締め切りました。",
        lockWhenClosed: true,
        budget: true,
        onChange: updateStart
      });

      var RP = window.TeiyomiQuizReplay;
      var replayEl = document.getElementById("quizReplay");

      go.onclick = function () {
        if (!store.list().length) return;
        store.reveal();
        rec.close();
        updateStart();
        // 実績: スタートを押した時点の点を通算の記録へ足し、新しく付いたものを答案の下に出す
        var fresh = [];
        if (B && date >= FIRST_DATE) {
          fresh = B.addDay(localStorage, date, daySummary(q, store.list(), Y, store.revealedAt()), today).fresh;
          renderStatus();
        }
        var played = RP && replayEl && RP.play(replayEl, q.answer, {
          lanes: LANES,
          onDone: function () {
            showAnswer(fresh);
            document.getElementById("quizResult").scrollIntoView({ behavior: "smooth", block: "start" });
          }
        });
        if (played) {
          replayEl.scrollIntoView({ behavior: "smooth", block: "start" });
          return;
        }
        showAnswer(fresh);
        document.getElementById("quizResult").scrollIntoView({ behavior: "smooth", block: "start" });
      };

      function showAnswer(fresh) {
        updateStart();
        // 新しく付いた実績(答案の下に1行・演出なし)。開き直したときは出さない
        var nb = document.getElementById("quizBadgesNew");
        if (nb) {
          nb.innerHTML = fresh && fresh.length
            ? '<p class="q-new" role="status"><span class="q-new-k">新しい実績</span>' + esc(fresh.join("・")) + '</p>'
            : "";
        }
        document.getElementById("quizResult").innerHTML = resultHtml(q);
        var p = paperOf(q, store.list(), store.ai(), Y);
        // 収支・回収率は1,000円基準。持ち点が入る前(〜2026-09-18)に1,000円を超えて記録した日は、基準にできないので付けない
        var b = store.budget();
        PAPER.render({
          budget: b.spent <= b.total ? b.total : null,
          paperEl: document.getElementById("paper"),
          nextEl: document.getElementById("next"),
          p: p,
          when: headerWhen(q, today),
          venue: q.question.venue,
          saveAi: function (ai) { return store.setAi(ai); },
          markAiReported: function () { return store.setAiReported(); }
        });
      }

      if (store.isClosed()) {
        if (RP && replayEl) RP.showFinal(replayEl, q.answer, { lanes: LANES });
        showAnswer();
      }
    }
  }

  window.TeiyomiQuiz = {
    STORE_KEY: STORE_KEY, KEEP_DAYS: KEEP_DAYS, MAX_PER_QUIZ: MAX_PER_QUIZ, BUDGET: BUDGET, UNIT: UNIT,
    MEASURED_NOTE: MEASURED_NOTE,
    esc: esc, todayJst: todayJst, pickDate: pickDate, isQuiz: isQuiz, dayStore: dayStore,
    daySummary: daySummary, revealedDays: revealedDays, FIRST_DATE: FIRST_DATE,
    questionHtml: questionHtml, resultHtml: resultHtml, paperOf: paperOf, headerWhen: headerWhen
  };

  if (typeof document !== "undefined" && document.getElementById && document.getElementById("quizApp")) boot();
})();
