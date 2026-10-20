// バックテストの「艇の材料」(backtest-mat.js・rule-match.js の MATS)のテスト。
//   node --test tests/bt-mat.test.mjs
// 守りたいのは:
//   1. 帯が読み採点(yomi.js の YOMI_TABLE)と同じ(どの値でも同じ帯に入る)
//   2. 材料ファイルの整数を正しく戻せる(build_bt_materials.py の詰め方と同じ)。0.00 は分からない扱い
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

// build_bt_materials.py の pack と同じ式(テストの中で詰めて、戻せることを確かめる)
const pack = (k, nw, mo, st, fm) => {
  const q = (v, s, top) => (v == null ? top : Math.round(v * s));
  const kk = { A1: 0, A2: 1, B1: 2, B2: 3 }[k] ?? 7;
  return kk + 8 * (q(nw, 100, 1023) + 1024 * (q(mo, 100, 16383) + 16384 * (q(st, 10000, 16383) + 16384 * q(fm, 100, 1023))));
};

test("材料の整数を戻せる(最大の値でも 53 ビットに収まる)・0.00 は分からない扱い", () => {
  assert.deepStrictEqual({ ...BM.decodeBoat(pack("A1", 7.12, 45.5, 0.1395, 2.33)) }, { k: "A1", nw: 7.12, mo: 45.5, st: 0.1395, fm: 2.33 });
  assert.deepStrictEqual({ ...BM.decodeBoat(pack(null, null, null, null, null)) }, { k: null, nw: null, mo: null, st: null, fm: null });
  assert.deepStrictEqual({ ...BM.decodeBoat(pack("B2", 0, 0, 0.91, 6)) }, { k: "B2", nw: null, mo: null, st: 0.91, fm: 6 });
  const top = pack(null, null, null, null, null);
  assert.ok(Number.isSafeInteger(top), "いちばん大きい整数も正確に扱える");
});

test("Python の詰め方(build_bt_materials.pack)と同じ整数になる", () => {
  const py = process.platform === "win32" ? "python" : "python3";
  const cases = [["A1", 7.12, 45.5, 0.1395, 2.33], ["B2", 0.0, 0.0, 0.91, 6.0], [null, null, null, null, null], ["A2", 6.5, 40.0, 0.14, 2.0]];
  const out = execFileSync(py, ["-c",
    "import sys, json; sys.path.insert(0, sys.argv[1]); import build_bt_materials as B; " +
    "print(json.dumps([B.pack(*c) for c in json.loads(sys.argv[2])]))", ROOT, JSON.stringify(cases)],
    { encoding: "utf-8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
  assert.deepStrictEqual(JSON.parse(out), cases.map((c) => pack(...c)));
});

// 1レース = [鍵, 1号艇, …, 6号艇]
const ROW = [11201,
  pack("A1", 6.8, 38, 0.15, 2.0),   // 1号艇
  pack("B1", 4.2, 45, 0.13, 3.67),  // 2号艇: ST いちばん速い
  pack("A1", 7.2, 30, 0.17, 1.67),  // 3号艇: 全国勝率いちばん高い・直近いちばん良い
  pack("B2", 0, 0, null, null),     // 4号艇: 新人(分からない)
  pack("A2", 7.2, 41, 0.13, 1.67),  // 5号艇: 3号艇と同じ勝率・2号艇と同じ ST・3号艇と同じ直近
  pack("B1", 5.0, 33, 0.19, 4.0)];

test("しぼり込み: 帯のどれかに入れば当てはまる・条件どうしは AND・分からない艇は当てはまらない", () => {
  assert.ok(BM.passMats(ROW, [{ lane: 1, mat: "k", bands: ["A1"] }, { lane: 1, mat: "nw", bands: ["6.5-7.0", "7.0-"] }], null));
  assert.ok(!BM.passMats(ROW, [{ lane: 1, mat: "k", bands: ["A1"] }, { lane: 1, mat: "nw", bands: ["7.0-"] }], null));
  assert.ok(!BM.passMats(ROW, [{ lane: 4, mat: "nw", bands: ["-5.0"] }], null), "勝率0.00は5.0未満にも入らない");
  assert.ok(BM.passMats(ROW, [{ lane: "self", mat: "st", bands: ["-0.14"] }], 2), "この選手=2号艇");
  assert.ok(!BM.passMats(ROW, [{ lane: "self", mat: "st", bands: ["-0.14"] }], null), "通常モードに「この選手」は無い");
  assert.ok(!BM.passMats(null, [{ lane: 1, mat: "k", bands: ["A1"] }], null), "材料の無いレース");
});

test("材料で決める艇: いちばん高い/速い/良い艇。並んだら艇番の小さいほう・分からない艇は数えない", () => {
  assert.strictEqual(BM.pickLane(ROW, "nw"), 3, "7.2 が3号艇と5号艇 → 3号艇");
  assert.strictEqual(BM.pickLane(ROW, "st"), 2, "0.13 が2号艇と5号艇 → 2号艇");
  assert.strictEqual(BM.pickLane(ROW, "fm"), 3, "1.67 が3号艇と5号艇 → 3号艇");
  const allUnknown = [1, ...Array(6).fill(pack(null, null, null, null, null))];
  assert.strictEqual(BM.pickLane(allUnknown, "nw"), null);
  assert.strictEqual(BM.pickLane(null, "nw"), null);
});

test("鍵と月: 日×10000 + 会場コード×100 + レース番号・窓の月の並び", () => {
  const m = 5 | (11 << 16);   // 5R・会場コード11
  assert.strictEqual(BM.keyOf("2026-09-07", m), 71105);
  const s = BM.createStore();
  s.add("2026-09", [[71105, 1, 2, 3, 4, 5, 6]]);
  s.add("2026-09", [[71106, 9, 9, 9, 9, 9, 9]]);   // 足し込む(選手モードで同じ月を2本読む)
  assert.deepStrictEqual(plain(s.row("2026-09-07", m)), [71105, 1, 2, 3, 4, 5, 6]);
  assert.strictEqual(s.row("2026-10-07", m), null);
  assert.deepStrictEqual(plain(BM.monthsIn("2025-11-15", "2026-02-03")), ["2025-11", "2025-12", "2026-01", "2026-02"]);
});
