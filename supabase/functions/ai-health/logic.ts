// ai-health の中身(DBに触らない部分)。テストは logic_test.ts。

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const JST_MS = 9 * 60 * 60 * 1000;

/** 指定が無ければ「JSTの前日」。形の崩れた指定は null(400にする)。 */
export function targetDate(raw: string | null, now: Date = new Date()): string | null {
  if (raw == null || raw === "") {
    return new Date(now.getTime() + JST_MS - DAY_MS).toISOString().slice(0, 10);
  }
  return DATE_RE.test(raw) ? raw : null;
}

export type Summary = {
  date: string;
  ok: number;
  fail: number;
  total: number;
  by: Record<string, number>;
};

/** 種類ごとの行を、成功・失敗・合計にまとめる。ok 以外はすべて失敗。 */
export function summarize(
  date: string,
  rows: { outcome: string; count: number }[],
): Summary {
  const by: Record<string, number> = {};
  let ok = 0;
  let fail = 0;
  for (const r of rows) {
    const n = Number.isInteger(r.count) && r.count > 0 ? r.count : 0;
    by[r.outcome] = n;
    if (r.outcome === "ok") ok += n;
    else fail += n;
  }
  return { date, ok, fail, total: ok + fail, by };
}
