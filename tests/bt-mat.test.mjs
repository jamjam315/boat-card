// バックテストの「艇の材料」(backtest-mat.js・rule-match.js の MATS)のテスト。
//   node --test tests/bt-mat.test.mjs
// 守りたいのは:
//   1. 帯が読み採点(yomi.js の YOMI_TABLE)と同じ(どの値でも同じ帯に入る)
//   2. 材料ファイルの列を正しく読める(build_bt_materials.py の書き出しと同じ形)。0.00 は分からない扱い
//   3. しぼり込み(passMats)・材料で決める艇(pickLane)の決まり。並んだら艇番の小さいほう
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const win = { localStorage: { getItem: () => null, setItem() {} } };
for (const f of ["rule-match.js", "backtest-mat.js", "yomi.js"]) {
  vm.runInNewContext(readFileSync(join(ROOT, f), "utf8"), { window: win, Map, Math, Date, Number, Object, Set });
}
const RM = win.TeiyomiRuleMatch, BM = win.TeiyomiBtMat, Y = win.TeiyomiYomi;
const plain = (x) => JSON.parse(JSON.stringify(x));   // vm の中の配列を、こちらの配列に直して比べる

// yomi.js の bandOf と同じ決め方で、YOMI_TABLE の何番目の帯かを出す
function yomiBand(cat, v) {
  const bands = Y.YOMI_TABLE[cat].bands;
  for (let i = 0; i < bands.length; i++) {
    const b = bands[i];
    if (b.min !== undefined ? v >= b.min : v < b.max) return i;
  }
  return bands.length - 1;
}
function ourBand(mat, v) {
  const d = RM.matDef(mat);
  return d.bands.findIndex((b) => RM.inMatBands(mat, v, [b.key]));
}

test("帯は読み採点と同じ: 全国勝率・平均ST・直近3走は、どの値でも同じ帯に入る", () => {
  const grid = (lo, hi, step) => { const a = []; for (let v = lo; v <= hi + 1e-9; v += step) a.push(Math.round(v * 10000) / 10000); return a; };
  for (const [cat, mat, values] of [["A", "nw", grid(0.01, 9.99, 0.01)], ["B", "st", grid(0, 0.5, 0.0005)], ["C", "fm", grid(1, 6, 1 / 3)]]) {
    assert.strictEqual(RM.matDef(mat).bands.length, Y.YOMI_TABLE[cat].bands.length, mat + " の帯の数");
    for (const v of values) assert.strictEqual(ourBand(mat, v), yomiBand(cat, v), `${mat}=${v}`);
  }
  // 境目は「以上・未満」
  assert.strictEqual(ourBand("nw", 6.5), 1);
  assert.strictEqual(ourBand("st", 0.14), 1);
  assert.strictEqual(ourBand("fm", 2.0), 1);
});

// 1レースぶんの材料を、ファイルと同じ列の形で作る(build_bt_materials.cell / columns と同じ)
const cell = (k, nw, mo, st, fm) => [{ A1: 0, A2: 1, B1: 2, B2: 3 }[k] ?? 7,
  nw == null ? 0 : Math.round(nw * 100), mo == null ? 0 : Math.round(mo * 100),
  st == null ? -1 : Math.round(st * 10000), fm == null ? -1 : Math.round(fm * 100)];
function chunkOf(races) {   // races = [[鍵, 6艇の cell], …]
  const c = { keys: races.map((r) => r[0]), k: races.map((r) => r[1].map((x) => x[0]).join("")) };
  ["nw", "mo", "st", "fm"].forEach((f, j) => { c[f] = races.flatMap((r) => r[1].map((x) => x[j + 1])); });
  return c;
}

test("Python の書き出し(build_bt_materials.columns)とテストの列が同じ・JS で同じ値に戻る", () => {
  const py = process.platform === "win32" ? "python" : "python3";
  const boats = [["A1", 7.12, 45.5, 0.1395, 2.33], ["B2", 0.0, 0.0, 0.91, 6.0], [null, null, null, null, null],
                 ["A2", 6.5, 40.0, 0.14, 2.0], ["B1", 5.0, 33.33, 0.19, 4.0], ["A1", 3.0, 25.0, null, null]];
  const out = execFileSync(py, ["-c",
    "import sys, json; sys.path.insert(0, sys.argv[1]); import build_bt_materials as B; " +
    "b = json.loads(sys.argv[2]); print(json.dumps(B.columns([[11201] + [B.cell(*x) for x in b]])))", ROOT, JSON.stringify(boats)],
    { encoding: "utf-8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
  const fromPy = JSON.parse(out);
  assert.deepStrictEqual(fromPy, chunkOf([[11201, boats.map((b) => cell(...b))]]));
  const ref = [fromPy, 0];
  assert.deepStrictEqual(["k", "nw", "mo", "st", "fm"].map((f) => BM.value(ref, 1, f)), ["A1", 7.12, 45.5, 0.1395, 2.33]);
  assert.deepStrictEqual(["k", "nw", "mo", "st", "fm"].map((f) => BM.value(ref, 2, f)), ["B2", null, null, 0.91, 6], "0.00 は分からない扱い");
  assert.deepStrictEqual(["k", "nw", "mo", "st", "fm"].map((f) => BM.value(ref, 3, f)), [null, null, null, null, null]);
  assert.strictEqual(BM.value([{ keys: [1], k: ["000000"] }, 0], 1, "nw"), null, "列をまだ読んでいなければ null");
});

// 1レース(鍵 11201)
const RACE = chunkOf([[11201, [
  cell("A1", 6.8, 38, 0.15, 2.0),   // 1号艇
  cell("B1", 4.2, 45, 0.13, 3.67),  // 2号艇: ST いちばん速い
  cell("A1", 7.2, 30, 0.17, 1.67),  // 3号艇: 全国勝率いちばん高い・直近いちばん良い
  cell("B2", 0, 0, null, null),     // 4号艇: 新人(分からない)
  cell("A2", 7.2, 41, 0.13, 1.67),  // 5号艇: 3号艇と同じ勝率・2号艇と同じ ST・3号艇と同じ直近
  cell("B1", 5.0, 33, 0.19, 4.0)]]]);
const REF = [RACE, 0];

test("しぼり込み: 帯のどれかに入れば当てはまる・条件どうしは AND・分からない艇は当てはまらない", () => {
  assert.ok(BM.passMats(REF, [{ lane: 1, mat: "k", bands: ["A1"] }, { lane: 1, mat: "nw", bands: ["6.5-7.0", "7.0-"] }], null));
  assert.ok(!BM.passMats(REF, [{ lane: 1, mat: "k", bands: ["A1"] }, { lane: 1, mat: "nw", bands: ["7.0-"] }], null));
  assert.ok(!BM.passMats(REF, [{ lane: 4, mat: "nw", bands: ["-5.0"] }], null), "勝率0.00は5.0未満にも入らない");
  assert.ok(BM.passMats(REF, [{ lane: "self", mat: "st", bands: ["-0.14"] }], 2), "この選手=2号艇");
  assert.ok(!BM.passMats(REF, [{ lane: "self", mat: "st", bands: ["-0.14"] }], null), "通常モードに「この選手」は無い");
  assert.ok(!BM.passMats(null, [{ lane: 1, mat: "k", bands: ["A1"] }], null), "材料の無いレース");
});

test("材料で決める艇: いちばん高い/速い/良い艇。並んだら艇番の小さいほう・分からない艇は数えない", () => {
  assert.strictEqual(BM.pickLane(REF, "nw"), 3, "7.2 が3号艇と5号艇 → 3号艇");
  assert.strictEqual(BM.pickLane(REF, "st"), 2, "0.13 が2号艇と5号艇 → 2号艇");
  assert.strictEqual(BM.pickLane(REF, "fm"), 3, "1.67 が3号艇と5号艇 → 3号艇");
  const unknown = chunkOf([[1, Array(6).fill(cell(null, null, null, null, null))]]);
  assert.strictEqual(BM.pickLane([unknown, 0], "nw"), null);
  assert.strictEqual(BM.pickLane(null, "nw"), null);
});

test("入れ物: セット×月ごと・鍵は 日×10000 + 会場コード×100 + レース番号・要る列・窓の月", () => {
  const m = 5 | (11 << 16);   // 5R・会場コード11
  assert.strictEqual(BM.keyOf("2026-09-07", m), 71105);
  const s = BM.createStore();
  const c = chunkOf([[71105, Array(6).fill(cell("A1", 6, 30, 0.15, 3))]]);
  s.addChunk("kiryu", "2026-09", c);
  assert.strictEqual(s.find("kiryu", "2026-09-07", m)[1], 0);
  assert.strictEqual(s.find("all", "2026-09-07", m), null, "別のセットには無い");
  assert.strictEqual(s.find("kiryu", "2026-10-07", m), null, "別の月には無い");
  assert.deepStrictEqual(plain(BM.fieldsFor([{ mat: "k" }, { mat: "nw" }, { mat: "k" }], "st")), ["k", "nw", "st"]);
  assert.deepStrictEqual(plain(BM.monthsIn("2025-11-15", "2026-02-03")), ["2025-11", "2025-12", "2026-01", "2026-02"]);
});
