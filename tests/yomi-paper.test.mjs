// 答案の描画部品(yomi-paper.js)のテスト。AI-14 v1② で新設。
//   node --test tests/*.test.mjs
//
// 守りたいのは2つ。
//   1. 実レース7本×6通り=42答案の「紙」のHTMLが、固定した出力(tests/fixtures/yomi-paper-expected.json)と
//      1文字も変わらない。yomi.html の実レース答案は、部品化の前後でピクセル単位の一致を確かめてから
//      固定した(手元のヘッドレスChromeで53通り×2画面幅×明暗=212枚)。今日の一問で部品を触るときに、
//      実レースの答案を変えていないかをCIで見張る。
//      描画を意図して変えたときは UPDATE_GOLDEN=1 node --test tests/yomi-paper.test.mjs で作り直す
//   2. 描く側が変えられるもの(ヘッダーの表示・つづきの会場)が効く。何も渡さなければ実レースの答案と同じ
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RACES = JSON.parse(readFileSync(join(ROOT, "tests/fixtures/yomi-engine-races.json"), "utf8")).races;
const GOLDEN_PATH = join(ROOT, "tests/fixtures/yomi-paper-expected.json");

// 紙のフッターに生成時刻が入るので、時計を固定する(端末の時刻帯によらないよう UTC の正午)
const NOW = "2026-09-17T12:00:00.000Z";
class FixedDate extends Date {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return Date.parse(NOW); }
  getHours() { return this.getUTCHours(); }
  getMinutes() { return this.getUTCMinutes(); }
  getDate() { return this.getUTCDate(); }
  getMonth() { return this.getUTCMonth(); }
  getFullYear() { return this.getUTCFullYear(); }
}

function load() {
  const sandbox = {
    localStorage: { getItem: () => null, setItem() {} },
    document: { getElementById: () => null },
    Date: FixedDate,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(ROOT, "yomi.js"), "utf8"), sandbox);
  vm.runInContext(readFileSync(join(ROOT, "yomi-paper.js"), "utf8"), sandbox);
  return sandbox;
}
const G = load();
const Y = G.TeiyomiYomi;
const plain = (x) => JSON.parse(JSON.stringify(x));

// 紙だけを描く(AI講評の枠とつづきは、DOMが要るので要素を渡さない=描かない)
function paperHtml(p, opts = {}) {
  const paperEl = { innerHTML: "", querySelector: () => null };
  const nextEl = opts.withNext ? { innerHTML: "" } : null;
  G.TeiyomiYomiPaper.render({ paperEl, nextEl, p, ...opts.extra });
  return { paper: paperEl.innerHTML, next: nextEl && nextEl.innerHTML };
}

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

function paperOf(key, snapshot, race, list, tag = "") {
  const records = list.map(([ken, lanes, amount], i) => {
    const r = { key, ken, lanes, amount, tag, id: String(i), at: NOW };
    return { ...r, score: plain(Y.scoreOne(r, race)) };
  });
  return { key, tag, ...Y.buildPaper(records, snapshot) };
}

test("実レース7本×6通りの答案の紙が、固定した出力と1文字も変わらない", () => {
  const now = {};
  for (const { key, snapshot, race } of RACES) {
    for (const [name, list] of Object.entries(bundles(race))) {
      now[key + " / " + name] = paperHtml(paperOf(key, snapshot, race, list)).paper;
    }
  }
  if (process.env.UPDATE_GOLDEN === "1") writeFileSync(GOLDEN_PATH, JSON.stringify(now, null, 1) + "\n");
  const expected = JSON.parse(readFileSync(GOLDEN_PATH, "utf8"));
  assert.deepStrictEqual(Object.keys(now), Object.keys(expected));
  for (const k of Object.keys(expected)) assert.strictEqual(now[k], expected[k], k);
});

test("何も渡さなければ、ヘッダーは「日付　会場 nR」(タグ付き)、つづきの会場はレースキーから", () => {
  const { key, snapshot, race } = RACES[0];   // 2026-09-11:大村:11
  const p = paperOf(key, snapshot, race, [["3連単", [1, 3, 2], 100]], "展示重視");
  const out = paperHtml(p, { withNext: true });
  assert.ok(out.paper.includes('<span class="when nums">2026-09-11　大村 11R　/　展示重視</span>'));
  assert.ok(out.next.includes(encodeURIComponent('"venue":"大村"')));
  assert.ok(out.next.includes("大村・1号艇を軸（1着）・3連単・過去10年"));
});

test("今日の一問のように、ヘッダーの表示とつづきの会場を差し替えられる(ヘッダーは文字として出す)", () => {
  const { key, snapshot, race } = RACES[0];
  const p = paperOf(key, snapshot, race, [["3連単", [1, 3, 2], 100]]);
  const out = paperHtml(p, { withNext: true, extra: { when: "今日の一問　大村 <11R>", venue: "大村" } });
  assert.ok(out.paper.includes('<span class="when nums">今日の一問　大村 &lt;11R&gt;</span>'));
  assert.ok(!out.paper.includes("2026-09-11"), "日付を伏せられる");
  assert.ok(out.next.includes(encodeURIComponent('"venue":"大村"')));
});
