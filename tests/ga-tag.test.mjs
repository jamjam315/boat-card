// Google アナリティクス 4 の計測タグ(ga_tag.py・2026-11-22)が、公開している全 HTML に1つずつ入っていること。
//   node --test tests/*.test.mjs
// 自動生成(レース・選手・検証済みのページ)は書き出す直前に ga_tag.add_ga を通している。
// 手書きのページを足したときに入れ忘れると、ここで落ちる(python ga_tag.py で入れられる)。
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GA_ID = "G-M31X1QLSLM";
const TAG = `<script async src="https://www.googletagmanager.com/gtag/js?id=${GA_ID}"></script>`;

const files = execFileSync("git", ["ls-files", "*.html"], { cwd: ROOT, encoding: "utf8" })
  .split("\n").filter((p) => p && !p.startsWith("docs/"));   // docs/ はメールの雛形(ウェブページではない)

function csp(html) {
  const m = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i.exec(html);
  if (!m) return null;
  return Object.fromEntries(m[1].split(";").map((s) => s.trim()).filter(Boolean)
    .map((s) => { const t = s.split(/\s+/); return [t[0], t.slice(1)]; }));
}

test("公開している全 HTML に、GA4 のタグがちょうど1つずつ <head> の中にある", () => {
  assert.ok(files.length > 2000, `HTML が少なすぎる(${files.length})`);
  const bad = [];
  for (const p of files) {
    const html = readFileSync(join(ROOT, p), "utf8");
    const n = html.split(TAG).length - 1;
    const head = html.indexOf("</head>");
    if (n !== 1 || html.indexOf(TAG) > head) bad.push(`${p}(${n}個)`);
  }
  assert.deepStrictEqual(bad.slice(0, 10), [], `タグが無い・二重・<head> の外: ${bad.length}ページ`);
});

test("CSP がタグを止めない(読み込み元・送信先・直書きのコードのハッシュ値)", () => {
  const bad = [];
  for (const p of files) {
    const html = readFileSync(join(ROOT, p), "utf8").replace(/\r\n/g, "\n");   // 本番は LF で配る
    const c = csp(html);
    if (!c) continue;
    const script = c["script-src"] || [];
    const connect = c["connect-src"] || [];
    const img = c["img-src"] || [];
    const ok = script.includes("https://www.googletagmanager.com")
      && connect.includes("https://*.google-analytics.com") && connect.includes("https://*.google.com")
      && img.includes("https://*.google-analytics.com");
    // 'unsafe-inline' の無いページは、タグの直書きの部分をハッシュ値で許可していること
    let hashOk = true;
    if (!script.includes("'unsafe-inline'")) {
      const start = html.indexOf("<script>", html.indexOf(TAG)) + "<script>".length;
      const inline = html.slice(start, html.indexOf("</script>", start));
      const hash = `'sha256-${createHash("sha256").update(inline, "utf8").digest("base64")}'`;
      hashOk = script.includes(hash);
    }
    if (!ok || !hashOk) bad.push(p);
  }
  assert.deepStrictEqual(bad.slice(0, 10), [], `CSP がタグを止める: ${bad.length}ページ`);
});

test("自動生成のスクリプトは、書き出す前に ga_tag.add_ga を通している", () => {
  for (const [file, n] of [["build_race_pages.py", 1], ["build_all_player_pages.py", 2], ["build_checked.py", 2]]) {
    const src = readFileSync(join(ROOT, file), "utf8");
    assert.strictEqual(src.split("ga_tag.add_ga(").length - 1, n, file);
  }
});
