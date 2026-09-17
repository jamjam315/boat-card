// 読み採点エンジン(yomi.js)のテスト。AI-14 v1① で新設。
//   node --test tests/*.test.mjs
//
// 守りたいのは4つ。
//   1. 結果点(scoreOne・groupResult)・軸の推定(pickAxis)・読み点(yomiScore)・赤ペン講評(comment)が
//      配点表どおりに出る(手で計算した値と比べる)
//   2. buildPaper は端末の保存領域も日付も使わない。日付を消しても答案は1文字も変わらず、
//      paper()(端末に保存した記録から作る答案)と同じものを返す。今日の一問はこれを使う
//   3. 実レース7本×6通りの答案が、固定した出力(tests/fixtures/yomi-engine-expected.json)と一致する。
//      答案の部品化(v1②)や今日の一問で、採点の中身をうっかり変えないため。
//      採点を意図して変えたときは UPDATE_GOLDEN=1 node --test tests/yomi-engine.test.mjs で作り直し、
//      差分を目で確かめてからコミットする
//   4. window の無い環境(Deno 等)でも globalThis.TeiyomiYomi として読める(v2 のサーバー採点の布石)
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = readFileSync(join(ROOT, "yomi.js"), "utf8");
const RACES = JSON.parse(readFileSync(join(ROOT, "tests/fixtures/yomi-engine-races.json"), "utf8")).races;
const GOLDEN_PATH = join(ROOT, "tests/fixtures/yomi-engine-expected.json");

// 採点の時刻(at)が毎回変わらないよう時計を固定する
const NOW = "2030-06-01T00:00:00.000Z";
class FixedDate extends Date {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return Date.parse(NOW); }
}

function loadYomi(store = {}) {
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
  };
  const win = { localStorage };
  vm.runInNewContext(SRC, { window: win, localStorage, Date: FixedDate });
  return win.TeiyomiYomi;
}

// vm の中で作られた値は別コンテキストのものなので、JSON を通してから比べる
const plain = (x) => JSON.parse(JSON.stringify(x));
const Y = loadYomi();

// ---------------------------------------------------------------- 1. 配点どおりに出るか

const rec = (ken, lanes, amount = 100, extra = {}) =>
  ({ key: "2026-09-11:大村:11", ken, lanes, amount, tag: "", id: ken + lanes.join(""), at: NOW, ...extra });

// 払戻は100円あたり。order は艇番順の着
const RACE = {
  order: [1, 3, 2, 5, 4, 6], in: [1, 2, 3, 4, 5, 6], kimarite: "逃げ",
  wx: { "天候": "晴", "風向": "北", "風速": 2, "波高": 1 },
  pay: {
    "単勝": [{ c: "1", y: 150 }],
    "複勝": [{ c: "1", y: 100 }, { c: "3", y: 230 }],
    "2連複": [{ c: "1-3", y: 480, p: 2 }],
    "拡連複": [{ c: "1-3", y: 190, p: 2 }, { c: "1-2", y: 250, p: 4 }, { c: "2-3", y: 600, p: 9 }],
    "3連単": [{ c: "1-3-2", y: 670, p: 2 }],
  },
};

test("scoreOne: 払戻どおりに当たり/外れ・金額・回収率・結果点を出す", () => {
  const hit = plain(Y.scoreOne(rec("3連単", [1, 3, 2], 200), RACE));
  assert.deepStrictEqual(
    { st: hit.st, yen: hit.yen, profit: hit.profit, roi: hit.roi, pop: hit.pop, pt: hit.pt, top3: hit.top3, wave: hit.wave, kimarite: hit.kimarite },
    { st: "hit", yen: 1340, profit: 1140, roi: 670, pop: 2, pt: 30, top3: [1, 3, 2], wave: 1, kimarite: "逃げ" });

  const miss = plain(Y.scoreOne(rec("3連単", [1, 2, 3], 100), RACE));
  assert.deepStrictEqual({ st: miss.st, yen: miss.yen, profit: miss.profit, roi: miss.roi, pt: miss.pt },
    { st: "miss", yen: 0, profit: -100, roi: 0, pt: 0 });

  // 順番に意味の無い券種は並べ替えて突き合わせる。複勝・拡連複は払戻の行が複数ある
  assert.strictEqual(plain(Y.scoreOne(rec("2連複", [3, 1]), RACE)).yen, 480);
  assert.strictEqual(plain(Y.scoreOne(rec("複勝", [3]), RACE)).yen, 230);
  assert.strictEqual(plain(Y.scoreOne(rec("拡連複", [3, 2]), RACE)).yen, 600);
  // 払戻の無い券種(この例では2連単)は外れ
  assert.strictEqual(plain(Y.scoreOne(rec("2連単", [1, 3]), RACE)).st, "miss");
  // レースが払戻に無ければ採点しない / 不成立は返還
  assert.strictEqual(Y.scoreOne(rec("単勝", [1]), undefined), null);
  assert.strictEqual(plain(Y.scoreOne(rec("単勝", [1]), { status: "不成立" })).st, "void");
});

test("結果点: 当たり20点+回収率の段(100%で+5・200%で+8・500%で+10)、外れは0点", () => {
  const at = (y) => plain(Y.scoreOne(rec("単勝", [1]), { ...RACE, pay: { "単勝": [{ c: "1", y }] } })).pt;
  assert.strictEqual(at(90), 20);
  assert.strictEqual(at(100), 25);
  assert.strictEqual(at(199), 25);
  assert.strictEqual(at(200), 28);
  assert.strictEqual(at(500), 30);
  assert.strictEqual(Y.MAX_RESULT_PT, 30);
});

test("groupResult: 束で1つでも当たれば的中、回収率は束全体の払戻÷投入", () => {
  const recs = [rec("3連単", [1, 3, 2], 100), rec("3連単", [1, 2, 3], 100), rec("単勝", [6], 300)]
    .map((r) => ({ ...r, score: plain(Y.scoreOne(r, RACE)) }));
  const g = plain(Y.groupResult(recs));
  assert.deepStrictEqual(g, { status: "hit", bet: 500, yen: 670, profit: 170, roi: 134, pt: 25, max: 30, voided: 0, pending: 0 });
  // 未採点が混じっていても、採点済みがあれば採点済みだけで出す(pending を数える)
  assert.strictEqual(plain(Y.groupResult([...recs, rec("単勝", [2])])).pending, 1);
  // 全部未採点は pending
  assert.deepStrictEqual(plain(Y.groupResult([rec("単勝", [2])])), { status: "pending" });
});

test("pickAxis: 1着に置いた回数で軸、登場回数で押さえ2艇。同数は艇番の小さいほう", () => {
  // 順番のある券種: 1着に3が2回・1が1回 → 軸3。押さえは登場回数(1:3回,5:2回,2:1回)
  assert.deepStrictEqual(plain(Y.pickAxis([rec("3連単", [3, 1, 5]), rec("3連単", [3, 5, 1]), rec("3連単", [1, 3, 2])])),
    { axis: 3, backs: [1, 5], byFirst: true });
  // 1着の回数が同数なら艇番の小さいほう
  assert.strictEqual(plain(Y.pickAxis([rec("2連単", [4, 2]), rec("2連単", [2, 4])])).axis, 2);
  // 順不同だけの群は登場回数で軸
  assert.deepStrictEqual(plain(Y.pickAxis([rec("2連複", [5, 6]), rec("2連複", [4, 6])])),
    { axis: 6, backs: [4, 5], byFirst: false });
  // 単勝は順番のある券種として扱う
  assert.strictEqual(plain(Y.pickAxis([rec("単勝", [4]), rec("単勝", [4]), rec("2連複", [1, 2])])).axis, 4);
  // 【今の作り】順番のある券種が1つでも混じると、順不同の券種も「最初に書いた艇」を1着の位置として数える。
  // (単勝4を1点・2連複1-2と1-3 → 1着の位置は 1が2回・4が1回 で軸1)。変えるなら配点の見直しと一緒に
  assert.strictEqual(plain(Y.pickAxis([rec("単勝", [4]), rec("2連複", [1, 2]), rec("2連複", [1, 3])])).axis, 1);
});

// 手で配点表を引ける艇。n=1: 全国勝率6.72(6.5〜7.0→19点)・平均ST0.137(0.14未満→18点)・
// 直近3走[2,3,2]の平均2.3着(2.0〜3.0→10点)。波1cm×1号艇→10点。合計57点
const boat = (n, nw, s, r) => ({ n, t: String(4000 + n), name: "選手" + n, k: "A1", nw, ks: { which: "今節", c: [], s, r } });
const SNAP = {
  key: "2026-09-11:大村:11", date: "2026-09-11", venue: "大村", no: 11, dl: "20:45",
  boats: [
    boat(1, 6.72, [0.12, 0.15, 0.14], [1, 2, 3, 2]),
    boat(2, 4.10, [0.20, 0.21], [5, 6, 4]),
    boat(3, 7.25, [0.19, 0.20], [4, 4, 5]),
    boat(4, 5.60, [0.17], [3]),
    boat(5, null, [], []),
    boat(6, 5.10, [0.15, 0.13, 0.15], [1, 2]),
  ],
};

test("yomiScore: 軸の艇の数字を配点表の帯に当てて、行と合計を出す", () => {
  const y = plain(Y.yomiScore([rec("3連単", [1, 2, 3]), rec("3連単", [1, 3, 2])], SNAP, 1));
  assert.strictEqual(y.axis, 1);
  assert.deepStrictEqual(y.backs, [2, 3]);
  assert.deepStrictEqual(y.rows.map((r) => [r.cat, r.pt]), [["A", 19], ["B", 18], ["C", 10], ["D", 10]]);
  assert.strictEqual(y.pt, 57);
  assert.strictEqual(y.max, 70);
  assert.strictEqual(y.version, Y.YOMI_VERSION);
  assert.strictEqual(y.rows[0].line, "+19: 全国勝率 6.72（6.5〜7.0は1着率+7.7pt / 39日・35,404走）");
  assert.strictEqual(y.rows[1].line, "+18: 平均ST 0.137（0.14未満は1着率+8.5pt / 10年・334万走）");
  assert.strictEqual(y.rows[2].line, "+10: 直近3走の平均 2.3着（平均2.0〜3.0着は1着率+2.7pt / 10年・334万走）");
  assert.strictEqual(y.rows[3].line, "+10: 波高 1cm・1号艇（1号艇×0-1cmは1着率+2.6pt / 10年・334万走）");
});

test("yomiScore: 材料が無い項目は0点で「判定できませんでした」、2走しか無ければそう添える", () => {
  // 5号艇は全国勝率なし・STなし・着順なし、波高なし
  const y5 = plain(Y.yomiScore([rec("単勝", [5])], SNAP, null));
  assert.strictEqual(y5.pt, 0);
  assert.deepStrictEqual(y5.rows.map((r) => r.line), [
    "+0: 全国勝率 不明（この項目は判定できませんでした）",
    "+0: 平均ST 不明（この項目は判定できませんでした）",
    "+0: 直近の成績が不足（今節が始まったばかりで、判定に使える走行がありません）",
    "+0: 波高 不明（この項目は判定できませんでした）",
  ]);
  // 4号艇は1走だけ → 調子は判定しない。6号艇は2走 → 2走ぶんで判定し、そう添える
  assert.strictEqual(plain(Y.yomiScore([rec("単勝", [4])], SNAP, 3)).rows[2].fact, "直近の成績が不足");
  const y6 = plain(Y.yomiScore([rec("単勝", [6])], SNAP, 3));
  assert.strictEqual(y6.rows[2].line, "+16: 直近2走の平均 1.5着（平均2.0着以内は1着率+7.3pt / 10年・334万走）（今節2走ぶんで判定）");
  // 波4cm×6号艇 = 7点
  assert.strictEqual(plain(Y.yomiScore([rec("単勝", [6])], SNAP, 4)).rows[3].pt, 7);
  // スナップショットが無い・軸の艇がいない → null
  assert.strictEqual(Y.yomiScore([rec("単勝", [1])], null, 1), null);
});

// 答案を作る(採点→buildPaper)。今日の一問と同じ使い方
function grade(records, race, snap) {
  const scored = records.map((r) => ({ ...r, score: plain(Y.scoreOne(r, race)) }));
  return plain(Y.buildPaper(scored, snap));
}
const kinds = (p) => p.comment.map((l) => l.kind);
const text = (p, kind) => p.comment.filter((l) => l.kind === kind).map((l) => l.text);

test("comment: 総評は読み点の帯×結果、軸の評価はA+Bの点で書き分ける", () => {
  // 読み57点(high)・的中 → 噛み合った
  const high = grade([rec("3連単", [1, 3, 2])], RACE, SNAP);
  assert.strictEqual(high.yomi.pt, 57);
  assert.deepStrictEqual(text(high, "head"), ["読みと結果が噛み合った答案です。"]);
  assert.deepStrictEqual(text(high, "axis"), ["軸に1号艇を選んだのは良い読みです。全国勝率 6.72、平均ST 0.137と、軸に置く条件が実測で揃っていました。"]);
  // 押さえ(3号艇)は平均ST0.195・直近4.3着で2連対の帯に入らない → 押さえの行なし
  assert.deepStrictEqual(text(high, "back"), []);
  // 読み57点・外れ → 続けていい読み方
  const missHigh = grade([rec("3連単", [1, 2, 3])], RACE, SNAP);
  assert.deepStrictEqual(text(missHigh, "head"), ["読みは立っていました。結果がついてこなかっただけで、続けていい読み方です。"]);

  // 2号艇軸(全国勝率4.10・ST0.205) → 読み0点(low)。的中にするため払戻を2号艇の単勝にする
  const race2 = { ...RACE, pay: { "単勝": [{ c: "2", y: 900 }] } };
  const low = grade([rec("単勝", [2])], race2, SNAP);
  assert.strictEqual(low.yomi.pt, 0);
  assert.deepStrictEqual(text(low, "head"), ["的中しましたが、再現の根拠は薄い答案です。数字より運が働いた日かもしれません。"]);
  assert.deepStrictEqual(text(low, "axis"), ["軸の2号艇は、1着率を押し上げる実測の材料が見当たりませんでした（全国勝率4.10・平均ST0.205）。"]);

  // 最後の行は必ず気象の注、行数は7行以内
  for (const p of [high, missHigh, low]) {
    assert.strictEqual(p.comment[p.comment.length - 1].text, "※採点はレース時点の気象で行っています。");
    assert.ok(p.comment.length <= 7);
  }
});

test("comment: 見送った材料と締めの一行(分岐表)", () => {
  // 1号艇軸・相手2号艇だけ → 買い目に入っていない3号艇(全国勝率7.25=26点)と6号艇(直近1.5着=16点)が「見送った材料」
  const p = grade([rec("2連単", [1, 2])], { ...RACE, pay: { "2連単": [{ c: "1-3", y: 400 }] } }, SNAP);
  assert.deepStrictEqual(text(p, "missed"), [
    "一方で、3号艇（全国勝率7.25・1着率+12.6pt）にも同格の材料がありましたが、今回の買い目には入っていません。",
    "一方で、6号艇（直近2走の平均1.5着・1着率+7.3pt）にも同格の材料がありましたが、今回の買い目には入っていません。",
  ]);
  // 締め: 軸(1)は来て、押さえ(2)は3着内(1,3,2)に入っている → 4ではない。見送った3号艇が2着に絡んだ → 5
  assert.deepStrictEqual(text(p, "hint"), ["買い目に入れなかった3号艇が実際に絡みました。同格の材料は、拾うかどうかを毎回決めるところです。"]);

  // 1: 満点(読み70+結果30)。読み点を70にするため波1cm×1号艇・A7.0以上・ST0.14未満・直近2.0着以内の艇を置く
  const top = { ...SNAP, boats: SNAP.boats.map((b) => (b.n === 1 ? boat(1, 7.5, [0.1, 0.1], [1, 1, 1]) : b)) };
  const full = grade([rec("3連単", [1, 3, 2], 100)], RACE, top);
  assert.strictEqual(full.yomi.pt + full.result.pt, 100);
  assert.deepStrictEqual(text(full, "hint"), ["読みも結果も揃いました。この答案は、次に迷ったときの基準になります。"]);

  // 2: 軸は着外、A+B≥30。1号艇軸で、実際は 3-2-5 の決着
  const out = { ...RACE, order: [4, 2, 1, 5, 3, 6], kimarite: "まくり", pay: { "3連単": [{ c: "3-2-5", y: 5000 }] } };
  const p2 = grade([rec("3連単", [1, 2, 3])], out, SNAP);
  assert.deepStrictEqual(text(p2, "hint"), ["軸の材料は揃っていました。それでも着外になる日があることを、この一本が示しています。"]);
  // 3: 軸は着外、A+B<15。2号艇軸(0点)で、実際は 1-3-4 の決着
  const out3 = { ...RACE, order: [1, 5, 2, 3, 4, 6], pay: { "3連単": [{ c: "1-3-4", y: 900 }] } };
  const p3 = grade([rec("3連単", [2, 5, 6])], out3, SNAP);
  assert.deepStrictEqual(text(p3, "hint"), ["軸に実測の材料が薄いまま買うと、外れた理由が後から辿れません。まず軸の数字から読むところです。"]);
  // 6: 1号艇軸で逃げ以外。軸は2着に来ていて押さえも絡み、見送った艇は来ていない
  const nige = { ...RACE, order: [2, 1, 4, 3, 5, 6], kimarite: "差し", pay: { "3連単": [{ c: "2-1-4", y: 1500 }] } };
  const p6 = grade([rec("3連単", [1, 2, 4]), rec("3連単", [1, 4, 2])], nige, { ...SNAP, boats: SNAP.boats.map((b) => (b.n === 3 || b.n === 6 ? boat(b.n, 3.0, [0.25], [6, 6, 6]) : b)) });
  assert.deepStrictEqual(text(p6, "hint"), ["この日は逃げで決まりませんでした。1号艇を軸にするときは、その水面で逃げ以外がどれくらい出ているかを先に見ておくと守りが利きます。"]);
  // 7: 進入が枠どおりでない(同じ条件で逃げ決着・進入だけ変える)
  const p7 = grade([rec("3連単", [1, 2, 4]), rec("3連単", [1, 4, 2])], { ...nige, kimarite: "逃げ", order: [1, 2, 4, 3, 5, 6], in: [1, 2, 4, 3, 5, 6], pay: { "3連単": [{ c: "1-2-4", y: 800 }] } },
    { ...SNAP, boats: SNAP.boats.map((b) => (b.n === 3 || b.n === 6 ? boat(b.n, 3.0, [0.25], [6, 6, 6]) : b)) });
  assert.deepStrictEqual(text(p7, "hint"), ["進入が枠どおりではありませんでした。前づけのある節は、枠ではなくコースで読み直すところです。"]);
});

test("comment: 波高4cm以上の日は条件の一行を足す", () => {
  const rough = { ...RACE, wx: { ...RACE.wx, "波高": 5 } };
  const p = grade([rec("3連単", [1, 3, 2])], rough, SNAP);
  assert.deepStrictEqual(text(p, "cond"), ["波高5cm。この波高帯の1コース逃げ率は93.9%（穏やかな日は96.0%）。荒れるほど逃げ切りが減り、抜きが増えます。"]);
  assert.ok(kinds(p).indexOf("cond") < kinds(p).indexOf("note"));
});

// ---------------------------------------------------------------- 2. 保存領域・日付を使わない

test("buildPaper: 結果が出るまでは読み点も講評も出さない", () => {
  const p = plain(Y.buildPaper([rec("3連単", [1, 3, 2])], SNAP));
  assert.strictEqual(p.settled, false);
  assert.strictEqual(p.yomi, null);
  assert.deepStrictEqual(p.comment, []);
  assert.strictEqual(p.ai, null);
});

test("buildPaper: 日付・締切・レースキーを消しても答案は1文字も変わらない", () => {
  for (const { snapshot, race } of RACES) {
    const records = [rec("3連単", [1, 2, 3]), rec("3連単", [1, 3, 2])].map((r) => ({ ...r, key: snapshot.key }));
    const withDate = grade(records, race, snapshot);
    const { key, date, dl, ...noDate } = snapshot;
    const hidden = grade(records.map(({ key: k, at, ...r }) => ({ ...r, at: "x" })), race, noDate);
    withDate.snapshot = hidden.snapshot = null;
    withDate.records = hidden.records = null;
    assert.deepStrictEqual(hidden, withDate, snapshot.key);
  }
});

test("buildPaper: 端末に保存した記録から作る paper() と同じ答案を返す", () => {
  const { snapshot, race } = RACES[0];
  const records = [rec("3連単", [1, 3, 2], 100, { key: snapshot.key, id: "a" }), rec("2連複", [1, 3], 200, { key: snapshot.key, id: "b" })]
    .map((r) => ({ ...r, score: plain(Y.scoreOne(r, race)) }));
  const store = {
    teiyomi_yomi_records: JSON.stringify(records),
    teiyomi_yomi_snapshots: JSON.stringify({ [snapshot.key]: snapshot }),
  };
  const fromStorage = plain(loadYomi(store).paper(snapshot.key, ""));
  const direct = plain(Y.buildPaper(records, snapshot));
  assert.deepStrictEqual(fromStorage, { key: snapshot.key, tag: "", ...direct });
});

// ---------------------------------------------------------------- 3. 実レースの答案を固定

// 1レースに6通りの答案。軸の選び方(1号艇・実際の1着・外の艇)と券種を散らす
function bundles(race) {
  const [c1, c2, c3] = race.pay["3連単"][0].c.split("-").map(Number);
  return {
    "1号艇軸・3連単2点": [["3連単", [1, 2, 3], 100], ["3連単", [1, 3, 2], 100]],
    "実際の決着・3連単": [["3連単", [c1, c2, c3], 100]],
    "外の2艇・2連複": [["2連複", [5, 6], 200]],
    "6号艇・単勝": [["単勝", [6], 500]],
    "1号艇・複勝と拡連複": [["複勝", [1], 100], ["拡連複", [1, 2], 100]],
    "1着の艇を軸・2連単流し": [2, 3, 4, 5, 6].filter((n) => n !== c1).slice(0, 3).map((n) => ["2連単", [c1, n], 100]),
  };
}

function goldenNow() {
  const out = {};
  for (const { key, snapshot, race } of RACES) {
    for (const [name, list] of Object.entries(bundles(race))) {
      const records = list.map(([ken, lanes, amount], i) => rec(ken, lanes, amount, { key, id: name + i }));
      const p = grade(records, race, snapshot);
      delete p.snapshot;   // 固定データ側にある
      out[key + " / " + name] = p;
    }
  }
  return out;
}

test("実レース7本×6通りの答案が固定した出力と一致する", () => {
  const now = goldenNow();
  if (process.env.UPDATE_GOLDEN === "1") {
    writeFileSync(GOLDEN_PATH, JSON.stringify(now, null, 1) + "\n");
  }
  const expected = JSON.parse(readFileSync(GOLDEN_PATH, "utf8"));
  assert.deepStrictEqual(Object.keys(now), Object.keys(expected));
  for (const k of Object.keys(expected)) assert.deepStrictEqual(now[k], expected[k], k);
});

// ---------------------------------------------------------------- 4. window の無い環境

test("window が無くても globalThis.TeiyomiYomi として読める", () => {
  const ctx = { Date: FixedDate };
  vm.runInNewContext(SRC, ctx);
  const G = vm.runInNewContext("globalThis.TeiyomiYomi", ctx);
  assert.ok(G && typeof G.buildPaper === "function" && typeof G.yomiScore === "function");
  const { snapshot, race } = RACES[0];
  const r = rec("3連単", [1, 2, 3], 100, { key: snapshot.key });
  const p = plain(G.buildPaper([{ ...r, score: plain(G.scoreOne(r, race)) }], snapshot));
  assert.strictEqual(p.settled, true);
  assert.strictEqual(p.yomi.max, 70);
});
