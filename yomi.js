// 「読み採点」の記録を端末内(localStorage)で管理する共通ロジック。
// レースページ(race/…)とマイページの両方から読み込む。
//
// 【この段階(P1-1)でやること・やらないこと】
// やる    … 締切前に買い目を記録する / 一覧する / 消す
// やらない… 的中判定・回収率・採点(P1-3)、サーバー同期、書き出し
//
// 【サーバーには送らない】
// 買い目と金額は、その人がいくら賭けたかという極めて私的な記録になる。
// この段階では端末の外へ出さない。お気に入りのようなクラウド同期も付けない
// (付けるならデータセーフティの申告から見直す必要がある)。
//
// 【スナップショットを持つ理由 — この機能の芯】
// 記録した時点の data.js のレース要素を、まるごとそのまま保存する。
// 採点する日に事実を組み立て直さない。番組表は訂正されることがあり、
// 選手の当地成績や今節の流れは毎日動くので、後から引き直すと
// 「その人が見て判断した数字」ではなくなる。
// 「+15: 1号艇を軸(当地の逃げ率61%)」と言えるのは、その61%を
// 本人が見ていた時のものとして保存してあるからで、そこが崩れると企画が崩れる。
//
// 【localStorageが使えない環境】
// プライベートモード等で読み書きが例外になる。favorites.js と同じく
// 読み書きは必ず try/catch で囲み、失敗しても画面は壊さない
// (記録が次回に残らないだけにする)。
//
// 【Play版(TWA)とWeb版】
// TWAはWebViewではなく端末のChrome本体でページを動かすため、
// teiyomi.com というオリジンの localStorage はブラウザと共有される。
// アプリで記録したものは、同じ端末のChromeで開いても見える。
// (端末をまたぐ引き継ぎは無い。それはサーバー同期の話で、ここでは扱わない。)
(function () {
  "use strict";

  var KEY = "teiyomi_yomi_records";
  // スナップショットはレース単位で1つだけ持つ。1レース分が約2.2KBあり、
  // 同じレースに何点も買う人(3連単のフォーメーション等)が記録ごとに抱えると、
  // 中身が全く同じものを何十個も置くことになる。
  var SNAP_KEY = "teiyomi_yomi_snapshots";
  var MAX_RECORDS = 500;      // 端末の保存領域を食い潰さないための上限
  // 1レース×1出所タグあたりの上限。同じ読み(出所)で何十点も流すと、
  // 「その読みが当たったか」ではなく「手広く買ったか」の記録になってしまう。
  var MAX_PER_RACE_TAG = 30;
  var MAX_TAG_LEN = 20;       // 出所タグの長さ
  var MAX_AMOUNT = 1000000;   // 金額の上限(入力ミスでとんでもない額が残らないように)

  // 券種ごとの「艇番を何個選ぶか」と「順番に意味があるか」。
  // 買い目の形を検算するのに使う。表示順もこの順。
  var KEN = [
    { id: "単勝",   n: 1, ordered: false, label: "単勝" },
    { id: "複勝",   n: 1, ordered: false, label: "複勝" },
    { id: "2連単",  n: 2, ordered: true,  label: "2連単" },
    { id: "2連複",  n: 2, ordered: false, label: "2連複" },
    { id: "拡連複", n: 2, ordered: false, label: "拡連複" },
    { id: "3連単",  n: 3, ordered: true,  label: "3連単" },
    { id: "3連複",  n: 3, ordered: false, label: "3連複" }
  ];
  var KEN_BY_ID = {};
  KEN.forEach(function (k) { KEN_BY_ID[k.id] = k; });

  // ---------------------------------------------------------------- 形の検算

  /** "2026-08-31:児島:7" の形か。結果データの重複排除キーと同じ規約。 */
  function isKey(s) {
    return typeof s === "string" && /^\d{4}-\d{2}-\d{2}:[^:]+:([1-9]|1[0-2])$/.test(s);
  }

  function isLane(n) {
    return typeof n === "number" && n >= 1 && n <= 6 && n === Math.floor(n);
  }

  /**
   * 買い目が券種の形に合っているか。
   * 順番に意味がある券種(2連単・3連単)は並び順まで含めて1点、
   * 意味が無い券種は集合として扱う。どちらも同じ艇番の重複は認めない。
   */
  function isBet(ken, lanes) {
    var spec = KEN_BY_ID[ken];
    if (!spec || !Array.isArray(lanes) || lanes.length !== spec.n) return false;
    if (!lanes.every(isLane)) return false;
    var seen = {};
    for (var i = 0; i < lanes.length; i++) {
      if (seen[lanes[i]]) return false;
      seen[lanes[i]] = true;
    }
    return true;
  }

  /** 保存されている1件が読める形か。1つでも欠けていたら無かったことにする。 */
  function isRecord(r) {
    return !!r && typeof r === "object" &&
      isKey(r.key) &&
      typeof r.ken === "string" && KEN_BY_ID[r.ken] &&
      isBet(r.ken, r.lanes) &&
      typeof r.amount === "number" && r.amount > 0 && r.amount <= MAX_AMOUNT &&
      typeof r.at === "string" &&
      typeof r.id === "string";
  }

  // ---------------------------------------------------------------- 読み書き

  function readAll() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      // 端末の保存領域は外から書き換えられうるので、読むたびに形を確かめる。
      // おかしな値は無かったことにする(黙って落とす)。favorites.js と同じ流儀。
      return Array.isArray(arr) ? arr.filter(isRecord) : [];
    } catch (e) {
      return [];
    }
  }

  function writeAll(arr) {
    try {
      localStorage.setItem(KEY, JSON.stringify(arr));
      return true;
    } catch (e) {
      // 保存できない環境(プライベートモード・容量超過)では記録が次回に
      // 残らないだけにし、それ以外の動作は妨げない。
      // ただし「保存したつもりで消えていた」は困るので、呼び出し側が
      // 気づけるように false を返す。
      return false;
    }
  }

  // ---- スナップショット(レース単位で1つ) ----

  function readSnaps() {
    try {
      var raw = localStorage.getItem(SNAP_KEY);
      if (!raw) return {};
      var o = JSON.parse(raw);
      return (o && typeof o === "object" && !Array.isArray(o)) ? o : {};
    } catch (e) {
      return {};
    }
  }

  function writeSnaps(o) {
    try {
      localStorage.setItem(SNAP_KEY, JSON.stringify(o));
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * 記録ごとに抱えていたスナップショットを、レース単位の置き場へ寄せる。
   *
   * P1-1では1件ごとに data.js のレース要素(約2.2KB)を持たせていた。同じレースに
   * 複数記録すると同じ中身が何個も並ぶので、レースキーで1つに畳む。
   * 中身は変えない(「本人が見ていた数字」をそのまま残す、という芯は動かさない)。
   * 同じレースに違うスナップショットが来ることは無い(同じ日の同じレースの
   * data.js要素なので)が、万一来ても先に入っているほうを残す。
   */
  function migrateSnapshots() {
    var all;
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return;
      all = JSON.parse(raw);
    } catch (e) {
      return;
    }
    if (!Array.isArray(all)) return;
    var snaps = readSnaps();
    var moved = 0;
    all.forEach(function (r) {
      if (!r || !r.snapshot) return;
      if (r.key && !snaps[r.key]) snaps[r.key] = r.snapshot;
      delete r.snapshot;
      moved++;
    });
    if (!moved) return;
    if (writeSnaps(snaps)) writeAll(all);
  }

  function newId() {
    // 一意であればよく、推測されにくさは要らない(端末内だけの識別子)。
    return String(Date.now()) + "-" + Math.random().toString(36).slice(2, 8);
  }

  // ---------------------------------------------------------------- 締切

  /**
   * 締切を過ぎているか。data.js の締切予定("HH:MM")と、その開催日で判定する。
   *
   * 【JSTで判定する理由】
   * 締切予定は日本の競走の時刻なので、常に日本時間で読む。端末のタイムゾーン
   * (new Date(...).setHours 等が使うローカル時刻)で判定すると、端末を海外時間に
   * していたり旅行中だったりするだけで判定がずれる。UTCの端末なら9時間ぶん
   * 早く「締切後」になり、記録できるはずのレースが記録できなくなる。
   *
   * 日本は1951年以降サマータイムが無いので、JSTは年間を通して UTC+9 で固定。
   * Date.UTC で「その日のJSTの締切時刻」を世界共通の時刻に直し、
   * 端末のタイムゾーンに一切依存しない形で今と比べる。
   *
   * 時計そのものは端末のものを信じる。ここは不正防止の仕組みではなく、
   * 「結果を見てから記録しても意味がない」ことを本人に伝えるためのもの。
   * 時計を狂わせてまで自分の採点を良く見せたい人を止める必要はない。
   *
   * 締切予定が取れないレースは、判定しようがないので記録を許す
   * (弾いて記録できなくするより、記録できるほうがましと考える)。
   */
  var JST_OFFSET_HOURS = 9;

  function isClosed(dateIso, deadline, nowMs) {
    if (!deadline || !/^\d{1,2}:\d{2}$/.test(deadline)) return false;
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateIso));
    if (!m) return false;
    var hm = deadline.split(":");
    var closeMs = Date.UTC(
      Number(m[1]), Number(m[2]) - 1, Number(m[3]),
      Number(hm[0]) - JST_OFFSET_HOURS, Number(hm[1]), 0, 0
    );
    if (isNaN(closeMs)) return false;
    var now = (typeof nowMs === "number") ? nowMs : Date.now();
    return now > closeMs;
  }

  // ---------------------------------------------------------------- 採点

  // 結果点の配点(30点満点)。読み点(70点)はPhase2で足す。
  var PT_HIT = 20;                              // 当たったこと自体
  var PT_ROI = [[500, 10], [200, 8], [100, 5]]; // 回収率(%)がこれ以上なら、この点
  var MAX_RESULT_PT = 30;

  /**
   * 買い目が当たったか。払戻側の「当たった組」と突き合わせる。
   *
   * 着順から自分で組み立てて判定しない。同着・失格・返還といった扱いは
   * 公式の払戻がすでに答えを出しているので、そちらに従うほうが忠実で、
   * こちらで例外を数え落とす余地も無くなる。
   *
   * 組の表記は券種で違うが、突き合わせ方は3通りしかない:
   *   1艇(単勝・複勝)   … "3"      → 買った艇と一致するか
   *   順番あり(2連単等) … "3-2"    → 押した順のまま一致するか
   *   順番なし(2連複等) … "2-3"    → 並べ替えて一致するか
   * どの券種も「払戻の行のどれかに一致すれば当たり」で統一できる
   * (複勝は2行、拡連複は3行あるため)。
   */
  function matchPay(ken, lanes, rows) {
    var s = KEN_BY_ID[ken];
    if (!s || !Array.isArray(rows)) return null;
    var mine = s.n === 1 ? String(lanes[0])
      : s.ordered ? lanes.join("-")
        : lanes.slice().sort().join("-");
    for (var i = 0; i < rows.length; i++) {
      var c = String(rows[i] && rows[i].c || "");
      var theirs = s.n === 1 ? c
        : s.ordered ? c
          : c.split("-").map(Number).sort().join("-");
      if (theirs === mine) return rows[i];
    }
    return null;
  }

  /** 着順の配列(艇番順)から、1〜3着の艇番を取り出す。 */
  function top3(order) {
    var out = [];
    for (var pos = 1; pos <= 3; pos++) {
      for (var i = 0; i < (order || []).length; i++) {
        if (order[i] === pos) { out.push(i + 1); break; }
      }
    }
    return out;
  }

  function resultPoints(hit, roi) {
    if (!hit) return 0;
    var pt = PT_HIT;
    for (var i = 0; i < PT_ROI.length; i++) {
      if (roi >= PT_ROI[i][0]) { pt += PT_ROI[i][1]; break; }
    }
    return Math.min(pt, MAX_RESULT_PT);
  }

  /**
   * 1件を採点する。payouts の該当レースを渡す。
   * race が無い(その日のファイルに載っていない)場合は null を返し、採点しない。
   */
  function scoreOne(rec, race) {
    if (!race) return null;
    if (race.status) {
      // 中止・返還。当たりでも外れでもないので、点も付けず集計からも外す。
      return { at: new Date().toISOString(), st: "void", pt: null };
    }
    var row = matchPay(rec.ken, rec.lanes, (race.pay || {})[rec.ken]);
    var unit = rec.amount / 100;              // 払戻は100円あたりの金額
    var yen = row ? Math.round(row.y * unit) : 0;
    var roi = rec.amount > 0 ? Math.round(yen / rec.amount * 1000) / 10 : 0;
    return {
      at: new Date().toISOString(),
      st: row ? "hit" : "miss",
      top3: top3(race.order),
      kimarite: race.kimarite || null,
      // 読み点の「波高とコース」に要る。記録の時点では分からない値なので、
      // 採点のときに払戻JSONから拾って一緒に残す。
      wave: race.wx ? race.wx["波高"] : null,
      // 進入コース(艇番順)。AI講評の展開連鎖は艇番ではなく進入コースで引く。
      // 古い払戻JSONには入っていないので、その場合は null のままにする
      // (「枠なりだった」と取り違えないため。艇番で代用もしない)。
      inn: race["in"] || null,
      yen: yen,
      profit: yen - rec.amount,
      roi: roi,
      pop: row && row.p != null ? row.p : null,
      pt: resultPoints(!!row, roi)
    };
  }

  // ---------------------------------------------------------------- 読み点

  // 配点表 v1。点は感覚で決めず、2026-09-02に実データで測った「リフト」
  // (同じ会場×同じコースの平均1着率と比べて何pt動くか)から機械的に割り振った。
  //
  // 【配分の決め方】各項目の観測リフトの幅(最大−最小)で70点を按分し、
  // 帯ごとの点は幅の中の位置に比例させた。恣意的な重み付けはしていない。
  //   全国勝率   +12.6〜−6.2pt (幅18.8) → 26点
  //   平均ST      +8.5〜−4.7pt (幅13.2) → 18点
  //   直近3走     +7.3〜−4.3pt (幅11.6) → 16点
  //   波高×コース +2.6〜−5.0pt (幅 7.6) → 10点
  //
  // 【測ったが入れなかった事実】
  //   当地−全国の勝率差 … 全帯で±0.6pt以内。単調ですらなく、1着率を動かさない
  //   決まり手の型適合   … 強く合う層ほど2連対が下がる(−1.2pt)。指標として逆効果
  //   級別               … A1で+9.0ptだが、全国勝率と同じものを測っている(二重計上)
  //   モーター2連率      … 単調だが最大+2.7ptで、採用の目安(+3pt)に届かない
  // これらは講評(P2-2)に回す。
  //
  // 【期間が項目で違う理由】
  // 全国勝率は番組表(program/)にしか無く、貯め始めが2026-07-26なので39日分しか
  // 測れない。他はresultsから10年分測れる。単調性は明確だが、全国勝率の帯の値は
  // programが貯まったら測り直すこと。
  // 【v1.1での補正】実測リフトが0以下の帯は、すべて0点にした。
  // v1では幅の中の位置で機械的に按分していたため、「1着率が−1.6pt下がる帯」に
  // 6点が付いていた。答案には根拠として「−1.6pt」と書いて出るので、
  // マイナスの事実を示しながら加点する、という矛盾した行になっていた。
  // 加点はプラスの根拠に対してだけ与える。
  var YOMI_VERSION = "v1.1 2026-09";
  var MAX_YOMI_PT = 70;

  var YOMI_TABLE = {
    A: {
      label: "全国勝率", max: 26, period: "39日・35,404走",
      bands: [
        { min: 7.0, pt: 26, lift: "+12.6pt", band: "7.0以上" },
        { min: 6.5, pt: 19, lift: "+7.7pt", band: "6.5〜7.0" },
        { min: 6.0, pt: 14, lift: "+4.0pt", band: "6.0〜6.5" },
        { min: 5.5, pt: 11, lift: "+1.9pt", band: "5.5〜6.0" },
        { min: 5.0, pt: 0, lift: "−1.6pt", band: "5.0〜5.5" },
        { min: -1, pt: 0, lift: "−6.2pt", band: "5.0未満" }
      ]
    },
    B: {
      label: "平均ST", max: 18, period: "10年・334万走",
      // STは小さいほど良いので、帯は上から「速い順」に見る。
      bands: [
        { max: 0.14, pt: 18, lift: "+8.5pt", band: "0.14未満" },
        { max: 0.16, pt: 13, lift: "+4.6pt", band: "0.14〜0.16" },
        { max: 0.18, pt: 0, lift: "−0.2pt", band: "0.16〜0.18" },
        { max: 99, pt: 0, lift: "−4.7pt", band: "0.18以上" }
      ]
    },
    C: {
      label: "直近3走の調子", max: 16, period: "10年・334万走",
      bands: [
        { max: 2.0, pt: 16, lift: "+7.3pt", band: "平均2.0着以内" },
        { max: 3.0, pt: 10, lift: "+2.7pt", band: "平均2.0〜3.0着" },
        { max: 4.0, pt: 0, lift: "−1.0pt", band: "平均3.0〜4.0着" },
        { max: 99, pt: 0, lift: "−4.3pt", band: "平均4.0着より下" }
      ]
    },
    D: {
      label: "波高とコース", max: 10, period: "10年・334万走",
      // [艇番][波高帯] = [点, リフト]。艇番をコースの代わりに使う。
      // 進入コースはレース後にしか分からず、記録した時点では枠しか無いため
      // (枠なり進入は約90%なので近似として使える)。
      // 効くのは1号艇だけで、荒れるほど落ちる。外は波高でほとんど動かない。
      waveBands: ["0-1cm", "2-3cm", "4-5cm", "6cm+"],
      lane: {
        1: [[10, "+2.6pt"], [0, "−0.4pt"], [0, "−3.0pt"], [0, "−5.0pt"]],
        2: [[0, "−0.5pt"], [7, "+0.1pt"], [7, "+0.4pt"], [8, "+1.3pt"]],
        3: [[0, "−0.8pt"], [7, "+0.1pt"], [8, "+1.1pt"], [8, "+0.9pt"]],
        4: [[0, "−0.8pt"], [7, "+0.1pt"], [8, "+0.9pt"], [9, "+1.6pt"]],
        5: [[0, "−0.4pt"], [7, "+0.1pt"], [7, "+0.4pt"], [7, "+0.6pt"]],
        6: [[0, "−0.2pt"], [0, "+0.0pt"], [7, "+0.1pt"], [7, "+0.6pt"]]
      }
    }
  };

  function waveBandIndex(cm) {
    if (cm == null) return null;
    return cm <= 1 ? 0 : cm <= 3 ? 1 : cm <= 5 ? 2 : 3;
  }

  /**
   * 買い目の群から「軸」と「押さえ」を推定する。
   *
   * 【規則】
   * 順序のある券種(単勝・2連単・3連単)が1つでもあれば、
   *   軸   = 1着の位置にいちばん多く置かれた艇
   *   押さえ = それ以外で、買い目全体への登場回数が多い2艇
   * 順不同だけの群(複勝・2連複・3連複・拡連複)は、
   *   軸   = 登場回数がいちばん多い艇
   *   押さえ = 次に多い2艇
   *
   * 同数で並んだときは艇番の小さいほうを上にする。内側のコースほど1着率が
   * 高いので「軸」として自然で、かつ機械的に決まる(こちらの好みが入らない)。
   *
   * あくまで買い目からの推定なので、答案には「推定」と明記して出す。
   */
  function pickAxis(records) {
    var first = {}, all = {};
    var ordered = false;
    records.forEach(function (r) {
      var s = KEN_BY_ID[r.ken];
      if (!s) return;
      if (s.ordered || s.n === 1) ordered = true;
      r.lanes.forEach(function (n, i) {
        all[n] = (all[n] || 0) + 1;
        if (i === 0) first[n] = (first[n] || 0) + 1;
      });
    });
    function rank(counts) {
      return Object.keys(counts).map(Number).sort(function (a, b) {
        return counts[b] - counts[a] || a - b;   // 同数なら艇番の小さい順
      });
    }
    var axis = ordered && Object.keys(first).length ? rank(first)[0] : rank(all)[0];
    if (axis == null) return null;
    var backs = rank(all).filter(function (n) { return n !== axis; }).slice(0, 2);
    return { axis: axis, backs: backs, byFirst: ordered };
  }

  function bandOf(cat, value) {
    var t = YOMI_TABLE[cat];
    for (var i = 0; i < t.bands.length; i++) {
      var b = t.bands[i];
      if (b.min !== undefined ? value >= b.min : value < b.max) return b;
    }
    return t.bands[t.bands.length - 1];
  }

  /**
   * ks(今節/直近の流れ)から平均STと直近の平均着を出す。
   *
   * 【3走に満たないことがある】
   * ks は「今節が2走以上あれば今節、無ければ直近30日」という作りなので、
   * 節の2日目だと今節2走ぶんしか入らない。実際に2026-09-02の大村12Rで
   * 1号艇が r=[4,3] の2件しか無く、3走を要求していたために「不明」になっていた。
   * 少ないなりに直近の調子は分かるので、あるだけで平均を取り、
   * 何走ぶんかを一緒に返す(画面はそれを添えて出す)。
   * 1走だけだと調子ではなく1回の着順でしかないので、その時は判定しない。
   */
  var MIN_FORM_RACES = 2;

  function fromKs(ks) {
    var st = null, form = null, formN = 0;
    if (ks) {
      var s = (ks.s || []).filter(function (x) { return typeof x === "number"; });
      if (s.length) st = s.reduce(function (a, b) { return a + b; }, 0) / s.length;
      var r = (ks.r || []).filter(function (x) { return typeof x === "number"; });
      if (r.length >= MIN_FORM_RACES) {
        var t = r.slice(-3);
        formN = t.length;
        form = t.reduce(function (a, b) { return a + b; }, 0) / t.length;
      }
    }
    return { st: st, last3: form, formN: formN };
  }

  /**
   * 読み点を出す。返り値の rows はそのまま画面に並べられる形にしてある。
   * 1行 = 「+19: 全国勝率6.72（6.5〜7.0の帯は1着率+7.7pt / 39日・35,404走）」
   */
  function yomiScore(records, snap, wave) {
    var pick = pickAxis(records);
    if (!pick || !snap) return null;
    var boat = null;
    (snap.boats || []).forEach(function (b) { if (b.n === pick.axis) boat = b; });
    if (!boat) return null;

    var ks = fromKs(boat.ks);
    var rows = [];
    function push(cat, pt, fact, band, lift, note) {
      var t = YOMI_TABLE[cat];
      rows.push({
        cat: cat, label: t.label, pt: pt, max: t.max,
        fact: fact, band: band, lift: lift, period: t.period, note: note || null,
        line: (pt >= 0 ? "+" : "") + pt + ": " + fact +
          (note ? "（" + note + "）"
                : "（" + band + "は1着率" + lift + " / " + t.period + "）")
      });
    }

    // A 全国勝率
    if (typeof boat.nw === "number" && boat.nw > 0) {
      var a = bandOf("A", boat.nw);
      push("A", a.pt, "全国勝率 " + boat.nw.toFixed(2), a.band, a.lift);
    } else {
      push("A", 0, "全国勝率 不明", null, null, "この項目は判定できませんでした");
    }
    // B 平均ST
    if (ks.st != null) {
      var b = bandOf("B", ks.st);
      push("B", b.pt, "平均ST " + ks.st.toFixed(3), b.band, b.lift);
    } else {
      push("B", 0, "平均ST 不明", null, null, "この項目は判定できませんでした");
    }
    // C 直近3走
    if (ks.last3 != null) {
      var c = bandOf("C", ks.last3);
      // 何走ぶんで見たかを必ず添える。3走揃っていない日があるため、
      // 「直近3走」と書いてしまうと事実と違う。
      push("C", c.pt, "直近" + ks.formN + "走の平均 " + ks.last3.toFixed(1) + "着",
           c.band, c.lift,
           ks.formN < 3 ? null : undefined);
      if (ks.formN < 3) {
        rows[rows.length - 1].line += "（今節" + ks.formN + "走ぶんで判定）";
      }
    } else {
      push("C", 0, "直近の成績が不足", null, null,
           "今節が始まったばかりで、判定に使える走行がありません");
    }
    // D 波高×コース
    var wi = waveBandIndex(wave);
    var lane = YOMI_TABLE.D.lane[pick.axis];
    if (wi != null && lane) {
      var d = lane[wi];
      push("D", d[0], "波高 " + wave + "cm・" + pick.axis + "号艇",
           pick.axis + "号艇×" + YOMI_TABLE.D.waveBands[wi], d[1]);
    } else {
      push("D", 0, "波高 不明", null, null, "この項目は判定できませんでした");
    }

    var total = rows.reduce(function (s, r) { return s + r.pt; }, 0);
    return {
      version: YOMI_VERSION, axis: pick.axis, backs: pick.backs,
      byFirst: pick.byFirst, rows: rows, pt: total, max: MAX_YOMI_PT
    };
  }

  // ---------------------------------------------------------------- 講評

  // 1コースの1着が、どの決まり手で出るか(10年・波高帯別)。条件の一行に使う。
  // 波が荒れるほど「逃げ」が減って「抜き」が増える。
  var NIGE_BY_WAVE = { "0-1cm": 96.0, "2-3cm": 95.1, "4-5cm": 93.9, "6cm+": 91.8 };
  // 2連対のリフト(10年)。押さえの一行に使う。1着率ではなく2連対で見るのは、
  // 押さえは「2〜3着に来てくれれば当たり」の買い方だから。
  var LIFT_P2 = {
    st: [{ max: 0.14, lift: "+11.6pt", band: "0.14未満" },
         { max: 0.16, lift: "+7.1pt", band: "0.14〜0.16" }],
    last3: [{ max: 2.0, lift: "+11.2pt", band: "平均2.0着以内" },
            { max: 3.0, lift: "+4.7pt", band: "平均2.0〜3.0着" }]
  };
  var PERIOD_10Y = "10年・334万走";
  var DISCLAIMER = "採点はレース時点の気象（競走成績）で行っています。" +
    "締切前に見た直前情報とはズレることがあります。";

  function firstBand(list, v) {
    for (var i = 0; i < list.length; i++) if (v < list[i].max) return list[i];
    return null;
  }

  /**
   * 講評(赤ペンの言葉)を組み立てる。点には一切影響しない。
   *
   * 【文章にする理由(v2)】
   * v1は事実を並べるだけだったので、読んでも「で、自分の読みは何だったのか」が
   * 残らなかった。総評→あなたの選択→事実→学び、の順に組み替える。
   * 文はすべて定型で、数値・帯・リフトを差し込むだけ(生成AIは使わない)。
   *
   * 【書かないと決めていること】
   * 「買うべきだった」とは書かない。正解の買い目も示さない。特定の買い目を
   * すすめない。次は当たる、といった未来の断定もしない。低い評価のときも
   * 事実の提示で止め、人格には触れない。
   * 防御句(点に入れていません等)は最後の1行に集約し、本文には混ぜない。
   *
   * catches は登番→二つ名の対応(players_list.js から作る)。無くても動く。
   */
  var MAX_COMMENT_LINES = 7;

  var HINTS = {
    form: "次に読むときは、勝率とSTの上位2艇が枠のどこにいるかを先に確認すると、" +
      "押さえの選択肢が広がります。",
    cond: "直近3走の平均着は、番組表の勝率では見えない「今」を写す数字です。",
    wave: "波高4cm以上の日は、1号艇を疑うところから読みが始まります。"
  };

  function comment(records, snap, wave, catches, yomi, result) {
    if (!snap || !snap.boats || !yomi) return [];
    var axis = yomi.axis;
    var picked = {};
    records.forEach(function (r) { r.lanes.forEach(function (n) { picked[n] = true; }); });
    var byLane = {};
    snap.boats.forEach(function (b) { byLane[b.n] = b; });
    var row = {};
    yomi.rows.forEach(function (r) { row[r.cat] = r; });
    var lines = [];

    // ---- ① 総評 ----
    // 読み点の帯で決め、結果が出ている答案は組み合わせで差し替える。
    // 「読みは良かったが外れた」を、外れとしてではなく続けてよい読み方として書く。
    var pt = yomi.pt;
    var band = pt >= 50 ? "high" : pt >= 30 ? "mid" : "low";
    var st = result && result.status;
    var head;
    if (st === "hit" && band === "high") {
      head = "読みと結果が噛み合った答案です。";
    } else if (st === "miss" && band === "high") {
      head = "読みは立っていました。結果がついてこなかっただけで、続けていい読み方です。";
    } else if (st === "hit" && band === "low") {
      head = "的中しましたが、再現の根拠は薄い答案です。数字より運が働いた日かもしれません。";
    } else if (band === "high") {
      head = "軸の選び方に根拠のある答案です。";
    } else if (band === "mid") {
      head = "読みの軸は立っていますが、拾える材料がまだ残っています。";
    } else {
      head = "今回は、番組表の事実と買い目がまだ結びついていない答案です。";
    }
    lines.push({ kind: "head", text: head });

    // ---- ② 軸の評価 ----
    // 選手の力を表すA(全国勝率)とB(平均ST)の合計で見る。
    // C(調子)とD(波高)はその日の事情なので、軸の選び方の評価には入れない。
    var ab = (row.A ? row.A.pt : 0) + (row.B ? row.B.pt : 0);
    if (ab >= 30) {
      lines.push({ kind: "axis", text: "軸に" + axis + "号艇を選んだのは良い読みです。" +
        row.A.fact + "、" + row.B.fact + "と、軸に置く条件が実測で揃っていました。" });
    } else if (ab >= 15) {
      var best = yomi.rows.slice().sort(function (a, b) { return b.pt - a.pt; })[0];
      var flat = yomi.rows.filter(function (r) { return r.pt === 0; })
        .map(function (r) { return r.label; });
      lines.push({ kind: "axis", text: "軸の" + axis + "号艇には" + best.fact +
        "という材料があります。" +
        (flat.length ? "一方、" + flat.join("・") + "は並でした。" : "") });
    } else {
      var b0 = byLane[axis] || {};
      var ks0 = fromKs(b0.ks);
      lines.push({ kind: "axis", text: "軸の" + axis +
        "号艇は、1着率を押し上げる実測の材料が見当たりませんでした（全国勝率" +
        (typeof b0.nw === "number" ? b0.nw.toFixed(2) : "—") + "・平均ST" +
        (ks0.st != null ? ks0.st.toFixed(3) : "—") + "）。" });
    }

    // ---- ③ 押さえの評価(最大1行) ----
    // 押さえは2〜3着に来てくれれば当たりなので、1着率ではなく2連対で見る。
    for (var i = 0; i < yomi.backs.length; i++) {
      var bb = byLane[yomi.backs[i]];
      if (!bb) continue;
      var k = fromKs(bb.ks);
      var hs = k.st != null ? firstBand(LIFT_P2.st, k.st) : null;
      var hf = k.last3 != null ? firstBand(LIFT_P2.last3, k.last3) : null;
      if (!hs && !hf) continue;
      var what = hs ? "平均ST" + k.st.toFixed(3)
        : "直近" + k.formN + "走の平均" + k.last3.toFixed(1) + "着";
      var lift = (hs || hf).lift;
      lines.push({ kind: "back", text: "押さえの" + yomi.backs[i] + "号艇も根拠があります。" +
        what + "は2連対" + lift + "の帯で、上位に食い込む型です。" });
      break;
    }

    // ---- ④ 見送った材料(最大2件)+学びのヒント ----
    var missed = [];
    snap.boats.forEach(function (b) {
      if (picked[b.n]) return;
      var ks = fromKs(b.ks);
      var cands = [];
      if (typeof b.nw === "number" && b.nw > 0) {
        var a = bandOf("A", b.nw);
        if (a.pt > 0) cands.push({ pt: a.pt, cat: "form", t: "全国勝率" + b.nw.toFixed(2), lift: a.lift });
      }
      if (ks.st != null) {
        var s = bandOf("B", ks.st);
        if (s.pt > 0) cands.push({ pt: s.pt, cat: "form", t: "平均ST" + ks.st.toFixed(3), lift: s.lift });
      }
      if (ks.last3 != null) {
        var c = bandOf("C", ks.last3);
        if (c.pt > 0) cands.push({ pt: c.pt, cat: "cond", t: "直近" + ks.formN + "走の平均" + ks.last3.toFixed(1) + "着", lift: c.lift });
      }
      if (!cands.length) return;
      cands.sort(function (x, y) { return y.pt - x.pt; });
      missed.push({ n: b.n, pt: cands[0].pt, c: cands[0] });
    });
    missed.sort(function (x, y) { return y.pt - x.pt; });
    missed.slice(0, 2).forEach(function (m) {
      lines.push({ kind: "missed", text: "一方で、" + m.n + "号艇（" + m.c.t + "・1着率" +
        m.c.lift + "）にも同格の材料がありましたが、今回の買い目には入っていません。" });
    });
    var hintCat = missed.length ? missed[0].c.cat
      : (waveBandIndex(wave) != null && waveBandIndex(wave) >= 2 ? "wave" : null);
    if (hintCat) lines.push({ kind: "hint", text: HINTS[hintCat] });

    // ---- ⑤ 条件(荒れた日だけ) ----
    var wi = waveBandIndex(wave);
    if (wi != null && wi >= 2) {
      var wb = YOMI_TABLE.D.waveBands[wi];
      lines.push({ kind: "cond", text: "波高" + wave + "cm。この波高帯の1コース逃げ率は" +
        NIGE_BY_WAVE[wb].toFixed(1) + "%（穏やかな日は" + NIGE_BY_WAVE["0-1cm"].toFixed(1) +
        "%）。荒れるほど逃げ切りが減り、抜きが増えます。" });
    }

    // 7行に収める。溢れたら見送った材料の2件目から落とす
    // (総評・軸・押さえ・学び・条件のほうが、答案として残るものが多い)。
    while (lines.length >= MAX_COMMENT_LINES) {
      var idx = -1;
      for (var j = lines.length - 1; j >= 0; j--) if (lines[j].kind === "missed") { idx = j; break; }
      if (idx < 0) break;
      lines.splice(idx, 1);
    }

    // ---- ⑥ ※点外の事実と免責(1行に集約) ----
    // 防御句はここに1回だけ。本文には混ぜない。
    var out = {};
    [axis].concat(yomi.backs).forEach(function (n) {
      var b = byLane[n];
      if (!b) return;
      if (typeof b.mo === "number" && b.mo >= 40) out["モーター2率"] = true;
      var cat = catches && catches[b.t];
      if ((cat && /巧者|の主/.test(cat)) ||
          (typeof b.lw === "number" && typeof b.nw === "number" && b.lw > 0 && b.lw - b.nw >= 1.0)) {
        out["当地の強さ"] = true;
      }
      if (b.k === "A1" || b.k === "A2") out["級別"] = true;
    });
    var names = Object.keys(out);
    lines.push({ kind: "note", text: "※" +
      (names.length ? names.join("・") + "は、実測で1着率を動かさない（または基準未満の）ため" +
        "点に入れていません。" : "") +
      "採点はレース時点の気象で行っています。" });
    return lines;
  }

  /**
   * 1答案(同じレース×同じ出所タグの買い目の束)の結果点。
   * 的中が1つでもあれば的中、回収率は束全体の払戻÷投入で計算し直す。
   */
  function groupResult(records) {
    var bet = 0, yen = 0, hit = false, judged = 0, voided = 0, pending = 0;
    records.forEach(function (r) {
      var s = r.score;
      if (!s) { pending++; return; }
      if (s.st === "void") { voided++; return; }
      if (s.st === "nodata") { pending++; return; }
      judged++;
      bet += r.amount; yen += s.yen;
      if (s.st === "hit") hit = true;
    });
    if (!judged) return { status: voided && !pending ? "void" : "pending" };
    var roi = bet > 0 ? Math.round(yen / bet * 1000) / 10 : 0;
    return {
      status: hit ? "hit" : "miss", bet: bet, yen: yen,
      profit: yen - bet, roi: roi, pt: resultPoints(hit, roi),
      max: MAX_RESULT_PT, voided: voided, pending: pending
    };
  }

  /** 今日(JST)の日付。集計の窓を切るのに使う。端末のTZに依存させない。 */
  function todayJst() {
    return new Date(Date.now() + JST_OFFSET_HOURS * 3600000).toISOString().slice(0, 10);
  }

  // ---------------------------------------------------------------- 公開API

  // 記録ごとに抱えていたスナップショットを、レース単位の置き場へ寄せる。
  // 公開APIを組み立てる前に済ませ、以後は新しい形だけを相手にする。
  migrateSnapshots();

  window.TeiyomiYomi = {
    KEN: KEN,
    MAX_TAG_LEN: MAX_TAG_LEN,
    MAX_AMOUNT: MAX_AMOUNT,
    MAX_PER_RACE_TAG: MAX_PER_RACE_TAG,

    /** 新しい順に全件。 */
    list: function () {
      return readAll().sort(function (a, b) { return a.at < b.at ? 1 : a.at > b.at ? -1 : 0; });
    },

    /** 1レース分だけ。同じレースに複数の買い目を記録できる(出所タグ違い等)。 */
    listByRace: function (key) {
      return readAll().filter(function (r) { return r.key === key; });
    },

    count: function () {
      return readAll().length;
    },

    /** これまでに使った出所タグを、よく使う順に返す(入力候補にする)。 */
    tags: function () {
      var c = {};
      readAll().forEach(function (r) {
        if (r.tag) c[r.tag] = (c[r.tag] || 0) + 1;
      });
      return Object.keys(c).sort(function (a, b) { return c[b] - c[a]; });
    },

    isClosed: isClosed,
    isBet: isBet,

    /**
     * 1件記録する。
     * 返り値: {ok:true, record} / {ok:false, reason}
     *   reason: "bad_key" | "bad_bet" | "bad_amount" | "closed" | "too_many" | "storage"
     *
     * snapshot は記録した時点の data.js のレース要素そのもの。
     * ここで加工・間引きをしない(あとから「何が見えていたか」を復元するため)。
     */
    add: function (opt) {
      opt = opt || {};
      if (!isKey(opt.key)) return { ok: false, reason: "bad_key" };
      if (!isBet(opt.ken, opt.lanes)) return { ok: false, reason: "bad_bet" };

      var amount = Number(opt.amount);
      if (!isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) {
        return { ok: false, reason: "bad_amount" };
      }
      amount = Math.floor(amount);

      var dateIso = opt.key.split(":")[0];
      if (isClosed(dateIso, opt.deadline)) return { ok: false, reason: "closed" };

      var all = readAll();
      if (all.length >= MAX_RECORDS) return { ok: false, reason: "too_many" };

      var tag = String(opt.tag || "").slice(0, MAX_TAG_LEN);
      var sameTag = all.filter(function (r) {
        return r.key === opt.key && (r.tag || "") === tag;
      }).length;
      if (sameTag >= MAX_PER_RACE_TAG) return { ok: false, reason: "too_many_here" };

      var rec = {
        id: newId(),
        key: opt.key,
        at: new Date().toISOString(),
        ken: opt.ken,
        lanes: opt.lanes.slice(),
        tag: tag,
        amount: amount,
        // 採点はP1-3で入れる。器だけ先に用意しておく
        // (あとから列を足すより、最初から空で持っておくほうが読み書きが素直)。
        score: null
      };

      // スナップショットはレース単位で1つ。2件目以降は保存し直さない
      // (同じレースなら中身も同じで、記録ごとに持つと約2.2KBずつ無駄に増える)。
      if (opt.snapshot) {
        var snaps = readSnaps();
        if (!snaps[opt.key]) {
          snaps[opt.key] = opt.snapshot;
          if (!writeSnaps(snaps)) return { ok: false, reason: "storage" };
        }
      }

      all.push(rec);
      if (!writeAll(all)) return { ok: false, reason: "storage" };
      return { ok: true, record: rec };
    },

    /**
     * AI講評を、その答案に端末保存する。保存できたら true。
     *
     * 答案(レース×出所タグ)につき1つなので、その答案の最初の記録の score に
     * 置く。記録ごとに持たせると同じ文章が何本も残る。
     *
     * 二度と送らないための印でもある。再表示はここから読むだけで、
     * ネットワークにも回数にも触らない。
     */
    setAi: function (key, tag, ai) {
      if (!ai || typeof ai.text !== "string" || !ai.text) return false;
      var all = readAll();
      var target = null;
      for (var i = 0; i < all.length; i++) {
        var r = all[i];
        if (r.key !== key || (r.tag || "") !== (tag || "")) continue;
        if (!r.score) continue;          // 未採点の答案には付けない
        target = r;
        break;
      }
      if (!target) return false;
      target.score.ai = {
        text: String(ai.text).slice(0, 4000),
        model: String(ai.model || "").slice(0, 60),
        at: new Date().toISOString()
      };
      return writeAll(all);
    },

    /** そのレースのスナップショット(記録時点の data.js のレース要素)。 */
    snapshot: function (key) {
      return readSnaps()[key] || null;
    },

    /** そのレースの記録数を、出所タグごとに数える。 */
    countByTag: function (key) {
      var c = {};
      readAll().forEach(function (r) {
        if (r.key !== key) return;
        var t = r.tag || "";
        c[t] = (c[t] || 0) + 1;
      });
      return c;
    },

    /** 1件消す。消せたら true。 */
    remove: function (id) {
      var all = readAll();
      var gone = null;
      var next = all.filter(function (r) {
        if (r.id === id) { gone = r; return false; }
        return true;
      });
      if (!gone) return false;
      if (!writeAll(next)) return false;
      // そのレースの記録が全部消えたら、スナップショットも一緒に片付ける。
      // 参照する記録が無いのに約2.2KBが残り続けるのを防ぐ。
      var stillUsed = next.some(function (r) { return r.key === gone.key; });
      if (!stillUsed) {
        var snaps = readSnaps();
        if (snaps[gone.key]) { delete snaps[gone.key]; writeSnaps(snaps); }
      }
      return true;
    },

    MAX_RESULT_PT: MAX_RESULT_PT,
    MAX_YOMI_PT: MAX_YOMI_PT,
    YOMI_VERSION: YOMI_VERSION,
    YOMI_TABLE: YOMI_TABLE,
    pickAxis: pickAxis,
    yomiScore: yomiScore,
    comment: comment,
    groupResult: groupResult,

    /**
     * 答案(レース×出所タグ)の一覧。新しい順。
     * 読み点はこの単位で1つなので、画面もこの単位で並べる。
     */
    papers: function () {
      var by = {};
      readAll().forEach(function (r) {
        var id = r.key + "\t" + (r.tag || "");
        if (!by[id]) by[id] = { key: r.key, tag: r.tag || "", at: r.at, records: [] };
        by[id].records.push(r);
        if (r.at > by[id].at) by[id].at = r.at;
      });
      return Object.keys(by).map(function (k) { return by[k]; })
        .sort(function (a, b) { return a.at < b.at ? 1 : a.at > b.at ? -1 : 0; });
    },

    /** 1答案だけ取り出す。答案ページが ?key=&tag= から引くのに使う。 */
    paper: function (key, tag, catches) {
      var recs = readAll().filter(function (r) {
        return r.key === key && (r.tag || "") === (tag || "");
      });
      if (!recs.length) return null;
      var wave = null;
      recs.forEach(function (r) {
        if (r.score && r.score.wave != null) wave = r.score.wave;
      });
      var snap = readSnaps()[key] || null;
      var result = groupResult(recs);
      // 【結果が出るまでは採点も講評も出さない】
      // 読み点は記録した時点の事実だけで計算できてしまうので、放っておくと
      // レース前に「あなたの読みは54点」と出る。それは買い目への評価=予想に
      // なってしまい、艇読みが予想印を出さないと決めていることと矛盾する。
      // 講評も同じで、レース前に「3号艇の全国勝率7.49に触れていない」と出せば、
      // それは買い足しの示唆になる。判定はここ1か所に置き、画面側が
      // うっかり出せないようにしてある。
      var settled = result.status === "hit" || result.status === "miss" ||
        result.status === "void";
      var yomiOut = settled ? yomiScore(recs, snap, wave) : null;
      var ai = null;
      recs.forEach(function (r) { if (!ai && r.score && r.score.ai) ai = r.score.ai; });
      // 進入コースは採点のときに払戻から拾ってある。答案の中では1つなので、
      // 見つかった最初のものを使う。
      var inn = null;
      recs.forEach(function (r) { if (!inn && r.score && r.score.inn) inn = r.score.inn; });
      return {
        key: key, tag: tag || "", records: recs, snapshot: snap, wave: wave,
        result: result, settled: settled,
        yomi: yomiOut,
        inn: inn,
        // AI講評。生成済みなら端末に残っている(同じ答案を二度は送らない)。
        ai: settled ? ai : null,
        comment: settled ? comment(recs, snap, wave, catches, yomiOut, result) : []
      };
    },

    todayJst: todayJst,
    scoreOne: scoreOne,
    matchPay: matchPay,

    /** まだ採点していない記録の、レース開催日の一覧(古い順・重複なし)。 */
    /**
     * 払戻JSONを取りに行くべき日付の一覧(古い順・重複なし)。
     *
     * まだ採点していないものに加え、採点済みでも波高を持っていないものを含める。
     * 波高は読み点(D)に要るが、P1-3の採点では拾っていなかった。取り直して
     * 書き直せば、以前の記録にも遡って読み点が付く。
     */
    unscoredDates: function () {
      var seen = {};
      readAll().forEach(function (r) {
        var s = r.score;
        var stale = s && (s.st === "hit" || s.st === "miss") &&
          (s.wave === undefined || s.inn === undefined);
        if (!s || stale) seen[r.key.split(":")[0]] = true;
      });
      return Object.keys(seen).sort();
    },

    /**
     * その日の結果は手に入らないと諦める。
     *
     * payouts が404で、しかもレース当日でも前日でもない場合に使う。放っておくと
     * マイページを開くたびに同じ404を叩き続け、コンソールにも出続ける。
     * 「取れなかった」という結末も一つの結末なので、記録に書いて先へ進む。
     */
    markNoData: function (dateIso) {
      var all = readAll();
      var n = 0;
      all.forEach(function (r) {
        if (r.score || r.key.split(":")[0] !== dateIso) return;
        r.score = { at: new Date().toISOString(), st: "nodata", pt: null };
        n++;
      });
      if (n) writeAll(all);
      return n;
    },

    /**
     * その日の payouts を渡して、その日の記録をまとめて採点し、書き戻す。
     * 採点した件数を返す。一度採点したら二度と取りに行かない
     * (結果は変わらないので、毎回ネットワークに出る意味が無い)。
     */
    applyPayouts: function (dateIso, doc) {
      var races = (doc && doc.races) || {};
      var all = readAll();
      var n = 0;
      all.forEach(function (r) {
        if (r.key.split(":")[0] !== dateIso) return;
        // 採点済みでも、波高を持っていないものは採点し直す(読み点Dに要るため)。
        // 結果は変わらないので上書きして問題ない。
        var stale = r.score && (r.score.st === "hit" || r.score.st === "miss") &&
          (r.score.wave === undefined || r.score.inn === undefined);
        if (r.score && !stale) return;
        var s = scoreOne(r, races[r.key]);
        if (s) { r.score = s; n++; }
      });
      if (n) writeAll(all);
      return n;
    },

    /**
     * 直近days日(レース開催日で数える)の集計。
     * 返り値: {all, byTag:{}, byKen:{}} で、それぞれ
     *   {n, hit, miss, void, bet, yen, profit, roi, hitRate, pt}
     * 不成立(void)は件数だけ数え、的中率・回収率の分母には入れない。
     */
    summary: function (days) {
      days = days || 30;
      var since = new Date(Date.parse(todayJst() + "T00:00:00Z") - (days - 1) * 86400000)
        .toISOString().slice(0, 10);
      function blank() {
        return { n: 0, hit: 0, miss: 0, "void": 0, pending: 0, bet: 0, yen: 0, pt: 0, ptn: 0 };
      }
      function fin(a) {
        var judged = a.hit + a.miss;
        a.profit = a.yen - a.bet;
        a.roi = a.bet > 0 ? Math.round(a.yen / a.bet * 1000) / 10 : null;
        a.hitRate = judged > 0 ? Math.round(a.hit / judged * 1000) / 10 : null;
        a.avgPt = a.ptn > 0 ? Math.round(a.pt / a.ptn * 10) / 10 : null;
        return a;
      }
      var out = { all: blank(), byTag: {}, byKen: {}, since: since, days: days };
      readAll().forEach(function (r) {
        if (r.key.split(":")[0] < since) return;      // 窓の外は集計しない
        var s = r.score;
        var tag = r.tag || "（タグなし）";
        // 記録した数はそのまま数える。採点がまだのものを件数から落とすと、
        // 今日記録したばかりの人に「記録0件」と見えて壊れて見える。
        // 率と金額の勘定にだけ入れない。
        [out.all,
         out.byTag[tag] || (out.byTag[tag] = blank()),
         out.byKen[r.ken] || (out.byKen[r.ken] = blank())].forEach(function (a) {
          a.n++;
          // 採点待ちと「結果が取れなかった」は、率にも金額にも入れない。
          if (!s || s.st === "nodata") { a.pending++; return; }
          if (s.st === "void") { a["void"]++; return; }
          if (s.st === "hit") a.hit++; else a.miss++;
          a.bet += r.amount;
          a.yen += s.yen;
          a.pt += s.pt;
          a.ptn++;
        });
      });
      fin(out.all);
      Object.keys(out.byTag).forEach(function (k) { fin(out.byTag[k]); });
      Object.keys(out.byKen).forEach(function (k) { fin(out.byKen[k]); });
      return out;
    },

    /** 買い目を "1-2-3"(順番あり) / "1=2"(順番なし) の形にする。 */
    betText: function (ken, lanes) {
      var spec = KEN_BY_ID[ken];
      if (!spec) return "";
      if (spec.ordered) return lanes.join("-");
      return lanes.slice().sort().join("=");
    }
  };
})();
