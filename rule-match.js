// 保存した絞り込み(5bの条件)を「今日の番組表」と照らすための、画面から切り離した関数。
// 5b(backtest-custom.html)とマイページの両方から使う。DOMにもログインにも触らない。
//
// 【ここに置いてあるもの】
//   OPTS            … 5bのしぼり込みの選択肢の表(以前は5bの中に直接書いてあった)
//   condFromFilter  … 5bの filter を、朝に照らせる形(AlertCond)に直す
//   unusableLabels  … レースが終わるまで分からないので照らせない条件の名前
//   matchesCond     … 1つの出走が条件に当てはまるか
//   ruleFromNote    … 検証ノートの cond から、照合に使うもの一式を作る
//   matchRaces      … 今日の data.js から、ルールに当てはまるレースを集める
//
// 【matchesCond は2か所にある】
// 朝の通知はサーバー側(supabase/functions/_shared/morning-message.ts)で同じ判定をしている。
// あちらはDeno(TS)、こちらはブラウザ(JS)なので1本にできない。代わりに
// supabase/functions/_shared/rule_match_parity_test.ts が、同じ入力に対して
// 両方が同じ答えを返すことを確かめている。**片方を直したら、もう片方も直すこと。**
// 条件(AlertCond)の形そのものの仕様は morning-message.ts に1つだけ書いてある。
(function (root) {
  "use strict";

  // ---------- しぼり込みの選択肢 ----------
  // 判定に使う値は backtest-data の "m"(1レース1整数のビット詰め)から取り出す。
  // ビットの割り当ては build_backtest_custom.py と必ず一致させること:
  //   bit 0-3 レース番号 / 4-6 天候 / 7-11 風速 / 12-14 決まり手 / 15 枠なり / 16-20 会場
  var OPTS = {
    month: [
      {key:"all",    label:"すべて",     months:null},
      {key:"spring", label:"春(3〜5月)",  months:[3,4,5]},
      {key:"summer", label:"夏(6〜8月)",  months:[6,7,8]},
      {key:"autumn", label:"秋(9〜11月)", months:[9,10,11]},
      {key:"winter", label:"冬(12〜2月)", months:[12,1,2]},
      {key:"custom", label:"月を選ぶ",    months:null}
    ],
    rno: [
      {key:"all",    label:"すべて",    races:null},
      {key:"early",  label:"1〜3R",     races:[1,2,3]},
      {key:"mid",    label:"4〜9R",     races:[4,5,6,7,8,9]},
      {key:"late",   label:"10〜12R",   races:[10,11,12]},
      {key:"custom", label:"レースを選ぶ", races:null}
    ],
    weather: [
      {key:"all",    label:"すべて", codes:null},
      {key:"sunny",  label:"晴",     codes:[0]},
      {key:"cloudy", label:"曇",     codes:[1]},
      {key:"rain",   label:"雨",     codes:[2]},
      {key:"snow",   label:"雪・霧", codes:[3,4]}
    ],
    wind: [
      {key:"all", label:"すべて",  min:null, max:null},
      {key:"lo",  label:"〜2m",    min:0,    max:2},
      {key:"mid", label:"3〜4m",   min:3,    max:4},
      {key:"hi",  label:"5m以上",  min:5,    max:30}
    ],
    session: [
      {key:"all",   label:"すべて"},
      {key:"night", label:"ナイター場"},
      {key:"day",   label:"デイ場"}
    ],
    kind: [
      {key:"all",   label:"すべて",     codes:null},
      {key:"yusho", label:"優勝戦",     codes:[0]},
      {key:"jun",   label:"準優勝戦",   codes:[1]},
      {key:"yosen", label:"予選",       codes:[2]},
      {key:"ippan", label:"一般",       codes:[3]},
      {key:"other", label:"その他",     codes:[4]}
    ],
    dist: [
      {key:"all",  label:"すべて",  codes:null},
      {key:"1800", label:"1800m",  codes:[0]},
      {key:"1200", label:"1200m",  codes:[1]}
    ],
    fixed: [
      {key:"all", label:"すべて",           want:null},
      {key:"on",  label:"進入固定のみ",     want:1},
      {key:"off", label:"進入固定を除く",   want:0}
    ],
    entry: [
      {key:"all",    label:"すべて"},
      {key:"waku",   label:"枠なり"},
      {key:"change", label:"進入変化あり"}
    ],
    kimarite: [
      {key:"all",   label:"すべて",      codes:null},
      {key:"nige",  label:"逃げ",        codes:[0]},
      {key:"sashi", label:"差し",        codes:[1]},
      {key:"mak",   label:"まくり",      codes:[2]},
      {key:"maksa", label:"まくり差し",  codes:[3]},
      {key:"nuki",  label:"抜き・恵まれ", codes:[4,5]}
    ]
  };

  /** keyの選択肢を返す。知らないkey(古いノートなど)は先頭の「すべて」にする。 */
  function optByKey(opts, key){
    for(var i=0;i<opts.length;i++){ if(opts[i].key === key) return opts[i]; }
    return opts[0];
  }

  function numSorted(a){
    return a.slice().sort(function(x, y){ return x - y; });
  }

  /**
   * 5bの filter を、朝に照らせる条件(AlertCond)に直す。
   *   filter      … 5bの state.filter(検証ノートなら cond.filter)
   *   venueRomaji … 5bの state.venue("zenkoku" または会場のローマ字)
   *   venues      … backtest-data/meta.json の venues([{name, romaji, night}])
   *
   * 開催区分(ナイター/デイ)は全国のときだけ使う。5bのバックテスト(buildFilter)も
   * 会場を1つ選んでいるときは開催区分を無視するので、それに合わせる
   * (5bの画面は会場を選んだ時点で開催区分を「すべて」に戻すので、画面から来た値では同じになる)。
   */
  function condFromFilter(filter, venueRomaji, venues){
    var f = filter || {}, cond = {};
    // 会場を選んでいれば入れる。全国のままなら入れない(=会場では絞らない)。
    if(venueRomaji && venueRomaji !== "zenkoku"){
      var v = (venues || []).filter(function(x){ return x && x.romaji === venueRomaji; })[0];
      if(v && v.name) cond.venues = [v.name];
    }
    var months = f.month === "custom" ? ((f.months && f.months.length) ? f.months : null)
                                      : optByKey(OPTS.month, f.month).months;
    if(months && months.length) cond.months = numSorted(months);
    var races = f.rno === "custom" ? ((f.races && f.races.length) ? f.races : null)
                                   : optByKey(OPTS.rno, f.rno).races;
    if(races && races.length) cond.races = numSorted(races);
    var kind = optByKey(OPTS.kind, f.kind);
    if(kind.key !== "all") cond.kinds = [kind.label];
    var dist = optByKey(OPTS.dist, f.dist);
    if(dist.key !== "all") cond.dists = [Number(dist.key)];
    var fixed = optByKey(OPTS.fixed, f.fixed);
    if(fixed.key !== "all") cond.fixed = (fixed.key === "on");
    var zenkoku = !venueRomaji || venueRomaji === "zenkoku";
    if(zenkoku && (f.session === "night" || f.session === "day")) cond.session = f.session;
    return cond;
  }

  /**
   * レースが終わるまで分からない条件の名前。保存はされているが照合には使えないので、
   * 何が使えないのかを正直に見せるために使う。
   */
  function unusableLabels(filter){
    var f = filter || {}, out = [];
    var w = optByKey(OPTS.weather, f.weather);
    if(w.key !== "all") out.push("天候：" + w.label);
    var wd = optByKey(OPTS.wind, f.wind);
    if(wd.key !== "all") out.push("風速：" + wd.label);
    var k = optByKey(OPTS.kimarite, f.kimarite);
    if(k.key !== "all") out.push("決まり手：" + k.label);
    var e = optByKey(OPTS.entry, f.entry);
    if(e.key !== "all") out.push("進入：" + e.label);
    return out;
  }

  function has(arr){ return !!(arr && arr.length); }

  /**
   * 1つの出走が条件に当てはまるか。morning-message.ts の matchesCond と同じ判定。
   * 条件で指定されているのにデータ側に無い項目は「当てはまらない」に倒す。
   *   e           … {venue, race, frame, kind, dist, fixed}
   *   dateIso     … "2026-09-15"(月の判定に使う)
   *   nightVenues … ナイター会場名の Set。分からなければ null
   */
  function matchesCond(e, cond, dateIso, nightVenues){
    var c = cond || {};
    if(has(c.venues) && c.venues.indexOf(e.venue) === -1) return false;
    if(has(c.races) && c.races.indexOf(e.race) === -1) return false;
    if(has(c.frames) && c.frames.indexOf(e.frame) === -1) return false;
    if(has(c.months)){
      var month = Number(String(dateIso).slice(5, 7));
      if(c.months.indexOf(month) === -1) return false;
    }
    if(has(c.kinds)){
      if(!e.kind || c.kinds.indexOf(e.kind) === -1) return false;
    }
    if(has(c.dists)){
      if(typeof e.dist !== "number" || c.dists.indexOf(e.dist) === -1) return false;
    }
    if(typeof c.fixed === "boolean"){
      if(typeof e.fixed !== "boolean" || e.fixed !== c.fixed) return false;
    }
    if(c.session === "night" || c.session === "day"){
      if(!nightVenues) return false;          // 会場の区分が分からないので判定しない
      var isNight = nightVenues.has(e.venue);
      if((c.session === "night") !== isNight) return false;
    }
    return true;
  }

  /**
   * 検証ノートの cond から、今日の番組表との照合に使うもの一式を作る。
   *   toban       … 選手モードの登番(通常モードは null)。その選手が出るレースに絞る
   *   cond        … 朝に照らせる条件(AlertCond)
   *   unusable    … 照らせなかった条件の名前
   *   narrowable  … 朝の時点で絞れる条件が1つでもあるか。false のときは
   *                  全レースが当てはまってしまうので、一覧を出さない
   * 券種・買い目・集計期間は「このレースが条件に合うか」には関わらないので使わない。
   */
  function ruleFromNote(noteCond, venues){
    var n = noteCond || {};
    var toban = n.toban ? String(n.toban) : null;
    var cond = condFromFilter(n.filter, n.venue, venues);
    return {
      toban: toban,
      cond: cond,
      unusable: unusableLabels(n.filter),
      narrowable: !!toban || Object.keys(cond).length > 0
    };
  }

  /** meta.json の venues から、ナイター会場名の Set を作る(朝の通知の loadNightVenues と同じ)。 */
  function nightVenuesFrom(venues){
    if(!venues) return null;
    var out = new Set();
    venues.forEach(function(v){ if(v && v.night && v.name) out.add(v.name); });
    return out;
  }

  /** data.js の "2026年7月28日" を "2026-07-28" にする。読めなければ null。 */
  function parseDataDate(label){
    if(typeof label !== "string") return null;
    var m = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(label.trim());
    if(!m) return null;
    function pad(s){ return s.length < 2 ? "0" + s : s; }
    return m[1] + "-" + pad(m[2]) + "-" + pad(m[3]);
  }

  /**
   * 今日の data.js(window.DATA)から、ルールに当てはまるレースを集める。
   * 返すのは [{venue, race, deadline}] で、締切の早い順。同じレースは1件だけ。
   * 絞れる条件が無いルール(narrowable=false)には空配列を返す(呼び出し側で別の表示にする)。
   */
  function matchRaces(data, rule, nightVenues){
    var out = [];
    if(!rule || !rule.narrowable || !data) return out;
    var dateIso = parseDataDate(data.date);
    if(!dateIso) return out;
    (data.venues || []).forEach(function(v){
      (v.races || []).forEach(function(r){
        var base = {venue: v.name, race: r.no, kind: r.kind, dist: r.dist, fixed: r.fixed};
        var hit = false;
        if(rule.toban){
          (r.boats || []).forEach(function(b){
            if(hit || String(b.t) !== rule.toban) return;
            var e = {venue: base.venue, race: base.race, frame: b.n,
                     kind: base.kind, dist: base.dist, fixed: base.fixed};
            hit = matchesCond(e, rule.cond, dateIso, nightVenues);
          });
        }else{
          hit = matchesCond(base, rule.cond, dateIso, nightVenues);
        }
        if(hit) out.push({venue: v.name, race: r.no, deadline: r.dl || ""});
      });
    });
    out.sort(function(x, y){ return x.deadline < y.deadline ? -1 : x.deadline > y.deadline ? 1 : 0; });
    return out;
  }

  root.TeiyomiRuleMatch = {
    OPTS: OPTS,
    optByKey: optByKey,
    condFromFilter: condFromFilter,
    unusableLabels: unusableLabels,
    matchesCond: matchesCond,
    ruleFromNote: ruleFromNote,
    nightVenuesFrom: nightVenuesFrom,
    parseDataDate: parseDataDate,
    matchRaces: matchRaces
  };
})(typeof window !== "undefined" ? window : globalThis);
