import { assertEquals } from "jsr:@std/assert@1";
import { summarize, targetDate } from "./logic.ts";

Deno.test("targetDate: 指定なしはJSTの前日(UTCの日付境界をまたいでも)", () => {
  // JST 2026-09-18 01:00 = UTC 2026-09-17 16:00 → 前日は 09-17
  assertEquals(targetDate(null, new Date("2026-09-17T16:00:00Z")), "2026-09-17");
  // JST 2026-09-18 08:59 = UTC 2026-09-17 23:59
  assertEquals(targetDate("", new Date("2026-09-17T23:59:00Z")), "2026-09-17");
  // JST 2026-09-18 00:00 ちょうど
  assertEquals(targetDate(null, new Date("2026-09-17T15:00:00Z")), "2026-09-17");
  // JST 2026-09-17 23:59
  assertEquals(targetDate(null, new Date("2026-09-17T14:59:00Z")), "2026-09-16");
});

Deno.test("targetDate: 形の崩れた指定は null", () => {
  assertEquals(targetDate("2026-09-18"), "2026-09-18");
  assertEquals(targetDate("2026-9-18"), null);
  assertEquals(targetDate("2026-09-18' or 1=1"), null);
  assertEquals(targetDate("yesterday"), null);
});

Deno.test("summarize: ok 以外はすべて失敗", () => {
  assertEquals(
    summarize("2026-09-17", [
      { outcome: "ok", count: 3 },
      { outcome: "timeout", count: 5 },
      { outcome: "banned", count: 1 },
    ]),
    {
      date: "2026-09-17",
      ok: 3,
      fail: 6,
      total: 9,
      by: { ok: 3, timeout: 5, banned: 1 },
      efforts: { default: 9 },
    },
  );
  assertEquals(summarize("2026-09-17", []), {
    date: "2026-09-17",
    ok: 0,
    fail: 0,
    total: 0,
    by: {},
    efforts: {},
  });
});

Deno.test("summarize: 推論量ごとの行は種類ごとに足し、推論量ごとの件数も返す(2026-09-18)", () => {
  assertEquals(
    summarize("2026-09-19", [
      { outcome: "ok", count: 4, effort: "low" },
      { outcome: "ok", count: 1, effort: "default" },
      { outcome: "timeout", count: 2, effort: "low" },
    ]),
    {
      date: "2026-09-19",
      ok: 5,
      fail: 2,
      total: 7,
      by: { ok: 5, timeout: 2 },
      efforts: { low: 6, default: 1 },
    },
  );
});
