// 答案ページのAI講評。ボタン・同意画面・送信・端末保存だけを受け持つ。
//
// 採点そのもの(読み点・結果点・赤ペンの講評)は yomi.js が端末の中で完結して
// やっている。**AI講評だけが外に出る機能**なので、出る前に同意を挟み、
// 何を送るのかを画面に書く。ここが唯一の送信経路になるようにしてある。
(function () {
  "use strict";

  // --- 送信先のAI事業者(**ここ1箇所だけで持つ**) ---------------------------
  //
  // 第三者のAIへデータを渡す前に、送信先を明確に特定して同意を得る
  // (レジャー帳がApp Store 5.1.2(i)対応で通した作法をそのまま持ってきた)。
  // 「いずれかの事業者」という書き方は要件を満たさない。
  //
  // 事業者を変えるときにやること(**片方だけやらない**):
  //   1. 下の2つを直す → 同意キーが変わり、利用者には新しい社名で同意画面が
  //      出直す。黙って送信先が変わることはない
  //   2. プライバシーポリシーの社名を直す
  //   3. サーバーの AI_PROVIDER / AI_MODEL / AI_BASE_URL を切り替える
  var AI_PROVIDER_ID = "openai";
  var AI_PROVIDER_NAME = "OpenAI, L.L.C.（米国）";

  var CONSENT_KEY = "teiyomi_yomi_ai_consent_v1_" + AI_PROVIDER_ID;
  var FUNCTION_URL = "https://vynbhssakpxiikmseoja.supabase.co/functions/v1/yomi-review";
  var TIMEOUT_MS = 20000;   // サーバーは15秒で諦めるので、こちらは少し長く待つ

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // 同意は端末に持つ。読めない環境(プライベートモード等)では「同意していない」
  // 側に倒す。送らないほうの間違いは取り返しがつく。
  function hasConsent() {
    try { return localStorage.getItem(CONSENT_KEY) === "1"; } catch (e) { return false; }
  }
  function setConsent() {
    try { localStorage.setItem(CONSENT_KEY, "1"); return true; } catch (e) { return false; }
  }

  /**
   * 答案からサーバーへ送る形を作る。
   *
   * **ここに入れないものは送られない。** 選手名・登番以外の個人に関わるもの・
   * 金額・出所タグ・日付は入れない。登番(t)だけは、サーバーが前づけ32人と
   * 突き合わせるために要る(サーバーはそれをAI事業者へは渡さない)。
   */
  function buildSheet(p) {
    var snap = p.snapshot || {};
    var boats = (snap.boats || []).map(function (b) {
      var ks = b.ks || {};
      var st = null;
      if (Array.isArray(ks.s) && ks.s.length) {
        var sum = 0;
        ks.s.forEach(function (x) { sum += x; });
        st = Math.round(sum / ks.s.length * 1000) / 1000;
      }
      return {
        n: b.n,
        t: b.t || null,
        nw2: typeof b.nw2 === "number" ? b.nw2 : null,
        st: st,
        last: Array.isArray(ks.r) ? ks.r.slice(0, 8) : [],
        mo: typeof b.mo === "number" ? b.mo : null
      };
    });

    var s0 = null;
    p.records.forEach(function (r) { if (!s0 && r.score) s0 = r.score; });

    return {
      venue: p.key.split(":")[1],
      wave: p.wave,
      kimarite: s0 ? s0.kimarite : null,
      // 着順は艇番順。答案ページが出しているものと同じ並び。
      order: orderArray(p),
      "in": p.inn || null,
      bets: p.records.map(function (r) {
        return {
          ken: r.ken,
          combo: r.lanes.join(r.ken.indexOf("連単") >= 0 || r.ken === "単勝" ? "-" : "="),
          hit: !!(r.score && r.score.st === "hit")
        };
      }),
      axis: p.yomi ? p.yomi.axis : null,
      backs: p.yomi ? p.yomi.backs : [],
      yomi: p.yomi ? p.yomi.rows.map(function (x) {
        return { cat: x.cat, label: x.label, pt: x.pt, max: x.max, value: x.fact };
      }) : [],
      boats: boats
    };
  }

  /** 艇番順の着順。score.top3 は「着順に並んだ艇番」なので、並べ替えて返す。 */
  function orderArray(p) {
    var out = [null, null, null, null, null, null];
    var s0 = null;
    p.records.forEach(function (r) { if (!s0 && r.score) s0 = r.score; });
    var top3 = (s0 && s0.top3) || [];
    for (var i = 0; i < top3.length; i++) {
      var lane = top3[i];
      if (lane >= 1 && lane <= 6) out[lane - 1] = i + 1;
    }
    return out;
  }

  function post(sheet, token) {
    var ctrl = typeof AbortController === "function" ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS) : null;
    return fetch(FUNCTION_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: JSON.stringify(sheet),
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      if (timer) clearTimeout(timer);
      return res.json().catch(function () { return {}; })
        .then(function (body) { return { status: res.status, body: body }; });
    }, function (e) {
      if (timer) clearTimeout(timer);
      throw e;
    });
  }

  // 画面に出す言葉。どれも「なぜそうなったか」を書く。
  var MSG = {
    unauthorized: "AI講評を読むには、マイページからログインしてください。",
    limit_free: "お試しの5回を使い切りました。プレミアムでは毎日3回使えます。",
    limit_premium: "本日ぶんの3回を使い切りました。明朝また使えます。",
    blocked: "講評を生成できませんでした。回数は消費していません。",
    ai_unavailable: "いまAI講評を使えません。時間をおいて試してください。",
    bad_request: "この答案の形では送れませんでした。",
    network: "通信できませんでした。電波の良いところで試してください。"
  };

  window.TeiyomiYomiAi = {
    PROVIDER_NAME: AI_PROVIDER_NAME,
    hasConsent: hasConsent,
    setConsent: setConsent,
    buildSheet: buildSheet,
    MSG: MSG,

    /**
     * 1本生成する。
     * 返り値(Promise): {ok:true, text, model, remaining, premium}
     *                / {ok:false, message, remaining}
     *
     * 失敗は必ず {ok:false} に倒す。例外を投げない
     * (呼び出し側は「文が取れたか」だけを見ればよい)。
     */
    generate: function (p) {
      // トークンの取り出しは favorites.js の getAccessToken に任せる。
      // あちらはSDKの読み込みが終わっていなければ素直に null を返すので、
      // 「まだ準備できていない」と「ログインしていない」を同じ扱いにできる。
      // 自分で getClient().auth.getSession() を呼ぶと、準備前に触って例外に
      // なり、その手の失敗が全部 catch に落ちて通信エラー表示に化ける。
      var auth = window.TeiyomiAuth;
      if (!auth || !auth.getAccessToken) {
        return Promise.resolve({ ok: false, message: MSG.unauthorized });
      }
      return auth.getAccessToken().then(function (token) {
        if (!token) return { ok: false, message: MSG.unauthorized };
        return post(buildSheet(p), token).then(function (res) {
          var b = res.body || {};
          if (res.status === 200 && b.ok && b.text) {
            return {
              ok: true, text: b.text, model: b.model || "",
              remaining: b.remaining, premium: !!b.premium
            };
          }
          if (res.status === 429) {
            return {
              ok: false, remaining: 0,
              message: b.premium ? MSG.limit_premium : MSG.limit_free
            };
          }
          if (res.status === 401 || res.status === 403) {
            return { ok: false, message: MSG.unauthorized };
          }
          return { ok: false, message: MSG[b.code] || MSG.ai_unavailable };
        });
      }).catch(function () {
        return { ok: false, message: MSG.network };
      });
    },

    /** 同意画面の本文。何を送り、何を送らないかを、この1か所で書く。 */
    consentHtml: function () {
      return '<div class="ai-consent">' +
        '<p class="ai-ttl">AI講評を読む前に</p>' +
        '<p>AI講評を読むときだけ、この答案の内容を生成AIの提供元（' +
          esc(AI_PROVIDER_NAME) + '）に送信します。</p>' +
        '<p class="ai-list"><b>送るもの</b><br>' +
          '会場名・各艇の成績数値・レースの結果・買い目の組番・読み点の内訳</p>' +
        '<p class="ai-list"><b>送らないもの</b><br>' +
          '選手名・金額・あなたのメモ（出所タグ）</p>' +
        '<p>講評の生成のみに使い、艇読みのサーバーには保存しません。' +
        '生成された講評は、この端末の中にだけ残ります。</p>' +
        '<p class="ai-act"><button type="button" class="ai-ok">同意してAI講評を読む</button>' +
        '<button type="button" class="ai-no">やめる</button></p>' +
        '</div>';
    }
  };
})();
