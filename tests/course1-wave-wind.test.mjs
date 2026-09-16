// レースページ「波と風で、1コースの1着率はこう変わる」(AI-13・AI-13c)のテスト。
//   node --test tests/*.test.mjs
//
// 守りたいのは3つ。
//   1. 波高の %(実際の1着率)と同じ測定で出した lift が、読み採点(yomi.js の YOMI_TABLE.D の
//      1号艇)の pt と ±0.1 で一致する。答案の内訳・AI講評と、別の測定の数字を載せない
//      (「帯の % − 全国平均」は会場の偏りが入るので D 表の pt と合わない。
//       scripts/measure_wind_course.py の docstring 参照)
//   2. 版の表記・期間の表記も答案と同じ
//   3. いちばん新しい日のレースページ全部に表が出ていて、予想・推奨に読める語と「pt」を使っていない
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

// D 表の "−5.0pt" を数にする(マイナスは全角の − で書いてある)
const ptNum = (s) => Number(s.replace("−", "-").replace(/pt$/, ""));

test("波高の %と同じ測定の lift が、読み採点 D 表の1号艇と ±0.1 で一致(帯も同じ)", () => {
  const Y = loadYomi();
  const D = Y.YOMI_TABLE.D;
  assert.strictEqual(T.wave.length, D.waveBands.length);
  T.wave.forEach((x, i) => {
    const d = ptNum(D.lane[1][i][1]);
    assert.ok(Number.isFinite(d), `D 表 ${x.band} を数にできない`);
    assert.ok(Math.abs(x.lift - d) <= 0.1 + 1e-9, `${x.band} の lift ${x.lift} が答案の ${d} と0.1より離れている`);
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

test("数字は測定値の形(1着率は小数1桁の%・母数あり)", () => {
  assert.deepStrictEqual(T.wind.map((x) => x.band), ["〜2m", "3〜4m", "5m以上"]);
  for (const x of [T.base, ...T.wave, ...T.wind]) {
    const label = x.band || "全国平均";
    assert.ok(x.rate > 0 && x.rate < 100 && Math.round(x.rate * 10) === x.rate * 10, `${label} の1着率`);
    assert.ok(Number.isInteger(x.n) && x.n > 10000, `${label} の母数`);
  }
  for (const x of [...T.wave, ...T.wind]) {
    assert.ok(typeof x.lift === "number", `${x.band} の lift`);
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
      const i = html.indexOf("波と風で、1コースの1着率はこう変わる");
      assert.ok(i > 0, `${venue}/${f} に表が無い`);
      const block = html.slice(i, html.indexOf("公式の直前情報でご確認ください", i));
      assert.ok(block.includes(`全国の1コース平均 <b class="nums">${T.base.rate.toFixed(1)}%</b>（10年）`), `${venue}/${f} 基準行`);
      for (const x of [...T.wave, ...T.wind]) {
        assert.ok(block.includes(`${x.band}</div><div class="cwrate nums">${x.rate.toFixed(1)}%`), `${venue}/${f} ${x.band}`);
      }
      for (const w of ["狙い目", "堅い", "荒れ", "買い", "有利", "おすすめ", "1号艇"]) {
        assert.ok(!block.includes(w), `${venue}/${f} に「${w}」`);
      }
      assert.ok(!PT.test(block), `${venue}/${f} の波と風の表に「pt」`);
      pages++;
    }
  }
  assert.ok(pages > 0);
});

// ---- 天候欄・決まり手欄・コース別欄・波と風の表に、推奨に読める語と「pt」を戻さない ----
// (AI-13 追補・AI-13c)
//
// 説明文(hint)は、条件の分岐ごとに別の文になる。今日のページに出ていない分岐の文も
// 見たいので、生成するコード(build_race_pages.py とトップの index.html)の該当関数を丸ごと調べる。
// 用語の説明(class="term" の title)は語の定義なのでここでは対象にしない。コメントも外す。
// 答案(読み採点の内訳)とAI講評は v2 で扱うので、ここでは見ない。
const BANNED = ["狙い", "堅い", "荒れ", "崩れ", "買い", "有利", "おすすめ", "信頼", "波乱", "人の逆"];
// 「pt」は単位としての pt だけを見る(except・script のような英単語の一部は数えない)
const PT = /(?<![A-Za-z])pt(?![A-Za-z])/;

function sliceFrom(src, start, nextMarker) {
  const i = src.indexOf(start);
  assert.ok(i >= 0, `${start} が見つからない`);
  const j = src.indexOf(nextMarker, i + start.length);
  return src.slice(i, j < 0 ? undefined : j);
}

function assertNoBanned(label, body) {
  const text = body.replace(/title="[^"]*"/g, "");
  for (const w of BANNED) {
    assert.ok(!text.includes(w), `${label} に「${w}」`);
  }
  assert.ok(!PT.test(text), `${label} に「pt」`);
}

test("レースページ側(build_race_pages.py)の3欄と波と風の表の文言に推奨語と「pt」が無い", () => {
  const py = readFileSync(join(ROOT, "build_race_pages.py"), "utf8");
  for (const fn of ["weather_block", "course1_wave_wind_block", "kimarite_block_venue", "trend_panel"]) {
    const body = sliceFrom(py, `def ${fn}(`, "\ndef ")
      .split("\n").map((l) => l.replace(/^\s*#.*$/, "")).join("\n");
    assertNoBanned(`build_race_pages.py ${fn}`, body);
  }
});

test("トップ側(index.html)の3欄の文言に推奨語と「pt」が無い", () => {
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  for (const fn of ["weatherBlock", "kimariteBlock", "trendPanel"]) {
    const body = sliceFrom(html, `function ${fn}(`, "\nfunction ")
      .split("\n").map((l) => l.replace(/^\s*\/\/.*$/, "")).join("\n");
    assertNoBanned(`index.html ${fn}`, body);
  }
});

test("いちばん新しい日のレースページで、3欄の説明文と波と風の注が確定稿どおり(推奨語・pt 無し)", () => {
  const dir = join(ROOT, "race");
  if (!existsSync(dir)) return;
  const days = readdirSync(dir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  if (!days.length) return;
  const day = join(dir, days[days.length - 1]);
  const NOTE = "波高は読み採点(v1.1 2026-09)と同じ集計（334万走）、風は同じ手法で測ったもの（331万走）。";
  for (const venue of readdirSync(day)) {
    for (const f of readdirSync(join(day, venue)).filter((x) => /^\d+R\.html$/.test(x))) {
      const html = readFileSync(join(day, venue, f), "utf8");
      assert.ok(html.includes(NOTE), `${venue}/${f} の注1`);
      const hints = [...html.matchAll(/<div class="(?:thint|whint)">([\s\S]*?)<\/div>/g)].map((m) => m[1]);
      assert.ok(hints.length >= 1, `${venue}/${f} に説明文が無い`);
      hints.forEach((h) => assertNoBanned(`${venue}/${f}`, h));
    }
  }
});
