// 今日の一問の出題ファイル(quiz/{出題日}.json)のテスト。AI-14 v1③ で新設。
//   node --test tests/*.test.mjs
// 毎晩 results.yml が build_quiz.py で作ったあと、コミットの前にもこのテストを流す(形が崩れたら配らない)。
//
// 守りたいのは4つ。
//   1. 問題(question)と答え(answer)が分かれていて、問題にはレースの日付・締切・レースキーが入っていない
//   2. 出題の決まり: 6艇とも完走・払戻あり・出題日の8日以上前のレース・使用済みを出さない・
//      同じ会場を7日以内に出さない
//   3. 答えの中身が払戻と食い違わない(着順から作った3連単が払戻の3連単と一致)
//   4. 読み採点のエンジンでそのまま採点できる({...answer, wx} で scoreOne、{boats} で buildPaper)
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "quiz");
const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort() : [];
const quizzes = files.map((f) => ({ file: f, q: JSON.parse(readFileSync(join(DIR, f), "utf8")) }));

const DAY = 86400000;
const days = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / DAY);

function hasKeyDeep(x, names) {
  if (Array.isArray(x)) return x.some((v) => hasKeyDeep(v, names));
  if (x && typeof x === "object") return Object.keys(x).some((k) => names.includes(k) || hasKeyDeep(x[k], names));
  return false;
}

test("問題と答えが分かれ、問題にレースの日付・締切・レースキーが無い", { skip: !files.length && "出題ファイルがまだ無い" }, () => {
  for (const { file, q } of quizzes) {
    assert.strictEqual(file, q.date + ".json", file);
    assert.deepStrictEqual(Object.keys(q).sort(), ["answer", "date", "question"], file);
    const Q = q.question;
    assert.ok(!hasKeyDeep(Q, ["date", "key", "dl"]), `${file} の問題に date/key/dl`);
    assert.ok(!JSON.stringify(Q).includes(q.answer.date), `${file} の問題にレースの日付の文字列`);
    assert.ok(typeof Q.venue === "string" && Q.no >= 1 && Q.no <= 12, file);
    assert.deepStrictEqual(Object.keys(Q.wx).sort(), ["天候", "波高", "風向", "風速"].sort(), file);
    // 波高・風速は数(無ければ null)、天候・風向は文字(無ければ null)。数の欄に文字が入っていないこと
    // (画面は数だと確かめてから出すが、出題の段階でも崩れを止める・2026-09-18 点検 低3)
    for (const k of ["波高", "風速"]) {
      assert.ok(Q.wx[k] === null || (typeof Q.wx[k] === "number" && Number.isFinite(Q.wx[k])), `${file} wx.${k}`);
    }
    for (const k of ["天候", "風向"]) {
      assert.ok(Q.wx[k] === null || typeof Q.wx[k] === "string", `${file} wx.${k}`);
    }
    assert.deepStrictEqual(Q.boats.map((b) => b.n), [1, 2, 3, 4, 5, 6], file);
    for (const b of Q.boats) {
      assert.ok(typeof b.ex === "number" && b.ex > 5 && b.ex < 9, `${file} ${b.n}号艇の展示タイム`);
      assert.ok(b.t && b.name && b.ks, `${file} ${b.n}号艇の番組表の数字`);
    }
  }
});

test("答え: どのレースか・着順・進入・ST・レースタイム・払戻がそろい、払戻と食い違わない", { skip: !files.length && "出題ファイルがまだ無い" }, () => {
  for (const { file, q } of quizzes) {
    const A = q.answer;
    assert.strictEqual(A.key, `${A.date}:${q.question.venue}:${q.question.no}`, file);
    assert.deepStrictEqual([...A.order].sort(), [1, 2, 3, 4, 5, 6], `${file} 6艇とも着がある`);
    assert.deepStrictEqual([...A.in].sort(), [1, 2, 3, 4, 5, 6], `${file} 進入`);
    assert.ok(A.st.every((x) => typeof x === "number" && x >= 0 && x < 1), `${file} ST`);
    assert.ok(A.rt.every((x) => x === null || (x > 90 && x < 150)), `${file} レースタイム(秒)`);
    assert.ok(A.pay["3連単"] && A.pay["3連単"].length, `${file} 3連単の払戻`);
    const top3 = [1, 2, 3].map((c) => A.order.indexOf(c) + 1).join("-");
    assert.ok(A.pay["3連単"].some((p) => p.c === top3), `${file} 着順 ${top3} と3連単の払戻`);
  }
});

test("出題の決まり: 8日以上前のレース・使用済みを出さない・同じ会場を7日以内に出さない", { skip: !files.length && "出題ファイルがまだ無い" }, () => {
  const seen = new Map();
  for (const { file, q } of quizzes) {
    assert.ok(q.answer.date >= "2026-07-26", `${file} 池は2026-07-26以降`);
    assert.ok(days(q.date, q.answer.date) >= 8, `${file} 出題日の8日以上前のレース(${q.answer.date})`);
    assert.ok(!seen.has(q.answer.key), `${file} と ${seen.get(q.answer.key)} が同じレース`);
    seen.set(q.answer.key, file);
  }
  for (let i = 0; i < quizzes.length; i++) {
    for (let j = i + 1; j < quizzes.length; j++) {
      const a = quizzes[i].q, b = quizzes[j].q;
      if (Math.abs(days(a.date, b.date)) < 7) {
        assert.notStrictEqual(a.question.venue, b.question.venue, `${a.date} と ${b.date} が同じ会場`);
      }
    }
  }
});

test("読み採点のエンジンでそのまま採点できる", { skip: !files.length && "出題ファイルがまだ無い" }, () => {
  const win = { localStorage: { getItem: () => null, setItem() {} } };
  vm.runInNewContext(readFileSync(join(ROOT, "yomi.js"), "utf8"), { window: win, localStorage: win.localStorage });
  const Y = win.TeiyomiYomi;
  const plain = (x) => JSON.parse(JSON.stringify(x));
  for (const { file, q } of quizzes) {
    const race = { ...q.answer, wx: q.question.wx };
    const lanes = [1, 2, 3].map((c) => q.answer.order.indexOf(c) + 1);
    const rec = { ken: "3連単", lanes, amount: 100, tag: "", id: "x", at: "x" };
    const s = plain(Y.scoreOne(rec, race));
    assert.strictEqual(s.st, "hit", file);
    assert.strictEqual(s.yen, q.answer.pay["3連単"].find((p) => p.c === lanes.join("-")).y, file);
    const p = plain(Y.buildPaper([{ ...rec, score: s }], { boats: q.question.boats }));
    assert.strictEqual(p.settled, true, file);
    assert.ok(p.yomi && p.yomi.rows.length === 4, `${file} 読み点の内訳`);
    assert.strictEqual(p.wave, q.question.wx["波高"], file);
  }
});
