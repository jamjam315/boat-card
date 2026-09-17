// app-links.js の単体テスト(2026-09-17・App Store 公開)。
//   node --test tests/*.test.mjs
//
// 守りたいのは3つ。
//   1. ブラウザでは App Store と Google Play の両方が出る
//   2. **iOSアプリの中では何も出さない**（3.1.1。外の購入経路への誘導になる）
//   3. **Androidアプリ(TWA)の中でも何も出さない**
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = readFileSync(join(ROOT, "app-links.js"), "utf8");

/** app-links.js が使うぶんだけの小さなDOM。 */
function boot({ ua = "Mozilla/5.0", referrer = "", search = "", store = new Map() } = {}) {
  const box = { textContent: "", hidden: true, children: [], appendChild(n) { this.children.push(n); } };
  const win = {
    navigator: { userAgent: ua },
    location: { search },
    sessionStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) },
    document: {
      readyState: "complete",
      referrer,
      querySelectorAll: (sel) => (sel === "[data-app-links]" ? [box] : []),
      createElement: () => ({ textContent: "", href: "", target: "", rel: "" }),
      createTextNode: (t) => ({ text: t }),
      addEventListener() {},
    },
  };
  win.window = win;
  vm.runInNewContext(SRC, win);
  const text = box.children.map((c) => c.text ?? c.textContent).join("");
  const hrefs = box.children.filter((c) => c.href).map((c) => c.href);
  return { box, text, hrefs, api: win.TeiyomiAppLinks };
}

test("ブラウザでは、App Store と Google Play の両方のリンクを出す", () => {
  const { box, text, hrefs } = boot();
  assert.equal(box.hidden, false);
  assert.match(text, /App Store（iPhone）/);
  assert.match(text, /Google Play（Android）/);
  assert.deepEqual(hrefs, [
    "https://apps.apple.com/jp/app/id6810243272",
    "https://play.google.com/store/apps/details?id=com.mtpworks.teiyomi",
  ]);
});

test("iOSアプリの中では何も出さない(枠は hidden のまま)", () => {
  const { box, text } = boot({ ua: "Mozilla/5.0 (iPhone) TeiyomiIOS/1" });
  assert.equal(box.hidden, true);
  assert.equal(text, "");
});

test("Androidアプリ(TWA)の中では何も出さない", () => {
  for (const opts of [
    { referrer: "android-app://com.mtpworks.teiyomi" },
    { search: "?twa=1" },
    { store: new Map([["teiyomi_twa", "1"]]) },
  ]) {
    const { box, text } = boot(opts);
    assert.equal(box.hidden, true, JSON.stringify(opts));
    assert.equal(text, "");
  }
});

test("判定の文字列は ios.js / twa.js と同じ", () => {
  const ios = readFileSync(join(ROOT, "ios.js"), "utf8");
  const twa = readFileSync(join(ROOT, "twa.js"), "utf8");
  assert.ok(ios.includes('var UA_MARKER = "TeiyomiIOS/1"'));
  assert.ok(SRC.includes('var IOS_APP_MARKER = "TeiyomiIOS/1"'));
  assert.ok(twa.includes('var PACKAGE = "com.mtpworks.teiyomi"'));
  assert.ok(SRC.includes('var TWA_PACKAGE = "com.mtpworks.teiyomi"'));
  assert.ok(twa.includes('var KEY = "teiyomi_twa"'));
  assert.ok(SRC.includes('var TWA_KEY = "teiyomi_twa"'));
});
