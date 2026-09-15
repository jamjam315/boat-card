// index.html の「描画より前の判定」(TeiyomiEarly)のテスト。
//   node --test tests/*.test.mjs
//
// 開発中のお知らせ と「ホーム画面へ追加」ボタンは、本文末尾の ios.js / favorites.js を
// 待つと一覧の上に後から差し込まれて画面が押し下がる。そこで index.html の head で
// 同じ判定を先にしている。判定が2か所にあるので、ずれたら落ちるようにする。
//
// 守りたいのは2つ。
//   1. 条件の文字列が ios.js / favorites.js と一致している(片方だけ直すと食い違う)
//   2. iOSアプリの中では、お知らせもボタンも出さない(App Store 2.2 / 3.1.1)
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INDEX = readFileSync(join(ROOT, "index.html"), "utf8");
const IOS = readFileSync(join(ROOT, "ios.js"), "utf8");
const FAV = readFileSync(join(ROOT, "favorites.js"), "utf8");

/** head にある TeiyomiEarly のスクリプトだけを取り出す。 */
function earlySource() {
  const m = INDEX.match(/<script>\s*(\/\/[^\n]*描画より前に決めたい表示[\s\S]*?)<\/script>/);
  assert.ok(m, "index.html に TeiyomiEarly のスクリプトが見つかりません");
  return m[1];
}

function runEarly({ ua, width, standaloneMedia = false, iosStandalone = false }) {
  const window = {
    innerWidth: width,
    matchMedia: (q) => ({ matches: q === "(display-mode: standalone)" && standaloneMedia }),
    navigator: { userAgent: ua, standalone: iosStandalone },
  };
  const ctx = { window, navigator: window.navigator };
  vm.createContext(ctx);
  vm.runInContext(earlySource(), ctx);
  return window.TeiyomiEarly;
}

const UA = {
  iosApp: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 TeiyomiIOS/1",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  android: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36",
  desktop: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
};

test("iOSアプリの印が ios.js と一字一句同じ", () => {
  const early = earlySource().match(/IOS_APP_MARKER = "([^"]+)"/);
  const ios = IOS.match(/UA_MARKER = "([^"]+)"/);
  assert.ok(early && ios);
  assert.strictEqual(early[1], ios[1]);
});

test("モバイル・スタンドアロンの条件が favorites.js と同じ", () => {
  const src = earlySource();
  for (const needle of ["/iPhone|iPad|iPod/", "!window.MSStream", "/Android/",
                        '"(display-mode: standalone)"', "window.navigator.standalone === true",
                        "window.innerWidth <= 768"]) {
    assert.ok(src.includes(needle), `index.html に ${needle} がありません`);
    assert.ok(FAV.includes(needle), `favorites.js に ${needle} がありません`);
  }
});

test("iOSアプリの中では、お知らせもボタンも出さない", () => {
  const e = runEarly({ ua: UA.iosApp, width: 390 });
  assert.strictEqual(e.isIOSApp(), true);
  assert.strictEqual(e.canShowAddToHome(), false);
});

test("ホーム画面へ追加は、スマホのブラウザだけで出す", () => {
  const cases = [
    [{ ua: UA.android, width: 390 }, true, "Androidのブラウザ"],
    [{ ua: UA.iphone, width: 390 }, true, "iPhoneのSafari"],
    [{ ua: UA.android, width: 390, standaloneMedia: true }, false, "Android(TWA・スタンドアロン)"],
    [{ ua: UA.iphone, width: 390, iosStandalone: true }, false, "iPhoneのホーム画面から起動"],
    [{ ua: UA.desktop, width: 1280 }, false, "PC"],
    [{ ua: UA.android, width: 1024 }, false, "Androidでも幅が広い(タブレット)"],
  ];
  for (const [env, want, label] of cases) {
    assert.strictEqual(runEarly(env).canShowAddToHome(), want, label);
  }
});

test("開発中のお知らせの記録キーは1か所だけ", () => {
  const n = (INDEX.match(/teiyomi_devnotice_dismissed_v1/g) || []).length;
  assert.strictEqual(n, 1);
});
