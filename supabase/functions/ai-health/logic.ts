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
  /** 推論量ごとの件数(2026-09-18 から)。切り替えの前後を見分ける */
  efforts: Record<string, number>;
};

/**
 * 種類(×推論量)ごとの行を、成功・失敗・合計にまとめる。ok 以外はすべて失敗。
 * 同じ種類が推論量ごとに複数行あるので、種類ごとに足し合わせる。
 */
export function summarize(
  date: string,
  rows: { outcome: string; count: number; effort?: string | null }[],
): Summary {
  const by: Record<string, number> = Object.create(null);
  const efforts: Record<string, number> = Object.create(null);
  let ok = 0;
  let fail = 0;
  for (const r of rows) {
    const n = Number.isInteger(r.count) && r.count > 0 ? r.count : 0;
    by[r.outcome] = (by[r.outcome] ?? 0) + n;
    const e = r.effort || "default";
    efforts[e] = (efforts[e] ?? 0) + n;
    if (r.outcome === "ok") ok += n;
    else fail += n;
  }
  return { date, ok, fail, total: ok + fail, by: { ...by }, efforts: { ...efforts } };
}
