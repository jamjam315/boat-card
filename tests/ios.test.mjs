// ios.js の単体テスト(WP-5)。
//   node --test tests/*.test.mjs
//
// 守りたいのは2つ。
//   1. アプリの中では、出典リンク(www.boatrace.jp)を同じ文字の <span> にする
//      (殻の許可リストから外したので、リンクのままだと押しても何も起きない)
//   2. ブラウザ・Androidでは1つも触らない
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "ios.js"), "utf8");

/** ios.js が使うぶんだけの小さなDOM。 */
function makeDom(links) {
  const replaced = [];
  const parent = {
    replaceChild(neu, old) { replaced.push({ from: old, to: neu }); old.parentNode = null; },
  };
  const anchors = links.map(([href, text]) => ({
    tagName: "A", nodeType: 1, textContent: text, parentNode: parent,
    getAttribute: (k) => (k === "href" ? href : null),
  }));
  const document = {
    documentElement: { setAttribute() {} },
    head: { appendChild() {} },
    querySelectorAll: () => anchors.filter((a) => a.parentNode),
    createElement: (tag) => ({ tagName: tag.toUpperCase(), textContent: "" }),
    addEventListener() {},
  };
  return { document, anchors, replaced };
}

function boot({ ua, links }) {
  const dom = makeDom(links);
  const win = {
    navigator: { userAgent: ua },
    document: dom.document,
    URL,
    MutationObserver: class { observe() {} },
  };
  win.window = win;
  vm.runInContext(SRC, vm.createContext(win));
  return { win, ...dom };
}

const APP_UA = "Mozilla/5.0 (iPhone) TeiyomiIOS/1";
const WEB_UA = "Mozilla/5.0 (iPhone) Safari";

test("アプリの中では、出典リンクを同じ文字の span にする", () => {
  const { replaced } = boot({
    ua: APP_UA,
    links: [["https://www.boatrace.jp/", "BOAT RACE公式サイト"], ["https://boatrace.jp/owpc/", "公式サイト"]],
  });
  assert.equal(replaced.length, 2);
  assert.equal(replaced[0].to.tagName, "SPAN");
  assert.equal(replaced[0].to.textContent, "BOAT RACE公式サイト", "出典の表記は残す");
  assert.equal(replaced[1].to.textContent, "公式サイト");
});

test("出典以外のリンクには触らない", () => {
  const { replaced } = boot({
    ua: APP_UA,
    links: [
      ["https://www.caa.go.jp/policies/policy/consumer_policy/caution/caution_012/", "消費者庁の案内ページ"],
      ["/privacy.html", "プライバシーポリシー"],
      ["mailto:mtpworks.info@gmail.com", "mtpworks.info@gmail.com"],
      ["https://www.boatrace.jp.example.com/", "似せたホスト"],
      ["https://example.com/?u=https://www.boatrace.jp/", "クエリに含むだけ"],
    ],
  });
  assert.equal(replaced.length, 0);
});

test("ブラウザ・Androidでは1つも触らない", () => {
  const { replaced, win } = boot({ ua: WEB_UA, links: [["https://www.boatrace.jp/", "BOAT RACE公式サイト"]] });
  assert.equal(replaced.length, 0);
  assert.equal(win.TeiyomiIOS.isIOSApp(), false);
});

test("あとから差し込まれた部分にも使える(置き換えた数を返す)", () => {
  const { win } = boot({ ua: WEB_UA, links: [] });
  const later = makeDom([["https://www.boatrace.jp/", "公式サイト"]]);
  // ブラウザで読み込んだ ios.js の関数を、アプリの中の差し込み分に見立てて呼ぶ。
  win.document.createElement = later.document.createElement;
  assert.equal(win.TeiyomiIOS._unlinkSources(later.document), 1);
  assert.equal(later.replaced[0].to.textContent, "公式サイト");
});
