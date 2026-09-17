// 匿名ログインが、同時に開いた画面で1回だけになることのテスト（公開後バックログ3）。
//   node --test tests/*.test.mjs
//
// iOSアプリは下タブ4本のWebViewを同時に読み込む。以前は4つとも
// signInAnonymously() を呼んでいて、同じ秒に匿名ユーザーが4人できていた。
// localStorage は4つの画面で共有されるので、そこに印を置いて1つに絞る。
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "favorites.js"), "utf8");

/** 4つの画面（WebView / ブラウザのタブ）で共有されるもの。 */
function makeShared() {
  const store = new Map();
  return {
    calls: { signIn: 0 },
    session: null,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
  };
}

/** 画面1つぶん。favorites.js をそのまま動かす。 */
function openTab(shared, { signInDelayMs = 0 } = {}) {
  const auth = {
    getSession: () => Promise.resolve({ data: { session: shared.session } }),
    signInAnonymously: () => {
      shared.calls.signIn++;
      const id = "anon-" + shared.calls.signIn;
      return new Promise((resolve) => setTimeout(() => {
        shared.session = { user: { id, is_anonymous: true } };
        resolve({ data: { session: shared.session }, error: null });
      }, signInDelayMs));
    },
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  };
  const table = {
    select: () => table,
    eq: () => Promise.resolve({ data: [], error: null }),
  };
  const win = {
    supabase: { createClient: () => ({ auth, from: () => table }) },
    localStorage: shared.localStorage,
    fetch: () => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ url: "https://supa.example", anonKey: "anon" }),
    }),
    document: {
      readyState: "complete",
      head: { appendChild() {} },
      createElement: () => ({}),
      querySelectorAll: () => [],
      querySelector: () => null,
      addEventListener() {},
      documentElement: { setAttribute() {} },
      body: { classList: { add() {}, remove() {} } },
    },
    navigator: { userAgent: "test" },
    location: { pathname: "/", search: "", href: "https://teiyomi.com/" },
    CustomEvent: class { constructor(n) { this.type = n; } },
    dispatchEvent() {},
    addEventListener() {},
    setTimeout, clearTimeout, Promise, JSON, Date, Math, Object, Array, String, Number, isFinite, console,
  };
  win.window = win;
  vm.runInNewContext(SRC, win);
  return win;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("4つの画面を同時に開いても、匿名ログインは1回だけ", async () => {
  const shared = makeShared();
  for (let i = 0; i < 4; i++) openTab(shared, { signInDelayMs: 50 });
  await wait(400);
  assert.equal(shared.calls.signIn, 1);
  assert.ok(shared.session, "セッションはできている");
});

test("既にセッションがあれば、匿名ログインはしない", async () => {
  const shared = makeShared();
  shared.session = { user: { id: "u1", is_anonymous: false } };
  openTab(shared);
  await wait(200);
  assert.equal(shared.calls.signIn, 0);
});

test("印を取った画面が入り損ねても、印は残さない（次の起動で入れる）", async () => {
  const shared = makeShared();
  shared.localStorage.setItem("teiyomi_anon_login", String(Date.now() - 60_000));   // 古い印
  openTab(shared, { signInDelayMs: 10 });
  await wait(200);
  // 古い印は無視して入る。入り終わったら印は消えている
  assert.equal(shared.calls.signIn, 1);
  assert.equal(shared.localStorage.getItem("teiyomi_anon_login"), null);
});
