// 今日の一問のドット再生(quiz-replay.js)の時間割のテスト。
//   node --test tests/quiz-replay.test.mjs
// 守りたいのは「実際の結果どおりに並ぶこと」: 進入はコースの列へ、スタートはSTの順、ゴールは着順の順。
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const win = {};
vm.runInNewContext(readFileSync(join(ROOT, "quiz-replay.js"), "utf8"), { window: win });
const R = win.TeiyomiQuizReplay;

const QUIZZES = readdirSync(join(ROOT, "quiz")).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
  .map((f) => ({ file: f, A: JSON.parse(readFileSync(join(ROOT, "quiz", f), "utf8")).answer }));

test("出題ファイルの全問で、スタートはSTの順・ゴールは着順の順・進入はコースの列", { skip: !QUIZZES.length && "出題ファイルが無い" }, () => {
  for (const { file, A } of QUIZZES) {
    const P = R.plan(A);
    assert.ok(P, file);
    for (const b of P.boats) {
      assert.strictEqual(b.course, A.in[b.n - 1], `${file} ${b.n}号艇の進入`);
      assert.strictEqual(b.rank, A.order[b.n - 1], `${file} ${b.n}号艇の着順`);
      assert.ok(b.tLine < b.tArr, `${file} ${b.n}号艇はラインを越えてからゴールする`);
    }
    // STが早い(小さい)ほど先にラインを越える(同じSTは同時)
    const bySt = [...P.boats].sort((a, b) => a.st - b.st);
    for (let i = 1; i < 6; i++) assert.ok(bySt[i].tLine >= bySt[i - 1].tLine, `${file} スタートの順`);
    // 着順どおりにゴールする(同着は無い前提で、順は崩さない)
    const byRank = [...P.boats].sort((a, b) => a.rank - b.rank);
    for (let i = 1; i < 6; i++) assert.ok(byRank[i].tArr > byRank[i - 1].tArr, `${file} ゴールの順`);
    assert.ok(P.total < 12000, `${file} 12秒以内に終わる(${P.total}ms)`);
  }
});

test("着差はレースタイムの差に比例し、全体は2秒に収める", () => {
  // 2026-09-20 と同じ形: 全艇のタイムがある
  const A = { order: [2, 1, 3, 4, 6, 5], in: [1, 2, 3, 4, 6, 5], st: [0.18, 0.2, 0.17, 0.19, 0.32, 0.21],
    rt: [112.5, 111.2, 113.3, 114.4, 119.9, 115.5] };
  const P = R.plan(A);
  assert.strictEqual(P.gapFilled, false);
  const arr = (n) => P.boats[n - 1].tArr;
  const scale = Math.min(350, 2000 / (119.9 - 111.2));
  assert.strictEqual(arr(1) - arr(2), Math.round((112.5 - 111.2) * scale));    // 2着 − 1着
  assert.strictEqual(arr(5) - arr(2), Math.round((119.9 - 111.2) * scale));    // 最下位 − 1着 = 2秒
  assert.strictEqual(arr(5) - arr(2), 2000);
});

test("タイムの無い艇は、前後の間を等間隔で埋める(後ろが無ければ平均の差で伸ばす)", () => {
  // 1着 100.0 / 2着 なし / 3着 102.0 / 4着 103.0 / 5着 なし / 6着 なし
  const A = { order: [1, 2, 3, 4, 5, 6], in: [1, 2, 3, 4, 5, 6], st: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1],
    rt: [100, null, 102, 103, null, null] };
  const P = R.plan(A);
  assert.strictEqual(P.gapFilled, true);
  const t = [...P.boats].map((b) => b.tArr);   // vm の配列は別の Array なので、こちらの配列に移す
  const d = t.map((x) => x - t[0]);
  // 秒で 0, 1, 2, 3, 4, 5(平均1秒で伸ばす)。5秒 × 0.35 = 1.75秒で、2秒の上限には届かない
  assert.deepStrictEqual(d, [0, 1, 2, 3, 4, 5].map((s) => Math.round(s * 350)));
});

test("完走しなかった艇がいる・数字が崩れているレースは再生しない(null)", () => {
  const ok = { order: [1, 2, 3, 4, 5, 6], in: [1, 2, 3, 4, 5, 6], st: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1], rt: [] };
  assert.ok(R.plan(ok));
  assert.strictEqual(R.plan({ ...ok, order: [1, 2, 3, 4, 5, null] }), null, "着が無い艇");
  assert.strictEqual(R.plan({ ...ok, order: [1, 2, 3, 4, 5, 5] }), null, "同じ着が2艇");
  assert.strictEqual(R.plan({ ...ok, in: [1, 2, 3, 4, 5] }), null, "進入が欠けている");
  assert.strictEqual(R.plan({ ...ok, st: [0.1, 0.1, 0.1, 0.1, 0.1, -0.01] }), null, "フライング(負のST)");
  assert.strictEqual(R.plan({ ...ok, st: [0.1, 0.1, 0.1, 0.1, 0.1, "0.1"] }), null, "STが数でない");
  assert.strictEqual(R.plan(null), null);
});

test("進入が枠なりかどうかを見分ける(画面の言い方を変える)", () => {
  const base = { order: [1, 2, 3, 4, 5, 6], st: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1], rt: [] };
  assert.strictEqual(R.plan({ ...base, in: [1, 2, 3, 4, 5, 6] }).entryChanged, false);
  assert.strictEqual(R.plan({ ...base, in: [1, 3, 4, 5, 6, 2] }).entryChanged, true);
});
