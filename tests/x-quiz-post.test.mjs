// 今日の一問のX投稿(scripts/x_quiz_post.py)の本文のテスト。
//   node --test tests/x-quiz-post.test.mjs   (python が要る)
// 守りたいのは「答えの側を本文に出さない」: レースの日付・着順・決まり手・払戻。
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PY = process.platform === "win32" ? "python" : "python3";
const FILES = readdirSync(join(ROOT, "quiz")).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));

function preview(date) {
  return execFileSync(PY, [join(ROOT, "scripts", "x_quiz_post.py"), "--preview", "--today", date],
    { encoding: "utf-8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } }).replace(/\r\n/g, "\n");   // Windows の改行をそろえる
}

test("出題ファイルの全日で、本文に答えの側(日付・着順・決まり手・払戻)が出ない", { skip: !FILES.length && "出題ファイルが無い" }, () => {
  for (const f of FILES) {
    const q = JSON.parse(readFileSync(join(ROOT, "quiz", f), "utf8"));
    const out = preview(q.date);
    const [head, reply] = out.split(/\[quiz-x\] 返信[^\n]*\n/);
    const body = head.split("\n").slice(1).join("\n");
    const A = q.answer;
    const [y, m, d] = A.date.split("-");
    for (const s of [A.date, `${Number(m)}/${Number(d)}`, `${Number(m)}月${Number(d)}日`, `${y}年`]) {
      assert.ok(!body.includes(s), `${f} レースの日付 ${s}`);
    }
    if (A.kimarite) assert.ok(!body.includes(A.kimarite), `${f} 決まり手`);
    for (const [ken, rows] of Object.entries(A.pay || {})) {
      for (const r of rows) {
        if (typeof r.y === "number" && r.y >= 1000) assert.ok(!body.includes(r.y.toLocaleString()), `${f} ${ken}の払戻`);
      }
    }
    assert.ok(!/着|的中|払戻|回収/.test(body), `${f} 結果の言葉`);
    // 出すものは出ている
    assert.ok(body.includes(q.question.venue) && body.includes(`${q.question.no}R`), `${f} 会場とレース番号`);
    for (const b of q.question.boats) assert.ok(body.includes(`${b.n} ${b.name.replace(/\s+/g, " ").trim()}`), `${f} ${b.n}号艇の選手名`);
    assert.ok(!body.includes("http"), `${f} リンクは本文に入れない`);
    assert.strictEqual(reply.trim(), "今日の一問 → https://teiyomi.com/quiz.html", `${f} リンクは返信で`);
    assert.ok(body.includes("過去に実際にあったレースです。番組表を読んで買い目を記録すると、スタートで結果と答案が出ます。\n#ボートレース #競艇"), `${f} 末尾2行`);
    const n = Number(/文字数 (\d+)\/280/.exec(out)[1]);
    assert.ok(n <= 280, `${f} 長さ ${n}`);
  }
});

test("出題ファイルが無い日は投稿しない(非0で終わる)", () => {
  assert.throws(() => preview("2000-01-01"), /出題ファイルが無いか崩れています/);
});
