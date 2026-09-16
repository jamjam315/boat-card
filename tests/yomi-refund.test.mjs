// 読み採点の「返還」と「採点し直し」のテスト(2026-09-17 欠場の払戻バグの修正)。
//   node --test tests/*.test.mjs
//
// 守りたいのは3つ。
//   1. 欠場・フライング・出遅れの艇(払戻JSONの refund)を含む買い目は返還(void)。
//      含まない買い目は普段どおり当たり/外れ。返還でも波高・進入は残す(読み点と講評に要る)
//   2. 直す前に「返還」「外れ」で採点した記録は、一度だけ結果を取り直して採点し直す。
//      直した後に採点した記録は取り直さない(毎回ネットワークに出ない)
//   3. 採点し直しても、生成済みのAI講評は消さない(消すと再送信で回数が減る)
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = readFileSync(join(ROOT, "yomi.js"), "utf8");

// 採点の時刻(at)は「今」になる。RESCORE_BEFORE より後の「今」で動かすため、時計を固定する
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
  return { Y: win.TeiyomiYomi, store };
}

// vm の中で作られた値は別コンテキストのものなので、JSON を通してから比べる
const plain = (x) => JSON.parse(JSON.stringify(x));

const KEY = "2026-09-01:下関:6";
// 3号艇が欠場したレース(実データ 2026-09-01 下関6R と同じ形)
const RACE = {
  order: [3, 1, null, 2, 4, 5],
  in: [1, 2, null, 3, 4, 5],
  kimarite: "逃げ",
  wx: { "天候": "晴", "風向": "北西", "風速": 2, "波高": 1 },
  pay: {
    "3連単": [{ c: "2-4-1", y: 25440, p: 41 }],
    "2連単": [{ c: "2-4", y: 10310, p: 15 }],
  },
  refund: [3],
};
const rec = (lanes, extra = {}) => ({
  key: KEY, ken: "3連単", lanes, amount: 100, tag: "", id: lanes.join(""), at: "2026-09-01T00:00:00.000Z", ...extra,
});

test("RESCORE_BEFORE に時刻が入っている(置き換え忘れを出荷しない)", () => {
  assert.match(SRC, /var RESCORE_BEFORE = "\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z";/);
});

test("返還の艇を含む買い目は void、含まない買い目は当たり/外れ", () => {
  const { Y } = loadYomi();
  const v = plain(Y.scoreOne(rec([2, 3, 1]), RACE));
  assert.strictEqual(v.st, "void");
  assert.strictEqual(v.refund, true);
  assert.strictEqual(v.pt, null);
  assert.strictEqual(v.wave, 1, "返還でも波高は残す");
  assert.deepStrictEqual(v.inn, [1, 2, null, 3, 4, 5]);

  const hit = plain(Y.scoreOne(rec([2, 4, 1]), RACE));
  assert.strictEqual(hit.st, "hit");
  assert.strictEqual(hit.yen, 25440);

  const miss = plain(Y.scoreOne(rec([1, 2, 4]), RACE));
  assert.strictEqual(miss.st, "miss");

  // refund が無いレース(古い払戻JSON)は従来どおり
  const { refund, ...old } = RACE;
  assert.strictEqual(plain(Y.scoreOne(rec([2, 3, 1]), old)).st, "miss");
  // 不成立は従来どおり void
  assert.strictEqual(plain(Y.scoreOne(rec([2, 4, 1]), { status: "不成立" })).st, "void");
});

test("直す前に返還・外れで採点した記録だけを、一度だけ採点し直す(AI講評は残す)", () => {
  const OLD = "2026-09-10T00:00:00.000Z";   // 直す前
  const NEW = "2030-01-01T00:00:00.000Z";   // 直した後
  const records = [
    rec([2, 4, 1], { id: "a", score: { at: OLD, st: "void", pt: null } }),                 // 不成立扱いだった → 当たり
    rec([2, 3, 1], { id: "b", score: { at: OLD, st: "miss", pt: 0, wave: 1, inn: [1, 2, null, 3, 4, 5],
      ai: { text: "講評", at: OLD } } }),                                                    // 外れ扱いだった → 返還
    rec([1, 2, 4], { id: "c", score: { at: NEW, st: "void", pt: null } }),                 // 直した後の記録は触らない
    rec([1, 2, 5], { id: "d", score: { at: OLD, st: "hit", pt: 10, wave: 1, inn: [1, 2, 3, 4, 5, 6] } }), // 当たりは触らない
  ];
  const { Y, store } = loadYomi({ teiyomi_yomi_records: JSON.stringify(records) });

  assert.deepStrictEqual(plain(Y.unscoredDates()), ["2026-09-01"]);
  const n = Y.applyPayouts("2026-09-01", { date: "2026-09-01", races: { [KEY]: RACE } });
  assert.strictEqual(n, 2);

  const after = JSON.parse(store.teiyomi_yomi_records);
  const by = Object.fromEntries(after.map((r) => [r.id, r.score]));
  assert.strictEqual(by.a.st, "hit");
  assert.strictEqual(by.b.st, "void");
  assert.deepStrictEqual(by.b.ai, { text: "講評", at: OLD }, "AI講評は引き継ぐ");
  assert.strictEqual(by.c.at, NEW, "直した後の記録はそのまま");
  assert.strictEqual(by.d.at, OLD, "当たりはそのまま");

  // 採点し直した後は、もう取りに行かない
  const again = loadYomi({ teiyomi_yomi_records: store.teiyomi_yomi_records });
  assert.deepStrictEqual(plain(again.Y.unscoredDates()), []);
});

test("答案の結果: 全部が欠場などの返還なら refund を付け、不成立が混じれば付けない", () => {
  const { Y } = loadYomi();
  const v = (refund) => ({ score: { at: "2030-01-01T00:00:00.000Z", st: "void", pt: null, ...(refund ? { refund: true } : {}) }, amount: 100 });
  assert.deepStrictEqual(plain(Y.groupResult([v(true), v(true)])), { status: "void", refund: true });
  assert.deepStrictEqual(plain(Y.groupResult([v(true), v(false)])), { status: "void", refund: false });
  assert.strictEqual(plain(Y.groupResult([v(true), { amount: 100 }])).status, "pending");
});
