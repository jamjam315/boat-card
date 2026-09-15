// top-first.js(トップの最初の1画面ぶんの写し)のテスト。
//   node --test tests/*.test.mjs
//
// 守りたいのは2つ。
//   1. 写しが data.js と食い違っていない(会場の並びと、先頭の会場のレースが同じ)。
//      data.js だけ作り直して top-first.js を作り直し忘れると、トップの最初の画面が
//      古いレースを出す。daily.yml は同じコミットで両方を作るので、ずれたら落とす。
//   2. 写しは data.js の中身を「切り出しただけ」で、値を足したり変えたりしていない。
//
// stats.js / players.js は深夜の results.yml で先に更新され、写しと一時的にずれるのが
// 正常なので、ここでは突き合わせない(ページは本体が届いたら描き直す)。
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// vm で読んだ値は別のコンテキストの Object / Array なので、そのまま比べると
// 中身が同じでも deepStrictEqual が「参照が違う」で落ちる。JSON を通して、
// このテストの側の Object / Array に作り直してから返す。
function load(file, varName) {
  const window = {};
  vm.runInNewContext(readFileSync(join(ROOT, file), "utf8"), { window });
  return JSON.parse(JSON.stringify(window[varName]));
}

const HAVE = existsSync(join(ROOT, "top-first.js")) && existsSync(join(ROOT, "data.js"));

test("会場の並びが data.js と同じ", { skip: !HAVE }, () => {
  const first = load("top-first.js", "TOP_FIRST");
  const data = load("data.js", "DATA");
  assert.strictEqual(first.data.date, data.date, "日付が違う(作り直し忘れ)");
  assert.deepStrictEqual(first.data.venues.map((v) => v.name), data.venues.map((v) => v.name));
});

test("先頭の会場のレースが data.js と一字一句同じ", { skip: !HAVE }, () => {
  const first = load("top-first.js", "TOP_FIRST");
  const data = load("data.js", "DATA");
  assert.deepStrictEqual(first.data.venues[0], data.venues[0]);
  assert.strictEqual(first.venue, data.venues[0].name);
});

test("先頭以外の会場にはレースを持たない(小さく保つ)", { skip: !HAVE }, () => {
  const first = load("top-first.js", "TOP_FIRST");
  for (const v of first.data.venues.slice(1)) {
    assert.strictEqual(v.races, undefined, `${v.name} にレースが入っている`);
  }
});

test("選手・モーターの写しは、先頭の会場に出る分だけ", { skip: !HAVE }, () => {
  const first = load("top-first.js", "TOP_FIRST");
  const races = first.data.venues[0].races;
  const tobans = new Set(races.flatMap((r) => r.boats.map((b) => String(b.t))));
  for (const t of Object.keys(first.players?.players || {})) {
    assert.ok(tobans.has(t), `先頭の会場に出ない選手 ${t} が入っている`);
  }
  for (const k of Object.keys(first.motors || {})) {
    assert.ok(k.startsWith(first.venue + ":"), `別の会場のモーター ${k} が入っている`);
  }
});
