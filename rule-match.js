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
//   MATS など       … 艇の材料(級別・全国勝率・モーター2連率・平均ST・直近3走)の帯と判定(2026-10-20)
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

  // ---------- 艇の材料(2026-10-20) ----------
  // 5bの「艇の材料」でしぼる条件と、条件アラートの照合が使う。
  // 帯は読み採点(yomi.js の YOMI_TABLE)と同じ(tests/bt-mat.test.mjs が確かめる)。
  // モーター2連率だけは読み採点に帯が無いので、実データの分布から決めた。
  // 帯は「下限以上・上限未満」(min 以上 max 未満。片方が無いのは端)。
  // 値が分からない艇はどの帯にも入らない(=その条件には当てはまらない)。
  //
  // 【値の決め方】(build_bt_materials.py と同じ。どれもそのレースの朝に分かっていた値)
  //   級別・全国勝率・モーター2連率 … 番組表。0.00 は「まだ記録が無い」なので分からない扱い
  //     (読み採点の yomiScore も全国勝率 0 を「不明」にしている)
  //   平均ST       … 今節(2走以上なら)か直近30日の ST の平均(data.js の ks.s)
  //   直近3走の平均着 … 同じ走のうち着のある最後の3走の平均。2走未満なら分からない(yomi.js fromKs と同じ)
  //
  // サーバー側(supabase/functions/_shared/morning-message.ts)にも同じ表がある。
  // **片方を直したら、もう片方も直すこと**(rule_match_parity_test.ts が一致を確かめる)。
  var MATS = [
    {key:"k",  label:"級別", bands:[
      {key:"A1", label:"A1"}, {key:"A2", label:"A2"}, {key:"B1", label:"B1"}, {key:"B2", label:"B2"}]},
    {key:"nw", label:"全国勝率", bands:[
      {key:"7.0-",    label:"7.0以上",  min:7.0},
      {key:"6.5-7.0", label:"6.5〜7.0", min:6.5, max:7.0},
      {key:"6.0-6.5", label:"6.0〜6.5", min:6.0, max:6.5},
      {key:"5.5-6.0", label:"5.5〜6.0", min:5.5, max:6.0},
      {key:"5.0-5.5", label:"5.0〜5.5", min:5.0, max:5.5},
      {key:"-5.0",    label:"5.0未満",  max:5.0}]},
    // 【仮】JAM の決定待ち(2026-10-20)。分布の四分位(28.9 / 33.7 / 38.7)に近い切りのよい数で5つに分けた案
    {key:"mo", label:"モーター2連率", unit:"%", bands:[
      {key:"45-",   label:"45%以上", min:45},
      {key:"40-45", label:"40〜45%", min:40, max:45},
      {key:"35-40", label:"35〜40%", min:35, max:40},
      {key:"30-35", label:"30〜35%", min:30, max:35},
      {key:"-30",   label:"30%未満", max:30}]},
    {key:"st", label:"平均ST", bands:[
      {key:"-0.14",     label:"0.14未満",  max:0.14},
      {key:"0.14-0.16", label:"0.14〜0.16", min:0.14, max:0.16},
      {key:"0.16-0.18", label:"0.16〜0.18", min:0.16, max:0.18},
      {key:"0.18-",     label:"0.18以上",  min:0.18}]},
    {key:"fm", label:"直近3走の平均着", bands:[
      {key:"-2.0",    label:"2.0着未満",  max:2.0},
      {key:"2.0-3.0", label:"2.0〜3.0着", min:2.0, max:3.0},
      {key:"3.0-4.0", label:"3.0〜4.0着", min:3.0, max:4.0},
      {key:"4.0-",    label:"4.0着以上",  min:4.0}]}
  ];
  var MIN_FORM_RACES = 2;   // yomi.js fromKs と同じ

  function matDef(key){
    for(var i=0;i<MATS.length;i++){ if(MATS[i].key === key) return MATS[i]; }
    return null;
  }

  /** 値が帯のどれかに入るか。級別は文字で比べる。値が分からなければ false。 */
  function inMatBands(matKey, value, bandKeys){
    var d = matDef(matKey);
    if(!d || value === null || value === undefined || !has(bandKeys)) return false;
    for(var i=0;i<d.bands.length;i++){
      var b = d.bands[i];
      if(bandKeys.indexOf(b.key) === -1) continue;
      if(matKey === "k"){ if(value === b.key) return true; continue; }
      if((b.min === undefined || value >= b.min) && (b.max === undefined || value < b.max)) return true;
    }
    return false;
  }

  /** data.js の1艇から材料を作る(朝の通知・マイページ用)。分からない値は null。 */
  function matFromDataBoat(b){
    if(!b) return null;
    var ks = b.ks || {};
    var s = (ks.s || []).filter(function(x){ return typeof x === "number"; });
    var r = (ks.r || []).filter(function(x){ return typeof x === "number"; });
    var t = r.slice(-3);
    return {
      k: (b.k === "A1" || b.k === "A2" || b.k === "B1" || b.k === "B2") ? b.k : null,
      nw: typeof b.nw === "number" && b.nw > 0 ? b.nw : null,
      mo: typeof b.mo === "number" && b.mo > 0 ? b.mo : null,
      st: s.length ? s.reduce(function(a, x){ return a + x; }, 0) / s.length : null,
      fm: r.length >= MIN_FORM_RACES ? t.reduce(function(a, x){ return a + x; }, 0) / t.length : null
    };
  }

  /** 5bの state.filter.mats を、照合に使う形に整える(知らない材料・帯の無い行は落とす)。 */
  function normMats(mats){
    var out = [];
    (mats || []).forEach(function(m){
      if(!m || !matDef(m.mat)) return;
      var lane = m.lane === "self" ? "self" : Number(m.lane);
      if(lane !== "self" && !(lane >= 1 && lane <= 6)) return;
      var keys = matDef(m.mat).bands.map(function(b){ return b.key; });
      var bands = (m.bands || []).filter(function(k){ return keys.indexOf(k) !== -1; });
      if(!bands.length) return;
      out.push({lane: lane, mat: m.mat, bands: keys.filter(function(k){ return bands.indexOf(k) !== -1; })});
    });
    return out;
  }

  /**
   * 材料の条件1つの名前。隣り合う帯は1つの範囲にまとめる。
   *   1号艇の全国勝率 7.0以上・6.5〜7.0・6.0〜6.5 → 「1号艇の全国勝率：6.0以上」
   *   離れていれば並べる → 「1号艇の平均ST：0.14未満・0.16〜0.18」
   */
  var MAT_FMT = {
    nw: function(v){ return v.toFixed(1); },
    mo: function(v){ return String(v); },
    st: function(v){ return v.toFixed(2); },
    fm: function(v){ return v.toFixed(1); }
  };
  var MAT_UNIT = { nw: "", mo: "%", st: "", fm: "着" };
  function matCondLabel(m){
    var d = matDef(m.mat);
    if(!d) return "";
    var who = (m.lane === "self" ? "この選手" : m.lane + "号艇") + "の" + d.label + "：";
    var picked = d.bands.map(function(b){ return (m.bands || []).indexOf(b.key) !== -1; });
    if(m.mat === "k"){
      return who + d.bands.filter(function(b, i){ return picked[i]; }).map(function(b){ return b.label; }).join("・");
    }
    // 表の並びのまま、選ばれた帯の続きを1つの範囲にする
    var runs = [], cur = null;
    d.bands.forEach(function(b, i){
      if(!picked[i]){ cur = null; return; }
      if(!cur){ cur = { lo: b.min, hi: b.max }; runs.push(cur); return; }
      if(b.min === undefined || (cur.lo !== undefined && b.min < cur.lo)) cur.lo = b.min;
      if(b.max === undefined || (cur.hi !== undefined && b.max > cur.hi)) cur.hi = b.max;
    });
    var f = MAT_FMT[m.mat], u = MAT_UNIT[m.mat];
    return who + runs.map(function(r){
      if(r.lo === undefined && r.hi === undefined) return "すべての帯";   // 値が分かる艇ならどれでも
      if(r.lo === undefined) return f(r.hi) + u + "未満";
      if(r.hi === undefined) return f(r.lo) + u + "以上";
      return f(r.lo) + "〜" + f(r.hi) + u;
    }).join("・");
  }

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
    // 艇の材料は番組表と前日までの成績から決まるので、朝に照らせる
    var mats = normMats(f.mats);
    if(mats.length) cond.mats = mats;
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
   *   e           … {venue, race, frame, kind, dist, fixed, boats}
   *                 boats は艇番順の材料(matFromDataBoat)。材料の条件があるときだけ使う
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
    if(has(c.mats)){
      for(var i=0;i<c.mats.length;i++){
        var m = c.mats[i];
        var lane = m.lane === "self" ? e.frame : m.lane;
        var bm = e.boats && lane ? e.boats[lane - 1] : null;
        if(!bm || !inMatBands(m.mat, bm[m.mat], m.bands)) return false;
      }
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
        var boats = [null, null, null, null, null, null];
        (r.boats || []).forEach(function(b){ if(b && b.n >= 1 && b.n <= 6) boats[b.n - 1] = matFromDataBoat(b); });
        var base = {venue: v.name, race: r.no, kind: r.kind, dist: r.dist, fixed: r.fixed, boats: boats};
        var hit = false;
        if(rule.toban){
          (r.boats || []).forEach(function(b){
            if(hit || String(b.t) !== rule.toban) return;
            var e = {venue: base.venue, race: base.race, frame: b.n,
                     kind: base.kind, dist: base.dist, fixed: base.fixed, boats: boats};
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
    matchRaces: matchRaces,
    MATS: MATS,
    matDef: matDef,
    inMatBands: inMatBands,
    matFromDataBoat: matFromDataBoat,
    normMats: normMats,
    matCondLabel: matCondLabel
  };
})(typeof window !== "undefined" ? window : globalThis);
