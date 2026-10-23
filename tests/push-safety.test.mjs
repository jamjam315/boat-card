// 朝の通知の守り(2026-10-23 点検の中-1・中-2)のうち、ブラウザ側のテスト。
//   node --test tests/*.test.mjs
// サーバー側(照合・宛先の許可リスト・失敗の知らせ)は supabase/functions/_shared/*_test.ts で見ている。
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

/** 文字列の中から、通知サービスのホスト名らしいもの(ドット始まりの接尾辞も)を拾う。 */
function hostsIn(src) {
  return [...src.matchAll(/["'](\.?[a-z0-9-]+(?:\.[a-z0-9-]+)+\.(?:com|net))["']/g)].map((m) => m[1]).sort();
}

test("宛先の許可リストが、ブラウザ(favorites.js)とサーバー(push-endpoint.ts)で同じ", () => {
  const fav = read("favorites.js");
  const block = fav.slice(fav.indexOf("var PUSH_HOSTS"), fav.indexOf("function pushEndpointAllowed"));
  const server = read("supabase/functions/_shared/push-endpoint.ts");
  const sblock = server.slice(server.indexOf("const HOSTS"), server.indexOf("export function isAllowedPushEndpoint"));
  assert.ok(hostsIn(block).length >= 4, "favorites.js の表が読めない");
  assert.deepStrictEqual(hostsIn(block), hostsIn(sblock));
});

test("購読を保存する前に、許可リストで確かめている", () => {
  const fav = read("favorites.js");
  const check = fav.indexOf("pushEndpointAllowed(json.endpoint)");
  const upsert = fav.indexOf("supaClient.from(SUBS_TABLE).upsert");
  assert.ok(check > 0 && check < upsert, "保存(upsert)より前に確かめていない");
});

test("マイページの条件の一覧は、壊れた形の条件でも止まらない", () => {
  const ctx = { console };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(read("rule-match.js"), ctx);
  vm.runInContext(read("alerts.js"), ctx);
  const A = ctx.TeiyomiAlerts;
  // vm の中で作った配列は別の Array なので、JSON を通してから比べる
  const labels = (cond) => JSON.parse(JSON.stringify(A.condLabels(cond)));
  for (const cond of [{ mats: [null] }, { mats: 1 }, { venues: { length: 1 } }, "abc",
    { mats: [{ lane: 1, mat: "constructor", bands: ["x"] }] }]) {
    assert.deepStrictEqual(labels(cond), ["条件の形が読めません（この条件は通知に使われません）"], JSON.stringify(cond));
  }
  // 今までどおりの形は今までどおり
  assert.deepStrictEqual(labels({ venues: ["桐生"], mats: [{ lane: 1, mat: "mo", bands: ["45-", "40-45"] }] }),
    ["会場：桐生", "1号艇のモーター2連率：40%以上"]);
  assert.strictEqual(A.condSummary(null), "すべてのレース");
});
