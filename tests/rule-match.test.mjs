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

// ---- マイページ「今日の番組表で該当するレース」(AI-12 2便) ----

function loadNotes() {
  const window = {};
  vm.runInNewContext(readFileSync(join(ROOT, "notes.js"), "utf8"), { window });
  return window.TeiyomiNotes;
}

test("数字の1行には必ず「{記録日}時点の検証」を刷る", () => {
  const N = loadNotes();
  const line = N.verifiedLine({ runAt: "2026-09-01T21:00:00+09:00", returnRate: 1.042, hitRate: 0.301, races: 4210 },
    "2026-08-20T10:00:00+09:00");
  assert.match(line, /^回収率 104\.2%・的中率 30\.1%・4,210レース（2026\/09\/01時点の検証）$/);
  // runAt が無ければ記録日(created_at)
  assert.match(N.verifiedLine({ returnRate: 0.5, hitRate: 0.1 }, "2026-08-20T10:00:00+09:00"), /（2026\/08\/20時点の検証）$/);
  // 記録した数字が無いノートには何も添えない(「―%」を並べない)
  assert.strictEqual(N.verifiedLine({}, "2026-08-20"), null);
  assert.strictEqual(N.verifiedLine(null, "2026-08-20"), null);
});

test("その場に置く壁は gateHtml と同じ中身で、閉じるボタンを持たない", () => {
  const head = { appendChild() {} };
  const document = { getElementById: () => null, createElement: () => ({}), head };
  // alerts.js は TeiyomiTWA をグローバルとして読むので、window をそのコンテキスト自身にする
  const window = vm.createContext({ document });
  window.window = window;
  vm.runInContext(readFileSync(join(ROOT, "alerts.js"), "utf8"), window);
  const html = window.TeiyomiAlerts.inlineGateHtml("見出し", "本文");
  assert.ok(html.includes('class="bell-cta" href="/premium/"'));
  assert.ok(!html.includes("bell-close"));
  // TWA(Androidアプリ)では購入を促す文言を出さない決まりも、そのまま効く
  window.TeiyomiTWA = { isTWA: () => true, gateText: () => "［アプリ用の文言］" };
  assert.ok(window.TeiyomiAlerts.inlineGateHtml("見出し", "本文").includes("［アプリ用の文言］"));
});

test("マイページは rule-match.js を読み、照合を自分で書いていない", () => {
  const my = readFileSync(join(ROOT, "mypage.html"), "utf8");
  assert.ok(my.includes('<script src="rule-match.js"></script>'));
  assert.ok(my.includes("TeiyomiRuleMatch.ruleFromNote") || my.includes("RM.ruleFromNote"));
  assert.ok(!/function matchesCond|c\.kinds\.indexOf|OPTS\s*=\s*\{/.test(my), "照合や選択肢の表を持ち直している");
  // 券種・買い目は照らさない・出さない
  assert.ok(!/cond\.bet|boxBoats|singleBoats|axisBoat/.test(my.slice(my.indexOf("renderRuleMatchBox"), my.indexOf("// ===== 検証ノート(5b"))));
});
