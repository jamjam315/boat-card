// 今日の一問の実績(quiz-badges.js)のテスト。
//   node --test tests/quiz-badges.test.mjs
// 守りたいのは: 連続は「出題日の当日に解いた日」だけで数える・問数はあとから解いた日も数える・
// 更新型は上回ったときだけ「更新」・通算の記録は端末の中の形が崩れていても落ちない。
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const win = {};
vm.runInNewContext(readFileSync(join(ROOT, "quiz-badges.js"), "utf8"), { window: win });
const B = win.TeiyomiQuizBadges;
const plain = (x) => JSON.parse(JSON.stringify(x));

function memStorage(init = {}) {
  const store = { ...init };
  return { store, getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
}
// 出題日 d を、その日の JST 12:00 に解いた(onDay)まとめ
function day(d, over = {}) {
  return { at: new Date(Date.parse(d + "T03:00:00Z")).toISOString(), onDay: true, yomi: 20, yomiMax: 40, hit: false,
    hit3t: false, fin: 900, kens: ["単勝"], v: "v1.1 2026-09", ...over };
}
function stats(days) { return { v: 1, days: Object.assign(Object.create(null), days) }; }
const byId = (ev) => Object.fromEntries(plain(ev).list.map((b) => [b.id, b]));

test("連続日数: 当日に解いた日だけで数える。あとから解いた日は数えない・1日空くと切れる", () => {
  const ev = B.evaluate(stats({
    "2026-09-17": day("2026-09-17"),
    "2026-09-18": day("2026-09-18"),
    // 9/19 は 9/21 にあとから解いた(onDay:false)
    "2026-09-19": day("2026-09-19", { at: "2026-09-21T03:00:00.000Z", onDay: false }),
    "2026-09-20": day("2026-09-20"),
    "2026-09-21": day("2026-09-21"),
  }), "2026-09-21");
  assert.strictEqual(ev.solved, 5, "問数はあとから解いた日も数える");
  assert.strictEqual(ev.streakBest, 2);
  assert.strictEqual(ev.streakNow, 2);
  assert.strictEqual(byId(ev).streak3.earned, null);
});

test("いまの連続: 今日の分をまだ解いていなくても今日のうちは切れない。2日空けば0", () => {
  const s = stats({ "2026-09-17": day("2026-09-17"), "2026-09-18": day("2026-09-18"), "2026-09-19": day("2026-09-19") });
  assert.strictEqual(B.evaluate(s, "2026-09-19").streakNow, 3);
  assert.strictEqual(B.evaluate(s, "2026-09-20").streakNow, 3, "今日(9/20)の分がまだでも切れない");
  assert.strictEqual(B.evaluate(s, "2026-09-21").streakNow, 0);
  const ev = byId(B.evaluate(s, "2026-09-19"));
  assert.strictEqual(ev.streak3.earned, "2026-09-19", "3日目に付く");
  assert.strictEqual(ev.first.earned, "2026-09-17");
});

test("問数・読み点・いちばん材料のある艇・的中・7券種の実績", () => {
  const days = {};
  for (let i = 0; i < 10; i++) {
    const d = `2026-10-${String(i + 1).padStart(2, "0")}`;
    days[d] = day(d, { yomi: [10, 41, 20, 50, 5, 30, 30, 0, 12, 12][i], yomiMax: [10, 45, 30, 50, 0, 30, 40, 0, 20, 20][i],
      hit: i === 2, hit3t: i === 6, kens: [["単勝", "複勝"], ["2連単"], ["2連複", "拡連複"], ["3連単"], [], [], ["3連複"], [], [], []][i] });
  }
  const ev = byId(B.evaluate(stats(days), "2026-10-10"));
  assert.strictEqual(ev.count10.earned, "2026-10-10");
  assert.strictEqual(ev.count30.earned, null);
  assert.strictEqual(ev.yomi40.earned, "2026-10-02");
  assert.strictEqual(ev.yomi50.earned, "2026-10-04");
  // 最高点の艇を軸に: 10/1(10=10)・10/4(50=50)・10/6(30=30)。10/5 と 10/8 は最高が0なので数えない
  assert.strictEqual(ev.bestAxis.earned, "2026-10-01");
  assert.strictEqual(ev.bestAxis.count, 3);
  assert.strictEqual(ev.hit.earned, "2026-10-03");
  assert.strictEqual(ev.hit3t.earned, "2026-10-07");
  assert.strictEqual(ev.kens7.earned, "2026-10-07", "7つそろった日");
  assert.strictEqual(ev.yomiBest.value, 50);
  assert.strictEqual(ev.yomiBest.earned, "2026-10-04");
});

test("新しい実績: 初めての日は1回きりのものだけ。更新型は前の値を上回ったときだけ「更新」", () => {
  const ls = memStorage();
  let r = B.addDay(ls, "2026-09-17", day("2026-09-17", { yomi: 30, fin: 1200 }), "2026-09-17");
  assert.deepStrictEqual(plain(r.fresh), ["はじめての一問"]);
  r = B.addDay(ls, "2026-09-18", day("2026-09-18", { yomi: 45, fin: 800 }), "2026-09-18");
  assert.deepStrictEqual(plain(r.fresh), ["読み点40", "読み点の自己ベストを更新（45点）"]);
  r = B.addDay(ls, "2026-09-19", day("2026-09-19", { yomi: 10, fin: 1300, hit: true, yomiMax: 10 }), "2026-09-19");
  assert.deepStrictEqual(plain(r.fresh), ["3日つづけて", "いちばん材料のある艇を軸に", "はじめての的中", "持ち点の自己ベストを更新（1,300円）"]);
  // 同じ出題日は二度足さない
  r = B.addDay(ls, "2026-09-19", day("2026-09-19", { yomi: 70 }), "2026-09-19");
  assert.strictEqual(r.added, false);
  assert.strictEqual(B.evaluate(B.read(ls), "2026-09-19").solved, 3);
});

test("通算の記録: 形の崩れた日・時刻の無い日は無かったことにする。知らない券種は落とす", () => {
  const ls = memStorage({ [B.STATS_KEY]: JSON.stringify({ v: 1, days: {
    "2026-09-17": day("2026-09-17", { kens: ["単勝", "<img>"] }),
    "bad": day("2026-09-18"),
    "2026-09-19": { yomi: 50 },
    "2026-09-20": day("2026-09-20", { yomi: "50" }),
  } }) });
  const s = B.read(ls);
  assert.deepStrictEqual(Object.keys(s.days).sort(), ["2026-09-17", "2026-09-20"]);
  assert.deepStrictEqual(plain(s.days["2026-09-17"].kens), ["単勝"]);
  assert.strictEqual(s.days["2026-09-20"].yomi, null, "数でない読み点は無し");
  assert.strictEqual(B.evaluate(memStorage().getItem("x") ? null : { v: 1, days: Object.create(null) }, "2026-09-20").solved, 0);
  // 壊れた JSON でも落ちない
  assert.strictEqual(Object.keys(B.read(memStorage({ [B.STATS_KEY]: "{" })).days).length, 0);
});

test("上部の1行", () => {
  assert.strictEqual(B.statusText(B.evaluate(stats({}), "2026-09-17")), "");
  const s = stats({ "2026-09-17": day("2026-09-17"), "2026-09-18": day("2026-09-18") });
  assert.strictEqual(B.statusText(B.evaluate(s, "2026-09-18")), "解いた問 2・いまの連続 2日（最長 2日）");
});

test("実績は11個(段つきを含めて15件)で、名前は事実の言い方", () => {
  assert.strictEqual(B.BADGES.length, 15);
  const names = B.BADGES.map((b) => b.name).join(" ");
  assert.ok(!/神|天才|最強|連勝|爆|達人/.test(names), names);
});
