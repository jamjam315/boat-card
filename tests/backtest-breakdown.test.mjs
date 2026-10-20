// バックテスト(条件指定)の「年ごとの内訳」と「最長の連敗」(backtest-breakdown.js)のテスト。
//   node --test tests/backtest-breakdown.test.mjs
// 守りたいのは: 年ごとの数字を足すと全体と一致する・途中の年は範囲を書く・対象0の年も隠さない・
// 連敗は入ってきた順ではなく「日付 → レース番号 → 会場」の順で数える。
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const win = {};
vm.runInNewContext(readFileSync(join(ROOT, "backtest-breakdown.js"), "utf8"), { window: win, Float64Array, Object, Math, Date });
const B = win.TeiyomiBtBreakdown;
const plain = (x) => JSON.parse(JSON.stringify(x));

// m のビット詰め(build_backtest_custom.pack_meta)のうち、並べ方に使う2つだけ
const M = (rno, venue = 0) => (rno & 0xF) | (venue << 16);

test("年ごとの対象数・賭け金・払戻を足すと全体と一致し、対象0の年も行を出す", () => {
  const acc = B.create();
  const races = [
    ["2023-03-01", M(1), 100, 0, false], ["2023-03-01", M(2), 100, 250, true],
    ["2025-01-05", M(5), 100, 0, false], ["2025-12-31", M(12), 100, 1200, true],
    ["2026-02-01", M(3), 100, 0, false],
  ];
  for (const r of races) acc.add(...r);
  const out = plain(acc.result({ from: "2023-01-01", to: "2026-10-19" }, true));
  assert.deepStrictEqual(out.years.map((y) => y.year), [2023, 2024, 2025, 2026]);
  const sum = (k) => out.years.reduce((a, y) => a + y[k], 0);
  assert.strictEqual(sum("races"), races.length);
  assert.strictEqual(sum("stake"), 500);
  assert.strictEqual(sum("payout"), 1450);
  assert.strictEqual(sum("hits"), 2);
  const y2024 = out.years[1];
  assert.deepStrictEqual([y2024.races, y2024.hitRate, y2024.returnRate], [0, null, null], "対象0の年は数字の代わりに null");
  assert.strictEqual(out.years[0].hitRate, 0.5);
  assert.strictEqual(out.years[2].returnRate, 6);
});

test("途中の年は範囲を書く(から・まで・〜)。年をまるごと含むなら年だけ", () => {
  assert.strictEqual(B.yearLabel("2024", "2016-10-23", "2026-10-19"), "2024年");
  assert.strictEqual(B.yearLabel("2016", "2016-10-23", "2026-10-19"), "2016年（10/23から）");
  assert.strictEqual(B.yearLabel("2026", "2016-10-23", "2026-10-19"), "2026年（10/19まで）");
  assert.strictEqual(B.yearLabel("2025", "2025-03-01", "2025-06-30"), "2025年（3/1〜6/30）");
});

test("年の行は期間で決める: 対象が片方の年にしか無くても、期間が2つの年にまたがれば両方出す", () => {
  const acc = B.create();
  acc.add("2026-03-01", M(1), 100, 0, false);
  const out = plain(acc.result({ from: "2025-10-21", to: "2026-10-19" }, true));
  assert.deepStrictEqual(out.years.map((y) => [y.label, y.races]), [["2025年（10/21から）", 0], ["2026年（10/19まで）", 1]]);
});

test("年の表は、短い期間(showYears=false)と1年しか無いときは出さない", () => {
  const acc = B.create();
  acc.add("2025-05-01", M(1), 100, 0, false);
  acc.add("2025-06-01", M(1), 100, 0, false);
  assert.strictEqual(acc.result({ from: "2025-01-01", to: "2025-12-31" }, true).years, null, "1年だけ");
  acc.add("2026-01-02", M(1), 100, 0, false);
  assert.strictEqual(acc.result({ from: "2025-01-01", to: "2026-03-31" }, false).years, null, "短い期間");
  assert.strictEqual(acc.result({ from: "2025-01-01", to: "2026-03-31" }, true).years.length, 2);
});

test("最長の連敗: 入ってきた順ではなく、日付 → レース番号 → 会場の順で数える", () => {
  const acc = B.create();
  // わざと逆順・ばらばらに入れる。正しい順に並べると 5/12 2R〜5/13 1R の4連敗
  acc.add("2023-05-13", M(2), 100, 300, true);
  acc.add("2023-05-13", M(1), 100, 0, false);
  acc.add("2023-05-12", M(3, 4), 100, 0, false);   // 3R・会場4
  acc.add("2023-05-12", M(3, 2), 100, 0, false);   // 3R・会場2(会場4より先)
  acc.add("2023-05-12", M(2), 100, 0, false);
  acc.add("2023-05-12", M(1), 100, 500, true);
  const s = acc.result({ from: "2023-01-01", to: "2023-12-31" }, false).streak;
  assert.deepStrictEqual(plain(s), { n: 4, from: "2023/05/12", to: "2023/05/13" });
  assert.strictEqual(B.streakText(s), "最長の連敗　4レース（2023/05/12〜2023/05/13）");
});

test("最長の連敗: 同じ長さなら先に起きたほう・同じ日なら日付は1つ・外れが無ければ0", () => {
  const acc = B.create();
  acc.add("2024-01-01", M(1), 100, 0, false);
  acc.add("2024-01-01", M(2), 100, 0, false);
  acc.add("2024-01-02", M(1), 100, 400, true);
  acc.add("2024-02-01", M(1), 100, 0, false);
  acc.add("2024-02-02", M(1), 100, 0, false);
  const s = acc.result({ from: "2024-01-01", to: "2024-12-31" }, false).streak;
  assert.deepStrictEqual(plain(s), { n: 2, from: "2024/01/01", to: "2024/01/01" });
  assert.strictEqual(B.streakText(s), "最長の連敗　2レース（2024/01/01）");

  const all = B.create();
  all.add("2024-01-01", M(1), 100, 200, true);
  assert.strictEqual(B.streakText(all.result({ from: "2024-01-01", to: "2024-12-31" }, false).streak), "最長の連敗　0レース");
});

test("最長の連敗: 全部外れなら全レース・年をまたいでもつながる", () => {
  const acc = B.create();
  ["2023-12-30", "2023-12-31", "2024-01-01"].forEach((d, i) => acc.add(d, M(i + 1), 500, 0, false));
  assert.deepStrictEqual(plain(acc.result({ from: "2023-01-01", to: "2024-12-31" }, true).streak),
    { n: 3, from: "2023/12/30", to: "2024/01/01" });
});
