// rule-match.js(保存した絞り込みを今日の番組表と照らす関数)まわりのテスト。
//   node --test tests/*.test.mjs
//
// 照合そのものの中身と、朝の通知(TS版)との一致は
// supabase/functions/_shared/rule_match_parity_test.ts で見ている。ここで見るのは、
// 5b(backtest-custom.html)が選択肢の表や条件の直し方を自分で持ち直していないこと。
// 持ち直すと、マイページの表示と5bの保存で条件の形がずれる。
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(ROOT, "backtest-custom.html"), "utf8");

test("5bは rule-match.js を、それを使うスクリプトより前に読む", () => {
  const tag = html.indexOf('<script src="rule-match.js"></script>');
  assert.ok(tag > 0, "rule-match.js を読んでいない");
  const use = html.indexOf("TeiyomiRuleMatch.OPTS");
  assert.ok(use > tag, "読む前に使っている");
});

test("5bに選択肢の表・optByKey・条件の直し方が残っていない", () => {
  assert.ok(!/var MONTH_OPTS = \[/.test(html), "選択肢の表が残っている");
  assert.ok(!/function optByKey\(/.test(html), "optByKey が残っている");
  assert.ok(!/cond\.kinds = /.test(html), "条件の直し方が残っている");
});

test("ブラウザでは window に生える", () => {
  const window = {};
  vm.runInNewContext(readFileSync(join(ROOT, "rule-match.js"), "utf8"), { window, Set });
  for (const k of ["OPTS", "optByKey", "condFromFilter", "unusableLabels", "matchesCond",
                   "ruleFromNote", "nightVenuesFrom", "parseDataDate", "matchRaces"]) {
    assert.ok(window.TeiyomiRuleMatch[k], k);
  }
});
