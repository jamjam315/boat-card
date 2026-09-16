// レースページ「波と風で、1コースの1着率はこう動く」(AI-13)のテスト。
//   node --test tests/*.test.mjs
//
// 守りたいのは3つ。
//   1. 波高の数字が、読み採点(yomi.js の YOMI_TABLE.D の1号艇)と一字一句同じ。
//      答案の内訳とAI講評に出る数字と、レースページの数字を食い違わせない
//   2. 版の表記・期間の表記も答案と同じ
//   3. いちばん新しい日のレースページ全部に表が出ていて、予想・推奨に読める語を使っていない
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const T = JSON.parse(readFileSync(join(ROOT, "course1_wave_wind.json"), "utf8"));

function loadYomi() {
  const win = { localStorage: { getItem: () => null, setItem() {} } };
  vm.runInNewContext(readFileSync(join(ROOT, "yomi.js"), "utf8"), { window: win, localStorage: win.localStorage });
  return win.TeiyomiYomi;
}

test("波高は読み採点 D 表の1号艇と一字一句同じ(帯・pt)", () => {
  const Y = loadYomi();
  const D = Y.YOMI_TABLE.D;
  assert.strictEqual(T.wave.length, D.waveBands.length);
  T.wave.forEach((x, i) => {
    assert.strictEqual(x.lift, D.lane[1][i][1], `${x.band} のptが答案と違う`);
  });
  // 帯の区切りも同じ(表記だけ読みやすくしている: 0-1cm → 0〜1cm、6cm+ → 6cm以上)
  // (vm で読んだ配列は別のコンテキストのものなので、JSON を通して比べる)
  assert.deepStrictEqual(
    T.wave.map((x) => x.band),
    JSON.parse(JSON.stringify(D.waveBands.map((b) => b.replace("-", "〜").replace("6cm+", "6cm以上")))),
  );
});

test("版と期間の表記が答案と同じ", () => {
  const Y = loadYomi();
  assert.strictEqual(T.version, Y.YOMI_VERSION);
  assert.strictEqual(T.period, Y.YOMI_TABLE.D.period);
});

test("風の数字は測定値の形(pt表記・母数あり)", () => {
  assert.deepStrictEqual(T.wind.map((x) => x.band), ["〜2m", "3〜4m", "5m以上"]);
  for (const x of T.wind) {
    assert.match(x.lift, /^[+−]\d+\.\dpt$/, `${x.band} のpt表記`);
    assert.ok(Number.isInteger(x.n) && x.n > 10000, `${x.band} の母数`);
  }
});

test("いちばん新しい日のレースページ全部に表が出ていて、数字がJSONと同じ", () => {
  const dir = join(ROOT, "race");
  if (!existsSync(dir)) return;
  const days = readdirSync(dir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  if (!days.length) return;
  const day = join(dir, days[days.length - 1]);
  let pages = 0;
  for (const venue of readdirSync(day)) {
    for (const f of readdirSync(join(day, venue)).filter((x) => /^\d+R\.html$/.test(x))) {
      const html = readFileSync(join(day, venue, f), "utf8");
      const i = html.indexOf("波と風で、1コースの1着率はこう動く");
      assert.ok(i > 0, `${venue}/${f} に表が無い`);
      const block = html.slice(i, html.indexOf("公式の直前情報でご確認ください", i));
      for (const x of [...T.wave, ...T.wind]) {
        assert.ok(block.includes(`${x.band}</div><div class="cwlift nums">${x.lift}`), `${venue}/${f} ${x.band}`);
      }
      for (const w of ["狙い目", "堅い", "荒れ", "買い", "有利", "おすすめ", "1号艇"]) {
        assert.ok(!block.includes(w), `${venue}/${f} に「${w}」`);
      }
      pages++;
    }
  }
  assert.ok(pages > 0);
});
