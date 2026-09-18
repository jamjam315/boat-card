// 読み採点の答案(1枚の紙)と、紙の外の「つづき」を描く部品。
// yomi.html(実レースの答案)と、今日の一問(過去レースで読む練習)が同じものを使う。
//
// 答案の中身(点・内訳・講評)は TeiyomiYomi.paper() / buildPaper() が作る。ここは並べるだけで、
// 文言を足したり言い換えたりしない。見た目は yomi-paper.css。
// 描く側が変えられるのは、紙のヘッダーの表示・つづきの会場・AI講評の保存先だけ
// (今日の一問は日付を伏せ、講評を出題日で端末に残すため)。何も渡さなければ実レースの答案と同じ。
//
// 読み込む順: yomi.js・yomi-ai.js・membership.js・alerts.js の後(描くときに使う)。
// ★変えたら、読んでいるページの ?v= を上げること
(function(){
  "use strict";
  function esc(s){ return String(s == null ? "" : s)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
  // 金額・払戻・波高・着順は、数だと確かめてから HTML に入れる(2026-09-18 点検 低3)。
  // 記録は端末の保存領域、払戻は公開JSONから来る。書き換えられて文字が入っていても、
  // タグとして読ませない。数でなければ「—」。数のときの見た目はそれまでと同じ。
  function isNum(v){ return typeof v === "number" && isFinite(v); }
  function plain(v){ return isNum(v) ? String(v) : "—"; }
  function loc(v){ return isNum(v) ? v.toLocaleString() : "—"; }

  /**
   * 答案を描く。
   *   opts.paperEl  紙を描く要素(必須)
   *   opts.nextEl   「つづき」を描く要素(無ければ描かない)
   *   opts.p        TeiyomiYomi.paper() / buildPaper() が返す答案
   *   opts.when     紙のヘッダー右に出す文字。省略時は p.key から「日付　会場 nR」(タグがあれば「　/　タグ」)
   *   opts.venue    つづきのバックテストに渡す会場名。省略時は p.key から
   *   opts.saveAi(ai)        生成したAI講評 {text, model} を残す。省略時は端末の記録(TeiyomiYomi.setAi)
   *   opts.markAiReported()  AI講評を報告済みにする。省略時は端末の記録(TeiyomiYomi.setAiReported)
   *   opts.budget   持ち点(円)。渡すと「持ち点 1,000円 → 7,720円（+6,720円）」を主に出す(今日の一問・便D)。
   *                 最後の持ち点 = 持ち点 − 使った額 + 払戻(使わなかったぶんは手元に残る)。
   *                 **これを「回収率」とは呼ばない**。回収率はサイト内どこでも「払戻 ÷ 賭け金」の1つだけで、
   *                 ここでも同じ定義のまま並べる(2026-09-18)。結果点は変えない(採点は読み採点と同じ)
   */
  function render(opts){
    var box = opts.paperEl;
    var nextEl = opts.nextEl || null;
    var p = opts.p;
    var saveAi = opts.saveAi || function(ai){ return TeiyomiYomi.setAi(p.key, p.tag, ai); };
    var markAiReported = opts.markAiReported || function(){ return TeiyomiYomi.setAiReported(p.key, p.tag); };

    var part = p.key ? p.key.split(":") : [];
    var when = opts.when != null ? opts.when
      : part[0] + '　' + part[1] + ' ' + part[2] + 'R' + (p.tag ? '　/　' + p.tag : '');
    var res = p.result;
    var yomi = p.yomi;
    var yen = function(n){ return isNum(n) ? (n >= 0 ? "+" : "−") + Math.abs(n).toLocaleString() : "—"; };
    var MAXY = TeiyomiYomi.MAX_YOMI_PT, MAXR = TeiyomiYomi.MAX_RESULT_PT;

    // ---- 1. 紙のヘッダー帯 ----
    var html = '<article class="paper">' +
      '<div class="p-head"><b>読み採点</b><span class="sub">答案 — ' +
        (p.settled ? '添削済' : '未添削') + '</span>' +
        '<span class="when nums">' + esc(when) + '</span></div>';

    function bar(label, pt, max){
      return '<div class="p-bar"><div class="lb"><span>' + label +
        '</span><b class="nums">' + (pt == null ? "—" : pt) + ' / ' + max + '</b></div>' +
        '<div class="track"><div class="fill" style="width:' +
        (pt == null ? 0 : Math.round(pt / max * 100)) + '%"></div></div></div>';
    }

    // ---- 2. 総合点 ----
    // 結果が出るまでは点を出さない。レース前に点を出すと、それは買い目への
    // 評価＝予想になってしまう。採点は「済んだことを振り返る」ためのもの。
    if(!p.settled){
      html += '<div class="p-total"><div class="p-bars">' +
        '<p class="p-meta" style="margin:0">' +
          (p.tag ? '<span class="p-tag">' + esc(p.tag) + '</span>' : '') +
          '記録 ' + p.records.length + '点 ／ 投入 ' +
          loc(p.records.reduce(function(s,r){ return s + (isNum(r.amount) ? r.amount : 0); }, 0)) + '円</p>' +
        '<p class="p-note">レースの結果が確定してから採点します（翌朝までに埋まります）。' +
        '結果が出る前に点や講評を出すと、買い目への評価＝予想になってしまうため、' +
        'ここでは何も出していません。</p></div>' +
        '<div class="p-big"><span class="wait">採点待ち</span>' +
        '<span class="of">結果確定後に採点</span></div></div>';
      html += '<p class="p-sec">記録した買い目（' + p.records.length + '点）</p>' +
        '<table class="p-tbl"><tr><th>券種</th><th>買い目</th><th>金額</th></tr>' +
        p.records.map(function(r){
          return '<tr><td>' + esc(r.ken) + '</td>' +
            '<td class="p-bet nums">' + esc(TeiyomiYomi.betText(r.ken, r.lanes)) + '</td>' +
            '<td class="amt nums">' + plain(r.amount) + '円</td></tr>';
        }).join("") + '</table>';
      html += paperFoot();
      box.innerHTML = html + '</article>';
      return;
    }

    var yp = yomi ? yomi.pt : null;
    var rp = (res && res.pt != null) ? res.pt : null;
    var total = (yp || 0) + (rp || 0);
    html += '<div class="p-total"><div class="p-bars">' +
      bar("読み", yp, MAXY) + bar("結果", rp, MAXR) +
      '<p class="p-meta">' + (p.tag ? '<span class="p-tag">' + esc(p.tag) + '</span>' : '') +
        '自動採点（' + esc(TeiyomiYomi.YOMI_VERSION) + '）</p></div>' +
      '<div class="p-big"><span class="n nums">' + plain(total) + '</span>' +
      '<span class="of">100点満点</span></div></div>';

    if(res.status === "void"){
      html += '<p class="p-note" style="padding:0 14px">' +
        (res.refund ? '欠場などの艇を含む買い目で返還になったため' : '不成立（返還）のため') +
        '、結果点は付きません。</p>';
    }

    // ---- 3. 軸・押さえ ----
    if(yomi){
      html += '<div class="p-axis"><p class="line" style="margin:0">軸 <span class="hon">' +
        yomi.axis + '号艇</span>（推定）' +
        (yomi.backs.length ? '　押さえ ' + yomi.backs.map(function(n){ return n + "号艇"; }).join("・") : '') +
        '</p><p class="p-note">軸と押さえは買い目から推定しています（' +
        (yomi.byFirst ? "1着に置いた回数がいちばん多い艇を軸" : "買い目に出てくる回数がいちばん多い艇を軸") +
        '、同数なら艇番の小さいほう）。読み点は軸の艇について付けています。</p>' +
        '<p class="p-note">読み点は「どの枠を選んだか」ではなく' +
        '「軸にした艇に実測の材料があったか」を測ります。' +
        'コースの有利不利は計測の時点で差し引いてあります。</p></div>';
    }

    // ---- 4. 読みの内訳 ----
    html += '<p class="p-sec">読みの内訳</p>';
    if(!yomi){
      html += '<p class="p-empty">記録した時点の出走表が残っていないため、読み点は付けられません。</p>';
    } else {
      html += '<ul class="p-rows">' + yomi.rows.map(function(r){
        // 根拠はコンパクトに1行。「7.0以上 +12.6pt・39日・35,404走」
        var why = r.note ? esc(r.note)
          : esc(r.band) + ' ' + esc(r.lift) + '・' + esc(r.period);
        return '<li><span class="p-pt nums' + (r.pt ? '' : ' zero') + '">' +
          (r.pt > 0 ? "+" : "") + r.pt + '</span><span class="p-rowbody">' +
          '<span class="p-rowname">' + esc(r.cat) + '　' + esc(r.label) +
            ' <span class="nums">' + r.pt + '/' + r.max + '</span></span>' +
          '<div class="p-rowfact">' + esc(r.fact) + '</div>' +
          '<div class="p-rowwhy">' + why + '</div>' +
          '</span></li>';
      }).join("") + '</ul>';
    }

    // ---- 4b. 点に入れていない数字 ----
    // 内訳と同じ条件(yomi があるとき=結果が確定したとき)でだけ出す。
    // レース前に「この数字は点にしていません」と並べるのも、結局その答案の
    // 材料の評価になってしまうため。
    if(yomi){
      var ab = null;
      ((p.snapshot && p.snapshot.boats) || []).forEach(function(b){
        if(b.n === yomi.axis) ab = b;
      });
      if(ab){
        // 値が取れないものは行ごと出さない。空欄を置いても理由が伝わらない。
        var out = [];
        var lw = lwText(ab);
        if(lw) out.push(['当地勝率 ' + lw,
          '数字は事実ですが、全国勝率を見たあとで1着率を新しく動かす力は±0.6ptでした（334万走・方向も一定せず）']);
        if(typeof ab.mo === "number") out.push(['モーター2率 ' + Math.round(ab.mo) + '%',
          '+2.7ptで、点にする基準に届きませんでした']);
        if(ab.k) out.push(['級別 ' + ab.k,
          '勝率と同じ強さを二重に数えることになるため']);
        if(typeof ab.nw2 === "number") out.push(['全国2連対率 ' + Number(ab.nw2).toFixed(1) + '%',
          '全国勝率とほぼ同じ動きでした（相関0.97・3.6万走）']);
        if(out.length){
          html += '<details class="p-out">' +
            '<summary>点に入れていない数字（タップで理由）</summary>' +
            '<ul class="p-out-body">' + out.map(function(x){
              return '<li><b>' + esc(x[0]) + '</b> —— ' + esc(x[1]) + '</li>';
            }).join("") + '</ul>' +
            '<p class="p-out-note">いずれも「軸が1着になるか」の実測です。' +
            '2着（押さえ）の読みは別の話で、そこでは別に測っています。</p></details>';
        }
      }
    }

    // ---- 5. 記録した買い目 ----
    html += '<p class="p-sec">記録した買い目（' + p.records.length + '点）</p>' +
      '<table class="p-tbl"><tr><th>券種</th><th>買い目・判定</th><th>金額</th><th>払戻</th></tr>' +
      p.records.map(function(r){
        var s = r.score;
        var hit = s && s.st === "hit";
        var badge = !s ? '<span class="p-badge off">採点待ち</span>'
          : hit ? '<span class="p-badge">的中</span>'
          : s.st === "void" ? '<span class="p-badge off">' + (s.refund ? '返還' : '不成立') + '</span>'
          : s.st === "nodata" ? '<span class="p-badge off">結果なし</span>'
          : '<span class="p-badge off">不的中</span>';
        return '<tr><td>' + esc(r.ken) + '</td>' +
          '<td><span class="p-bet nums' + (s && !hit && s.st === "miss" ? ' lose' : '') + '">' +
            esc(TeiyomiYomi.betText(r.ken, r.lanes)) + '</span> ' + badge + '</td>' +
          '<td class="amt nums">' + plain(r.amount) + '円</td>' +
          '<td class="nums' + (hit ? ' p-pay' : ' amt') + '">' +
            (hit ? loc(s.yen) + '円' : '—') + '</td></tr>';
      }).join("") + '</table>';
    var B = isNum(opts.budget) && opts.budget > 0 ? opts.budget : null;
    if(B && (res.status === "hit" || res.status === "miss")){
      var used = isNum(res.bet) ? res.bet : 0;
      var fin = B - used + (isNum(res.yen) ? res.yen : 0);
      html += '<p class="p-hold nums">持ち点 ' + loc(B) + '円 → <b>' + loc(fin) + '円</b>（' + yen(fin - B) + '円）</p>' +
        '<div class="p-sum">' +
        '<div class="p-cell"><span>使った額</span><b class="nums">' + loc(res.bet) + '</b></div>' +
        '<div class="p-cell"><span>払戻</span><b class="nums">' + loc(res.yen) + '</b></div>' +
        '<div class="p-cell roi"><span>回収率</span><b class="nums">' + plain(res.roi) + '%</b></div></div>' +
        '<p class="p-note" style="padding:0 14px">使わなかった ' + loc(B - used) + '円は持ち点に残ります。' +
          '回収率は払戻 ÷ 使った額です（ほかのページと同じ）。</p>';
    } else if(res.status === "hit" || res.status === "miss"){
      html += '<div class="p-sum">' +
        '<div class="p-cell"><span>投入</span><b class="nums">' + loc(res.bet) + '</b></div>' +
        '<div class="p-cell"><span>払戻</span><b class="nums">' + loc(res.yen) + '</b></div>' +
        '<div class="p-cell"><span>収支</span><b class="nums">' + yen(res.profit) + '</b></div>' +
        '<div class="p-cell roi"><span>回収率</span><b class="nums">' + plain(res.roi) + '%</b></div></div>';
    }

    // ---- 6. 当日のようす ----
    var s0 = p.records[0].score;
    html += '<div class="p-day">';
    if(s0 && s0.wave != null){
      html += '<span class="k">当日のようす</span>　<span class="nums">波高 ' + plain(s0.wave) + 'cm' +
        (s0.top3 ? '　／　着順 ' + (Array.isArray(s0.top3) ? s0.top3.map(plain).join("-") : "—") : '') + '</span>' +
        (s0.kimarite ? '　／　' + esc(s0.kimarite) : '') +
        '<p class="p-note">記録した時に見えていた直前情報とのズレは、次の段階（講評）で扱います。</p>';
    } else {
      html += '<span class="k">当日のようす</span>　結果がまだ出ていません。';
    }
    html += '</div>';

    // ---- 7. 講評 ----
    // 文面はエンジン(yomi.js)の出力をそのまま流す。ここでは並べるだけで、
    // 文言を足したり言い換えたりしない。
    var rev = (p.comment || []).filter(function(l){ return l.kind !== "note"; });
    var note = (p.comment || []).filter(function(l){ return l.kind === "note"; });
    html += '<div class="p-rev"><span class="by">採点: 艇読み</span>';
    if(!rev.length && !note.length){
      html += '<p class="none">特記事項なし</p>';
    } else {
      // 総評(1行目)と免責は罫の外に出す。文字の大きさが違うので、罫の上に
      // 乗せるとその行から先がずれていくため。
      if(rev.length) html += '<p class="p-rev-head">' + esc(rev[0].text) + '</p>';
      var body = rev.slice(1);
      if(body.length){
        html += '<ul class="p-rev-body">' +
          body.map(function(l){ return '<li>' + esc(l.text) + '</li>'; }).join("") + '</ul>';
      }
      html += note.map(function(l){
        return '<p class="p-rev-note">' + esc(l.text) + '</p>'; }).join("");
    }
    html += '</div>';

    // ---- 7b. AI講評 ----
    // 枠だけ先に置いて、中身は描画後に differ で入れる(同意・通信が絡むので、
    // 文字列を組み立てるこの流れの中では扱わない)。
    html += '<div class="p-ai" id="aiBox"><span class="by">AI講評</span></div>';

    html += paperFoot();
    box.innerHTML = html + '</article>';
    renderAi(p);
    renderNext(p);


    // ---- AI講評の描画 ----
    // 段は3つだけ。「生成済み(端末にある)」「これから生成できる」「使えない」。
    // 生成済みなら二度と送らない。再表示は端末から読むだけで、回数も減らない。
    function renderAi(p){
      var box = opts.paperEl.querySelector("#aiBox");
      var AI = window.TeiyomiYomiAi;
      if(!box) return;
      if(!AI || !p.settled){ box.parentNode.removeChild(box); return; }

      if(p.ai){ showAi(box, p.ai.text, p.ai.model, p.ai.at, undefined, p, !!p.ai.reported); return; }

      var label = '<span class="p-ai-left">この答案の内容を' + esc(AI.PROVIDER_NAME) +
        'に送って、赤ペンとは別の講評を1本書いてもらいます。</span>';
      box.innerHTML = '<span class="by">AI講評</span><p class="p-ai-act">' +
        '<button type="button" class="p-ai-btn" id="aiGo">🤖 AI講評を読む</button>' + label + '</p>';

      document.getElementById("aiGo").addEventListener("click", function(){
        if(!AI.hasConsent()){ askConsent(box, p); return; }
        run(box, p);
      });
    }

    function askConsent(box, p){
      box.innerHTML = '<span class="by">AI講評</span>' + window.TeiyomiYomiAi.consentHtml();
      box.querySelector(".ai-ok").addEventListener("click", function(){
        window.TeiyomiYomiAi.setConsent();
        run(box, p);
      });
      box.querySelector(".ai-no").addEventListener("click", function(){ renderAi(p); });
    }

    function run(box, p){
      box.innerHTML = '<span class="by">AI講評</span>' +
        '<p class="p-ai-act"><button type="button" class="p-ai-btn" disabled>生成中…</button>' +
        '<span class="p-ai-left">10秒ほどかかります。</span></p>';
      window.TeiyomiYomiAi.generate(p).then(function(res){
        if(!res.ok && res.retry){
          // AIの側で返せなかった。回数は消費していないので、その場でもう一度送れるようにする
          box.innerHTML = '<span class="by">AI講評</span>' +
            '<p class="p-ai-msg">' + esc(res.message) + '</p>' +
            '<p class="p-ai-act"><button type="button" class="p-ai-btn" id="aiAgain">もう一度</button>' +
            '<span class="p-ai-left">' + esc(window.TeiyomiYomiAi.MSG.retry_note) + '</span></p>';
          var again = document.getElementById("aiAgain");
          if(again) again.addEventListener("click", function(){ run(box, p); });
          return;
        }
        if(!res.ok){
          box.innerHTML = '<span class="by">AI講評</span>' +
            '<p class="p-ai-msg">' + esc(res.message) + '</p>' +
            '<p class="p-ai-act"><button type="button" class="p-ai-btn" id="aiRetry">戻る</button></p>';
          var b = document.getElementById("aiRetry");
          if(b) b.addEventListener("click", function(){ renderAi(p); });
          return;
        }
        // 端末に残す。保存できなくても、いま出ているものは消さない
        // (次に開いたときに残っていないだけで、この画面では読める)。
        saveAi({ text: res.text, model: res.model });
        showAi(box, res.text, res.model, new Date().toISOString(), res.remaining, p, false);
      });
    }

    function showAi(box, text, model, at, remaining, p, reported){
      var d = at ? new Date(at) : null;
      var z = function(n){ return (n < 10 ? "0" : "") + n; };
      var when = d && !isNaN(d.getTime())
        ? d.getFullYear() + "/" + z(d.getMonth()+1) + "/" + z(d.getDate()) + " " +
          z(d.getHours()) + ":" + z(d.getMinutes())
        : "";
      // 報告済みなら報告リンクを出さない(連打防止)。この状態は端末に残るので、
      // 開き直しても報告済みのまま出る。
      var tail = reported
        ? '　<span class="p-ai-done">報告を受け付けました。</span>'
        : '　<button type="button" class="p-ai-rp" id="aiRp">⚑ 報告</button>';
      box.innerHTML = '<span class="by">AI講評</span>' +
        '<p class="p-ai-body">' + esc(text) + '</p>' +
        '<p class="p-ai-meta">' + esc(model) + (when ? '　' + esc(when) + ' 生成' : '') +
        '　この答案の講評はこの端末に保存されています（読み直しても回数は減りません）。' +
        (typeof remaining === "number" ? '　残り ' + remaining + ' 回' : '') + tail + '</p>';

      var btn = document.getElementById("aiRp");
      if(btn && p) btn.addEventListener("click", function(){
        openReport(box, p, text, model, at, remaining);
      });
    }

    // ---- つづき(紙の外) ----
    // 答案は「済んだこと」の記録。ここはそこから次へ行くための場所なので、
    // 紙には刷らずに外へ置く。出す条件は内訳・AI講評と同じ(結果が確定した答案)。
    //
    // 【バックテストは券種と軸だけを持っていく】
    // 種別・距離・レース番号まで持っていくと母数が痩せて「例が少ない」画面に
    // 着地する。絞り込みは着地後に既存のUIでできるので、入口では広く取る。
    //
    // 【相手は残り5艇の全流し】
    // 答案の買い目の相手をそのまま10年引きずると「あの日の相手」を意味なく
    // 写すことになる。軸の読みを検証したいので、相手は開いておく。
    function renderNext(p){
      // 定数は関数の中に置く。このファイルは「上から流れる本体」の途中で
      // renderNext() を呼ぶので、外に var で置くと**まだ代入されていない**
      // (関数宣言は巻き上がるが、varの代入は書いた場所で走る)。
      var BET_KEY = {
        "単勝": "t", "複勝": "f", "2連単": "2t", "2連複": "2f",
        "3連単": "3t", "3連複": "3f"
        // 拡連複はバックテストに無い券種。渡さずに遷移する(会場・軸・期間は活きる)。
      };
      var SINGLE_BETS = { t: true, f: true };
      // 着順のある券種だけ。2連複・3連複は順不同なので「1着」の指定も表記もしない
      // (バックテスト側も、順不同の券種では着順の行を出さない)。
      var ORDERED_BETS = { "2t": true, "3t": true };

      var box = nextEl;
      if(!box) return;
      box.innerHTML = "";
      if(!p.settled || !p.yomi) return;

      var axis = p.yomi.axis;
      var venue = opts.venue != null ? opts.venue : p.key.split(":")[1];
      var ab = null;
      ((p.snapshot && p.snapshot.boats) || []).forEach(function(b){ if(b.n === axis) ab = b; });

      // 満点＝総合100点(読み70+結果30)。「読めて、当たった」ときだけ強調する。
      var total = (p.yomi.pt || 0) + ((p.result && p.result.pt) || 0);
      var perfect = total === (TeiyomiYomi.MAX_YOMI_PT + TeiyomiYomi.MAX_RESULT_PT);

      var html = '<section class="next">';
      if(perfect) html += '<p class="next-hit">この読みは満点でした。</p>';
      html += '<p class="next-ttl">つづき</p>';

      // --- ボタン1: バックテスト ---
      var bet = BET_KEY[p.records[0].ken] || null;
      var cond = { venue: venue, period: "10y" };
      if(bet) cond.bet = bet;
      if(bet && SINGLE_BETS[bet]){
        cond.mode = "single";
        cond.singleBoats = [axis];
      } else {
        cond.mode = "axis";
        cond.axisBoat = axis;
        // 着順は、着順のある券種のときだけ渡す。3連複に「1着」を送っても
        // 向こうは無視するが、送った条件と画面の表示が食い違う状態にはしない。
        if(bet && ORDERED_BETS[bet]) cond.axisPos = 1;
        cond.oppoBoats = [1,2,3,4,5,6].filter(function(n){ return n !== axis; });
      }
      // 買い方の言い方を券種に合わせる。単勝・複勝は1艇買うだけなので「軸」ではないし、
      // 3連複に「1着」は無い(複勝は3着まで当たりなので、いちばん誤解を招く)。
      // 券種が分からない場合(拡連複)も着順は書かない。
      var pick = axis + "号艇";
      if(!(bet && SINGLE_BETS[bet])){
        pick += (bet && ORDERED_BETS[bet]) ? "を軸（1着）" : "を軸";
      }
      html += '<a class="next-btn' + (perfect ? ' hit' : '') + '" id="nextBt' +
        '" href="/backtest-custom.html?preset=' + encodeURIComponent(JSON.stringify(cond)) + '">' +
        'この条件で10年買い続けたら' +
        '<small>' + esc(venue) + '・' + pick +
        (bet ? '・' + esc(p.records[0].ken) : '') + '・過去10年</small></a>';

      // --- ボタン2: 通知 ---
      if(ab && ab.t){
        html += '<button type="button" class="next-btn' + (perfect ? ' hit' : '') + '" id="nextAlert">' +
          'この条件で通知に登録' +
          '<small>' + esc(ab.name || ab.t) + '選手が' + axis + '枠に入る日</small></button>';
      }
      html += '</section>';
      box.innerHTML = html;

      // --- ボタン1の門番 ---
      // 条件を指定してのバックテストはプレミアム。非会員が押すと、遷移先の
      // お試しモードが後から条件を上書きし(艇番の軸と3連単が外れて選手モードに
      // なる)、「一瞬入って消えた」ように映る。押した場所で止めて、通知と同じ壁を
      // 出す。会員は今までどおり、素の<a>としてそのまま遷移する。
      var premium = null;   // null=判定前 / true=会員 / false=非会員
      if(window.TeiyomiMembership){
        TeiyomiMembership.load().then(function(st){ premium = !!(st && st.active); });
      }
      var bt = document.getElementById("nextBt");
      if(bt) bt.addEventListener("click", function(ev){
        // 会員と判っているときは何もしない(リンクのまま。新しいタブで開くのも効く)。
        if(premium === true) return;
        if(!window.TeiyomiAlerts || !TeiyomiAlerts.premiumGate) return;
        if(ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button) return;
        ev.preventDefault();
        var href = bt.getAttribute("href");
        // 判定前に押された場合もここに来る。壁の側でもう一度会員を確かめて、
        // 会員なら壁を閉じてそのまま送り出す(会員を止めてしまわないため)。
        TeiyomiAlerts.premiumGate({
          title: "🔎 条件を指定したバックテストはプレミアムの機能です",
          body: "会場・期間・券種・買い目を指定して、過去10年ぶんを検証できます。",
          ok: function(){ location.href = href; }
        });
      });

      var btn = document.getElementById("nextAlert");
      if(btn) btn.addEventListener("click", function(){
        if(!window.TeiyomiAlerts) return;
        // 既存の bellFlow に乗せる。プレミアムの案内・重複チェック・購読の案内・
        // エラー文言は、二つ名からの登録と同じものがそのまま出る。
        TeiyomiAlerts.bellFlow({
          toban: ab.t,
          playerName: ab.name || ab.t,
          preset: {
            cond: { frames: [axis] },
            line: axis + "枠に入る日に通知します。",
            note: "波高と風は、朝の時点では分かりません。当日にご自身で読むところです。",
            base: axis + "枠"
          },
          rawCond: { source: "yomi", frame: axis }
        });
      });
    }

    // ---- 報告 ----
    // 生成とは別の経路。yomi-review は呼ばず、報告用のテーブルへ直接入れる。
    // だから報告の操作で回数が減ることはない(構造として起こりえない)。
    function openReport(box, p, text, model, at, remaining){
      var AI = window.TeiyomiYomiAi;
      var form = document.createElement("div");
      form.innerHTML = AI.reportFormHtml();
      box.appendChild(form);

      var send = form.querySelector(".ai-rp-send");
      var memo = form.querySelector(".ai-rp-memo");
      // カテゴリを選ぶまで送れない。どの種類の報告かが無いと、管理に使えない。
      form.querySelectorAll('input[name="aiRpCat"]').forEach(function(r){
        r.addEventListener("change", function(){ send.disabled = false; });
      });
      form.querySelector(".ai-rp-cancel").addEventListener("click", function(){
        showAi(box, text, model, at, remaining, p, false);
      });

      send.addEventListener("click", function(){
        var picked = form.querySelector('input[name="aiRpCat"]:checked');
        if(!picked) return;
        send.disabled = true;
        send.textContent = "送信中…";
        AI.report({
          category: picked.value,
          text: text,
          model: model,
          generatedAt: at,
          comment: memo.value
        }).then(function(res){
          if(!res.ok){
            send.disabled = false;
            send.textContent = "報告する";
            var note = form.querySelector(".ai-rp-note");
            note.textContent = res.message;
            return;
          }
          markAiReported();
          showAi(box, text, model, at, remaining, p, true);
        });
      });
    }

    // 当地勝率の表記。**レースページの lwDisplay() と同じ見分け方にそろえる。**
    // 当地を走っていない選手に「0.00」と出すと事実と違う(index.html の同名関数を参照)。
    //   lwn = 当地(直近1年のK票)での出走数 / sn = 半年の全会場の出走回数
    function lwText(b){
      if(b.lw == null) return null;
      if(b.lw === 0){
        if(!b.lwn) return b.sn === 0 ? "当地初" : "当地データなし";
        if(b.lwn < 10) return "0.00";   // 走ってはいるが薄い(参考程度)
      }
      return Number(b.lw).toFixed(2);
    }

    // ---- 8. 紙のフッター ----
    function paperFoot(){
      var d = new Date();
      var z = function(n){ return (n < 10 ? "0" : "") + n; };
      return '<div class="p-foot"><span>予想印は出していません。記録した時点の番組表の数字と、' +
        '確定した結果だけで機械的に付けています。</span>' +
        '<span class="nums">艇読み — 読み採点 ' + esc(TeiyomiYomi.YOMI_VERSION) + '　' +
        d.getFullYear() + '/' + z(d.getMonth() + 1) + '/' + z(d.getDate()) + ' ' +
        z(d.getHours()) + ':' + z(d.getMinutes()) + '</span></div>';
    }
  }

  window.TeiyomiYomiPaper = { render: render };
})();
