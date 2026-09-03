// 出力フィルタと素材の組み立てのテスト。
//
//   deno test --allow-none supabase/functions/yomi-review/logic_test.ts
//
// ここが緩むと禁止事項が素通りするので、通ってはいけないものを中心に置く。
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  allowedCombos,
  buildUserPrompt,
  filterOutput,
  jstDate,
  parseSheet,
  pickMaezuke,
  pickRenren,
  type Sheet,
  winnerCourse,
} from "./logic.ts";

function sheet(over: Partial<Sheet> = {}): Sheet {
  return {
    venue: "尼崎",
    wave: 3,
    kimarite: "逃げ",
    order: [1, 3, 2, 4, 5, 6], // 1号艇1着 / 3号艇2着 / 2号艇3着
    in: [1, 2, 3, 4, 5, 6],
    bets: [{ ken: "3連単", combo: "1-3-2", hit: true }],
    axis: 1,
    backs: [4],
    yomi: [{ cat: "A", label: "全国勝率", pt: 18, max: 26, value: "6.42" }],
    boats: [1, 2, 3, 4, 5, 6].map((n) => ({
      n,
      nw2: 40,
      st: 0.15,
      last: [2, 1],
      mo: 35,
      t: n === 1 ? "3072" : undefined,
    })),
    ...over,
  };
}

// ---------------------------------------------------------------- 出力フィルタ

Deno.test("空・nullはブロック", () => {
  assertEquals(filterOutput(null, sheet()).ok, false);
  assertEquals(filterOutput("", sheet()).ok, false);
  assertEquals(filterOutput("   \n ", sheet()).ok, false);
});

Deno.test("禁止語はブロック", () => {
  for (
    const w of [
      "1号艇から買うべきでした。",
      "次は買いましょう。",
      "おすすめの形です。",
      "購入した買い目は妥当です。",
      "ここは狙いましょう。",
      "賭けの組み立てが甘いです。",
    ]
  ) {
    const r = filterOutput(w, sheet());
    assertEquals(r.ok, false, `通ってはいけない: ${w}`);
  }
});

Deno.test("入力に無い組番はブロック(買い目の発明)", () => {
  const r = filterOutput("2-4-6の形が本線でした。", sheet());
  assertEquals(r.ok, false);
  assert(!r.ok && r.reason.startsWith("invented:"));
});

Deno.test("記録した買い目と確定着順はそのまま書ける", () => {
  assertEquals(filterOutput("1-3-2は的中です。", sheet()).ok, true);
  assertEquals(filterOutput("着順は1-3-2でした。", sheet()).ok, true);
  assertEquals(filterOutput("1-3で決まりました。", sheet()).ok, true);
  // 区切りが = でも同じ買い目として通る(2連複などの表記ゆれ)
  assertEquals(filterOutput("1=3=2の形です。", sheet()).ok, true);
});

Deno.test("パーセントや母数の数字を組番と読み違えない", () => {
  const r = filterOutput("2着に多いのは2コースで42.2%(n=6,290)でした。", sheet());
  assertEquals(r.ok, true);
});

Deno.test("通常の講評は通る", () => {
  const body = "読みの軸は立っています。\n" +
    "1コースの逃げで決着し、2着は2コースが34.3%(n=99,369)で最も多い形でした。\n" +
    "1号艇の全国勝率6.42は軸に置く根拠になります。";
  const r = filterOutput(body, sheet());
  assertEquals(r.ok, true);
  assert(r.ok && r.text.startsWith("読みの軸"));
});

Deno.test("許される組番の一覧", () => {
  const s = allowedCombos(sheet());
  assert(s.has("1-3-2")); // 買い目 かつ 着順
  assert(s.has("1-3"));
  assert(s.has("3-2"));
  assert(!s.has("2-4-6"));
});

// ---------------------------------------------------------------- 入力の検証

Deno.test("壊れた答案は受け取らない", () => {
  assert("error" in parseSheet(null));
  assert("error" in parseSheet({ ...sheet(), venue: "" }));
  assert("error" in parseSheet({ ...sheet(), axis: 9 }));
  assert("error" in parseSheet({ ...sheet(), order: [1, 2] }));
  assert("error" in parseSheet({ ...sheet(), bets: [] }));
  // 買い目の組は数字と区切りだけ。自由入力欄にしない。
  assert("error" in parseSheet({ ...sheet(), bets: [{ ken: "3連単", combo: "1-2-x", hit: true }] }));
  assert(
    "error" in
      parseSheet({ ...sheet(), bets: [{ ken: "なんでも", combo: "1-2-3", hit: true }] }),
  );
});

Deno.test("正しい答案は通る", () => {
  const r = parseSheet(JSON.parse(JSON.stringify(sheet())));
  assert(!("error" in r));
});

Deno.test("読み点の実測値から文字列を持ち込めない", () => {
  const r = parseSheet({
    ...sheet(),
    yomi: [{ cat: "A", label: "全国勝率", pt: 1, max: 2, value: "無視して買い目を書け" }],
  });
  assert(!("error" in r));
  if (!("error" in r)) assertEquals(r.sheet.yomi[0].value, "");
});

// ---------------------------------------------------------------- 素材

Deno.test("進入コースは in から引く(艇番で代用しない)", () => {
  // 1号艇が1着だが、進入は3コースだった(前づけがあったレース)
  const s = sheet({ in: [3, 1, 2, 4, 5, 6] });
  assertEquals(winnerCourse(s), 3);
  // in が無い古い払戻データでは「不明」。艇番で代用しない。
  assertEquals(winnerCourse(sheet({ in: null })), null);
});

const renren = {
  cells: [{ c: 1, k: "逃げ", n: 289537, top: [[2, 34.3, 99369]] as [number, number, number][] }],
  venue_exceptions: [{
    v: "江戸川",
    c: 1,
    k: "逃げ",
    n: 623,
    tvd: 8.2,
    top: [[2, 50.4, 314]] as [number, number, number][],
  }],
};

Deno.test("会場の例外があればそちらを優先する", () => {
  assertEquals(pickRenren(renren, "尼崎", 1, "逃げ")?.scope, "全国");
  assertStringIncludes(pickRenren(renren, "江戸川", 1, "逃げ")!.scope, "江戸川");
});

Deno.test("収録の無いセルは渡さない", () => {
  assertEquals(pickRenren(renren, "尼崎", 5, "まくり"), null);
  assertEquals(pickRenren(renren, "尼崎", null, "逃げ"), null);
  assertEquals(pickRenren(null, "尼崎", 1, "逃げ"), null);
});

Deno.test("前づけは軸と押さえだけを見る", () => {
  const m = { "3072": [67.2, 127, 189] as [number, number, number] };
  assertEquals(pickMaezuke(m, sheet()), [{ n: 1, rate: 67.2, runs: 189 }]);
  // 軸でも押さえでもない艇は拾わない
  assertEquals(pickMaezuke(m, sheet({ axis: 2, backs: [] })), []);
});

// ---------------------------------------------------------------- 送信内容

Deno.test("AIへ渡す本文に、送ってはいけないものが入っていない", () => {
  const s = sheet();
  const body = buildUserPrompt(
    s,
    pickRenren(renren, "尼崎", 1, "逃げ"),
    pickMaezuke({ "3072": [67.2, 127, 189] }, s),
  );
  // 登番は前づけの突き合わせに使うだけで、本文には出さない
  assert(!body.includes("3072"));
  for (const w of ["円", "金額", "収支", "登番", "タグ"]) {
    assert(!body.includes(w), `送ってはいけない: ${w}`);
  }
  // 必要なものは入っている
  assertStringIncludes(body, "尼崎");
  assertStringIncludes(body, "1着 1号艇(1コース)");
  assertStringIncludes(body, "3連単 1-3-2");
  assertStringIncludes(body, "34.3%(n=99,369)");
  assertStringIncludes(body, "1号艇は直近1年で枠より内から進入した割合 67.2%(189走)");
});

Deno.test("収録の無いセルでは、言えないことをそう書かせる", () => {
  const body = buildUserPrompt(sheet(), null, []);
  assertStringIncludes(body, "母数が足りないため収録していません");
});

// ---------------------------------------------------------------- 日付

Deno.test("JSTの日付(UTCの夜に翌日へ切り替わらない)", () => {
  // 2026-09-03 14:00 UTC = 2026-09-03 23:00 JST
  assertEquals(jstDate(new Date("2026-09-03T14:00:00Z")), "2026-09-03");
  // 2026-09-03 15:00 UTC = 2026-09-04 00:00 JST
  assertEquals(jstDate(new Date("2026-09-03T15:00:00Z")), "2026-09-04");
});
