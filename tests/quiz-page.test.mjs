// 今日の一問のページ(quiz.js)のテスト。AI-14 v1④ で新設。
//   node --test tests/*.test.mjs
//
// 守りたいのは4つ。
//   1. 出題ファイルの文字列(会場・種別・選手名・級・支部・気象・今節/直近の呼び名・払戻の組)は、
//      すべてエスケープして描く。タグや属性の区切りがそのまま出ない
//   2. 端末の保存: 出題日ごとに分かれる / スタート(reveal)後は足せない・消せない / AI講評を出題日で残す /
//      60日より古い出題日は消す / 実レースの読み採点の記録とは混ざらない
//   3. 採点: 読み採点のエンジンで答案ができ、答案のヘッダーにレースの日付が出ない
//   4. 開く出題日: ?d= は今日以前だけ。先の日付や形の崩れたものは今日にする
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function memStorage(init = {}) {
  const store = { ...init };
  return {
    store,
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
  };
}

function load() {
  const ls = memStorage();
  const sandbox = { localStorage: ls, document: { getElementById: () => null } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const f of ["yomi.js", "yomi-race.js", "yomi-paper.js", "quiz.js"]) {
    vm.runInContext(readFileSync(join(ROOT, f), "utf8"), sandbox);
  }
  return sandbox;
}
const G = load();
const Q = G.TeiyomiQuiz, Y = G.TeiyomiYomi;
const plain = (x) => JSON.parse(JSON.stringify(x));

// 実レースの固定データ(tests/fixtures)から、出題ファイルと同じ形を作る
const R = JSON.parse(readFileSync(join(ROOT, "tests/fixtures/yomi-engine-races.json"), "utf8")).races[0];
const [venue, no] = [R.key.split(":")[1], Number(R.key.split(":")[2])];
const QUIZ = {
  date: "2026-09-17",
  question: {
    venue, no, kind: "予選", dist: 1800, fixed: false, wx: R.race.wx,
    boats: R.snapshot.boats.map((b) => ({ ...b, ex: 6.8 })),
  },
  answer: {
    date: R.key.slice(0, 10), key: R.key, order: R.race.order, in: R.race.in, kimarite: R.race.kimarite,
    pay: R.race.pay, st: [0.1, 0.12, 0.13, 0.14, 0.15, 0.16], rt: [110.1, 111, 112, null, null, null],
  },
};

test("出題の文字列はすべてエスケープして描く", () => {
  const evil = "<img src=x onerror=alert(1)>\"'&";
  const q = JSON.parse(JSON.stringify(QUIZ));
  q.question.venue = evil;
  q.question.kind = evil;
  q.question.wx = { "天候": evil, "風向": evil, "風速": 2, "波高": 3 };
  q.question.boats.forEach((b) => { b.name = evil; b.k = evil; b.br = evil; b.ks = { ...b.ks, which: evil }; });
  q.answer.kimarite = evil;
  q.answer.date = evil;
  q.answer.pay["3連単"][0].c = evil;
  for (const html of [Q.questionHtml(q), Q.resultHtml(q)]) {
    assert.ok(!html.includes("<img"), "タグがそのまま出ない");
    assert.ok(!/="[^"]*"[^ >]*'/.test(html.replace(/&#39;/g, "")), "属性の区切りが崩れない");
    assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;"), "文字として出る");
  }
  // 数値でないものは数値として出さない
  const q2 = JSON.parse(JSON.stringify(QUIZ));
  q2.question.boats[0].nw = "<b>7.00</b>";
  q2.question.boats[0].ex = "<i>";
  const h2 = Q.questionHtml(q2);
  assert.ok(!h2.includes("<b>7.00") && !h2.includes("<i>"));
});

test("問題には気象と展示タイムの注記が付き、レースの日付は出ない。結果で初めて日付が出る", () => {
  const html = Q.questionHtml(QUIZ);
  assert.ok(html.includes("気象と展示タイムは、競走成績に記録された、レース時点の値です。"));
  assert.ok(!html.includes(QUIZ.answer.date));
  assert.ok(Q.resultHtml(QUIZ).includes(QUIZ.answer.date));
});

test("端末の保存: 出題日ごと・スタート後は足せない消せない・AI講評を出題日で残す", () => {
  const ls = memStorage({ teiyomi_yomi_records: "[]" });
  const s = Q.dayStore(ls, "2026-09-17", Y);
  const other = Q.dayStore(ls, "2026-09-18", Y);
  assert.deepStrictEqual(plain(s.add({ ken: "3連単", lanes: [1, 3, 2], tag: "1号艇軸", amount: 200 })), { ok: true });
  assert.strictEqual(plain(s.add({ ken: "3連単", lanes: [1, 1, 2], amount: 100 })).reason, "bad_bet");
  assert.strictEqual(plain(s.add({ ken: "単勝", lanes: [1], amount: 0 })).reason, "bad_amount");
  assert.strictEqual(s.list().length, 1);
  assert.strictEqual(other.list().length, 0, "出題日が違えば別");
  assert.deepStrictEqual(plain(s.countByTag()), { "1号艇軸": 1 });
  assert.ok(plain(other.tags()).includes("1号艇軸"), "タグの候補は出題日をまたいで出す");
  assert.strictEqual(ls.store.teiyomi_yomi_records, "[]", "読み採点の記録には書かない");

  const id = s.list()[0].id;
  s.add({ ken: "単勝", lanes: [2], amount: 100 });
  assert.strictEqual(s.remove(s.list()[1].id), true);
  assert.strictEqual(s.isClosed(), false);
  s.reveal();
  assert.strictEqual(s.isClosed(), true);
  assert.strictEqual(plain(s.add({ ken: "単勝", lanes: [3], amount: 100 })).reason, "closed");
  assert.strictEqual(s.remove(id), false, "スタート後は消せない");
  assert.strictEqual(s.list().length, 1);

  assert.strictEqual(s.ai(), null);
  s.setAi({ text: "講評", model: "m" });
  assert.strictEqual(plain(s.ai()).text, "講評");
  s.setAiReported();
  assert.strictEqual(plain(s.ai()).reported, true);
  assert.strictEqual(other.ai(), null);
  assert.strictEqual(plain(Q.dayStore(ls, "2026-09-17", Y).ai()).text, "講評", "開き直しても残る");
});

test("端末の保存: 1問30点まで、60日より古い出題日は消す、壊れた保存は無かったことにする", () => {
  const ls = memStorage();
  const s = Q.dayStore(ls, "2026-09-17", Y);
  for (let i = 0; i < Q.MAX_PER_QUIZ; i++) assert.ok(s.add({ ken: "単勝", lanes: [1], amount: 100 }).ok);
  assert.strictEqual(plain(s.add({ ken: "単勝", lanes: [1], amount: 100 })).reason, "too_many_here");

  const ls2 = memStorage();
  for (let i = 0; i < Q.KEEP_DAYS + 5; i++) {
    const d = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
    Q.dayStore(ls2, d, Y).add({ ken: "単勝", lanes: [1], amount: 100 });
  }
  const days = Object.keys(JSON.parse(ls2.store[Q.STORE_KEY]).days).sort();
  assert.strictEqual(days.length, Q.KEEP_DAYS);
  assert.strictEqual(days[0], new Date(Date.UTC(2026, 0, 6)).toISOString().slice(0, 10));

  const broken = memStorage({ [Q.STORE_KEY]: "{not json" });
  assert.strictEqual(Q.dayStore(broken, "2026-09-17", Y).list().length, 0);
});

test("採点: 読み採点のエンジンで答案ができ、答案のヘッダーにレースの日付が出ない", () => {
  const top3 = [1, 2, 3].map((c) => QUIZ.answer.order.indexOf(c) + 1);
  const records = [{ id: "a", at: "x", ken: "3連単", lanes: top3, tag: "", amount: 100 }];
  const p = Q.paperOf(QUIZ, records, { text: "保存した講評", model: "m", at: "2026-09-17T00:00:00.000Z" }, Y);
  assert.strictEqual(p.settled, true);
  assert.strictEqual(p.result.status, "hit");
  assert.strictEqual(p.key, QUIZ.answer.key);
  assert.strictEqual(p.ai.text, "保存した講評");
  assert.strictEqual(p.yomi.rows.length, 4);

  const paperEl = { innerHTML: "", querySelector: () => null };
  const nextEl = { innerHTML: "" };
  G.TeiyomiYomiPaper.render({ paperEl, nextEl, p, when: Q.headerWhen(QUIZ, "2026-09-17"), venue });
  assert.ok(paperEl.innerHTML.includes(`<span class="when nums">今日の一問　${venue} ${no}R</span>`));
  assert.ok(!paperEl.innerHTML.includes(QUIZ.answer.date), "答案にレースの日付が出ない");
  assert.ok(nextEl.innerHTML.includes(encodeURIComponent(`"venue":"${venue}"`)), "つづきの会場は出題の会場");
  // 過去の出題日を開いたときのヘッダー
  assert.strictEqual(Q.headerWhen(QUIZ, "2026-09-20"), `9月17日の一問　${venue} ${no}R`);
});

test("開く出題日: ?d= は今日以前だけ", () => {
  assert.strictEqual(Q.pickDate("", "2026-09-17"), "2026-09-17");
  assert.strictEqual(Q.pickDate("?d=2026-09-10", "2026-09-17"), "2026-09-10");
  assert.strictEqual(Q.pickDate("?d=2026-09-18", "2026-09-17"), "2026-09-17", "先の出題は開かない");
  assert.strictEqual(Q.pickDate("?d=../../x", "2026-09-17"), "2026-09-17");
  assert.strictEqual(Q.todayJst(Date.parse("2026-09-17T15:30:00Z")), "2026-09-18", "JSTで日付が変わる");
  assert.ok(Q.isQuiz(QUIZ));
  assert.ok(!Q.isQuiz({ ...QUIZ, question: { ...QUIZ.question, boats: QUIZ.question.boats.slice(0, 5) } }));
});

test("出所タグが __proto__ や constructor でも、数える入れ物を壊さない(2026-09-18 点検 低2)", () => {
  const S = load();
  const d = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);   // JSTの今日(集計の窓に入れる)
  const key = `${d}:${venue}:${no}`;
  const TAGS = ["__proto__", "constructor", "toString"];
  S.localStorage.setItem("teiyomi_yomi_records", JSON.stringify(TAGS.map((tag, i) => ({
    key, ken: "単勝", lanes: [1], amount: 100, tag, at: `${d}T00:00:0${i}Z`, id: `t${i}`,
  }))));
  const Y2 = S.TeiyomiYomi;
  const c = Y2.countByTag(key);
  assert.deepStrictEqual(Object.keys(c).sort(), [...TAGS].sort());
  assert.ok(TAGS.every((t) => c[t] === 1), "どのタグも1件");
  assert.deepStrictEqual([...Y2.tags()].sort(), [...TAGS].sort());
  const s = Y2.summary(30);
  assert.ok(TAGS.every((t) => Object.keys(s.byTag).includes(t) && s.byTag[t].n === 1), "集計もタグごとに1件");
  assert.strictEqual(vm.runInContext("({}).n", S), undefined, "Object.prototype に数が足されていない");

  const ls = memStorage({ teiyomi_yomi_records: "[]" });
  const q = S.TeiyomiQuiz.dayStore(ls, "2026-09-17", Y2);
  assert.ok(q.add({ ken: "単勝", lanes: [1], amount: 100, tag: "__proto__" }).ok);
  assert.strictEqual(q.countByTag()["__proto__"], 1);
  assert.ok(q.tags().includes("__proto__"));
});

// ---------------------------------------------------------------- 持ち点(2026-09-18 便D)

test("持ち点: 1,000円・100円単位・10点まで。超える記録は受け付けず残りを返す", () => {
  const ls = memStorage({ teiyomi_yomi_records: "[]" });
  const s = Q.dayStore(ls, "2026-09-17", Y);
  assert.strictEqual(Q.BUDGET, 1000);
  assert.strictEqual(Q.MAX_PER_QUIZ, 10);
  assert.deepStrictEqual(plain(s.budget()), { total: 1000, unit: 100, max: 10, spent: 0, left: 1000, points: 0 });
  assert.ok(s.add({ ken: "3連単", lanes: [1, 2, 3], amount: 300 }).ok);
  assert.deepStrictEqual(plain(s.add({ ken: "単勝", lanes: [1], amount: 800 })), { ok: false, reason: "over_budget", left: 700 });
  assert.strictEqual(plain(s.add({ ken: "単勝", lanes: [1], amount: 150 })).reason, "bad_unit");
  assert.ok(s.add({ ken: "単勝", lanes: [1], amount: 700 }).ok, "ちょうど1,000円までは受け付ける");
  assert.deepStrictEqual(plain(s.add({ ken: "単勝", lanes: [2], amount: 100 })), { ok: false, reason: "over_budget", left: 0 });
  assert.deepStrictEqual(plain(s.budget()), { total: 1000, unit: 100, max: 10, spent: 1000, left: 0, points: 2 });
  // 消せば戻る
  assert.ok(s.remove(s.list()[1].id));
  assert.strictEqual(s.budget().left, 700);
});

// 記録欄の部品を、DOM の代わりの小さな入れ物で描く(持ち点の行と、持ち点の無いレースページの欄)
function mountHtml(store, opts) {
  const S = load();
  const box = { innerHTML: "", querySelectorAll: () => [] };
  S.document = { getElementById: () => ({}) };
  S.TeiyomiYomiRecord.mount(box, store, opts);
  return box.innerHTML;
}

test("記録欄: budget のときだけ持ち点の行を出し、金額の3つ目を「残り全部」にする。使い切ったら入口を閉じる", () => {
  const ls = memStorage({ teiyomi_yomi_records: "[]" });
  const s = Q.dayStore(ls, "2026-09-17", Y);
  s.add({ ken: "3連単", lanes: [1, 2, 3], amount: 300 });
  const on = mountHtml(s, { budget: true });
  assert.ok(on.includes('<p class="ybudget nums">持ち点 1,000円　使用 300円　<b>残り 700円</b>'));
  const off = mountHtml(s, {});
  assert.ok(!off.includes("ybudget"), "budget を渡さなければ持ち点は出ない(レースページと同じ)");
  s.add({ ken: "単勝", lanes: [1], amount: 700 });
  const full = mountHtml(s, { budget: true });
  assert.ok(full.includes("持ち点を使い切りました"));
  assert.ok(!full.includes('id="yOpen"'), "使い切ったら記録の入口を出さない");
});

test("答案: budget を渡すと、収支・回収率を持ち点1,000円基準で出す(使わなかったぶんは手元に残る)", () => {
  const top3 = [1, 2, 3].map((c) => QUIZ.answer.order.indexOf(c) + 1);
  const p = Q.paperOf(QUIZ, [{ id: "a", at: "x", ken: "3連単", lanes: top3, tag: "", amount: 300 }], null, Y);
  const paperEl = { innerHTML: "", querySelector: () => null };
  G.TeiyomiYomiPaper.render({ paperEl, p, when: "今日の一問", budget: 1000 });
  const html = paperEl.innerHTML;
  const fin = 1000 - p.result.bet + p.result.yen;
  assert.strictEqual(p.result.bet, 300);
  assert.ok(html.includes("<span>使った額</span><b class=\"nums\">300</b>"));
  assert.ok(html.includes(`回収率</span><b class="nums">${Math.round(fin / 1000 * 1000) / 10}%`), "回収率 = 最後の持ち点 ÷ 1,000");
  assert.ok(html.includes(`最後の持ち点は ${fin.toLocaleString()}円`));
  // 渡さなければ、これまでどおり(投入・払戻÷投入)
  const plainEl = { innerHTML: "", querySelector: () => null };
  G.TeiyomiYomiPaper.render({ paperEl: plainEl, p, when: "今日の一問" });
  assert.ok(plainEl.innerHTML.includes("<span>投入</span>") && !plainEl.innerHTML.includes("持ち点"));
});
