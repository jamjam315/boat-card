// billing-ios.js の単体テスト。
//   node --test tests/
//
// 守りたいのは3つ。
//   1. onEvent の各 status で、画面に返す reason が正しいこと
//   2. サーバーが答えていないとき(通信失敗・5xx)に iap.verified を**送らない**こと
//   3. 合言葉(token)が無いときに殻へ**何も送らない**こと
import { test } from "node:test";
// vm の中で作られた値は prototype が別なので、strict な deepEqual は通らない。
import assert from "node:assert";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "billing-ios.js"), "utf8");

/** 殻・認証・会員のスタブを持つ window を組み立てて billing-ios.js を読む。 */
function boot(opts = {}) {
  const sent = [];                       // 殻へ送ったもの
  const reloads = { n: 0 };
  const membershipListeners = [];
  const store = new Map();
  const sess = new Map();
  const win = {
    __teiyomiNative: opts.noToken ? undefined : { token: "tok-1" },
    TeiyomiIOS: {
      isIOSApp: () => opts.notIOS ? false : true,
      billingAvailable: () => !opts.noChannel,
      channel: () => opts.noChannel ? null : win.TeiyomiNative,
    },
    TeiyomiNative: { postMessage: (s) => sent.push(JSON.parse(s)) },
    TeiyomiAuth: {
      getUser: () => win.__user === undefined
        ? (opts.user === undefined ? { id: "u1", email: "a@b", isAnonymous: false } : opts.user)
        : win.__user,
      getConfig: () => ({ url: "https://supa.example", anonKey: "anon" }),
      getAccessToken: () => Promise.resolve(opts.noAccessToken ? null : "jwt"),
    },
    TeiyomiMembership: { reload: () => { reloads.n++; }, onChange: (fn) => membershipListeners.push(fn) },
    TeiyomiBilling: { tag: "play" },     // billing.js が先に置いたもの
    localStorage: { getItem: (k) => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, v) },
    sessionStorage: { getItem: (k) => sess.has(k) ? sess.get(k) : null, setItem: (k, v) => sess.set(k, v) },
    fetch: opts.fetch || (() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ is_active: true }) })),
    setTimeout, clearTimeout, AbortController, Promise, JSON, Array, String, Date, Object,
    __listeners: {},
    addEventListener(name, fn) { (this.__listeners[name] ||= []).push(fn); },
    dispatchEvent(name) { (this.__listeners[name] || []).forEach((fn) => fn()); },
  };
  win.window = win;
  const ctx = vm.createContext(win);
  vm.runInContext(SRC, ctx);
  return { win, sent, reloads, membershipListeners, store, sess, ctx };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const flush = async () => { for (let i = 0; i < 6; i++) await tick(); };

// ---- 差し替えの条件 ----

test("iOSでなければ何もしない(TeiyomiBilling を差し替えない・受け口も作らない)", () => {
  const { win } = boot({ notIOS: true });
  assert.equal(win.TeiyomiBilling.tag, "play");
  assert.equal(win.TeiyomiIOSBilling, undefined);
});

test("iOSなら受け口を作ってから、TeiyomiBilling を差し替える", () => {
  const { win } = boot();
  assert.equal(typeof win.TeiyomiIOSBilling.onEvent, "function");
  assert.equal(win.TeiyomiBilling.productId, "teiyomi_premium_monthly");
  assert.equal(win.TeiyomiBilling.tag, undefined);
});

// ---- 合言葉が無ければ送らない ----

test("token が無ければ殻へ何も送らない(price/buy/restore とも)", async () => {
  const { win, sent } = boot({ noToken: true });
  assert.equal(await win.TeiyomiBilling.price(), null);
  assert.deepEqual(await win.TeiyomiBilling.buy(), { ok: false, reason: "unavailable" });
  assert.deepEqual(await win.TeiyomiBilling.restore(), { ok: false, reason: "unavailable" });
  assert.equal(sent.length, 0);
});

test("送るものには必ず token が付く", async () => {
  const { win, sent } = boot();
  win.TeiyomiBilling.price();
  assert.deepEqual(sent[0], { type: "iap.products", token: "tok-1" });
});

// ---- 価格 ----

test("価格はストアの priceText をそのまま使う(自前で組み立てない)", async () => {
  const { win } = boot();
  const p = win.TeiyomiBilling.price();
  win.TeiyomiIOSBilling.onEvent({ type: "products", items: [
    { id: "teiyomi_premium_monthly", priceText: "¥480", price: 480, currency: "JPY" },
  ] });
  const got = await p;
  assert.equal(win.TeiyomiBilling.priceText(got), "¥480");
  assert.equal(got.currency, "JPY");
});

test("商品が空なら null(画面は「準備中」に倒す)", async () => {
  const { win } = boot();
  const p = win.TeiyomiBilling.price();
  win.TeiyomiIOSBilling.onEvent({ type: "products", items: [] });
  assert.equal(await p, null);
  assert.equal(win.TeiyomiBilling.priceText(null), null);
});

// ---- 購入: onEvent の各 status ----

test("purchase ok → verify(platform:ios, jws) → iap.verified ok:true → reload", async () => {
  const calls = [];
  const { win, sent, reloads, store } = boot({
    fetch: (url, init) => { calls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ is_active: true }) }); },
  });
  const r = win.TeiyomiBilling.buy();
  assert.deepEqual(sent[0], { type: "iap.buy", productId: "teiyomi_premium_monthly", token: "tok-1" });
  win.TeiyomiIOSBilling.onEvent({ type: "purchase", requestId: "req-1", status: "ok", jws: "JWS" });
  assert.deepEqual(await r, { ok: true });

  assert.equal(calls[0].url, "https://supa.example/functions/v1/verify-purchase");
  assert.deepEqual(calls[0].body, { purchase_token: "JWS", product_id: "teiyomi_premium_monthly", platform: "ios" });
  assert.equal(calls[0].auth, "Bearer jwt");
  assert.deepEqual(sent[1], { type: "iap.verified", requestId: "req-1", ok: true, token: "tok-1" });
  assert.equal(reloads.n, 1);
  // (d) の印が置かれる
  assert.deepEqual(JSON.parse(store.get("teiyomi_ios_verified")).userId, "u1");
});

test("サーバーが 4xx で拒否 → iap.verified ok:false → not_verified、reload しない", async () => {
  const { win, sent, reloads } = boot({
    fetch: () => Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({}) }),
  });
  const r = win.TeiyomiBilling.buy();
  win.TeiyomiIOSBilling.onEvent({ type: "purchase", requestId: "req-1", status: "ok", jws: "JWS" });
  assert.deepEqual(await r, { ok: false, reason: "not_verified" });
  assert.deepEqual(sent[1], { type: "iap.verified", requestId: "req-1", ok: false, token: "tok-1" });
  assert.equal(reloads.n, 0);
});

test("2xx だが is_active:false → iap.verified ok:false", async () => {
  const { win, sent } = boot({
    fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ is_active: false }) }),
  });
  const r = win.TeiyomiBilling.buy();
  win.TeiyomiIOSBilling.onEvent({ type: "purchase", requestId: "req-1", status: "ok", jws: "JWS" });
  assert.deepEqual(await r, { ok: false, reason: "not_verified" });
  assert.equal(sent[1].ok, false);
});

for (const [name, fetch] of [
  ["通信失敗", () => Promise.reject(new Error("offline"))],
  ["5xx", () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) })],
  ["本文が壊れている", () => Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new Error("bad json")) })],
]) {
  test(`${name}のときは iap.verified を送らない(取引は次の起動で再配送される)`, async () => {
    const { win, sent, reloads } = boot({ fetch });
    const r = win.TeiyomiBilling.buy();
    win.TeiyomiIOSBilling.onEvent({ type: "purchase", requestId: "req-1", status: "ok", jws: "JWS" });
    assert.deepEqual(await r, { ok: false, reason: "not_verified" });
    assert.equal(sent.filter((m) => m.type === "iap.verified").length, 0);
    assert.equal(reloads.n, 0);
  });
}

test("未ログイン(アクセストークン無し)でも iap.verified を送らない", async () => {
  const { win, sent } = boot({ noAccessToken: true });
  win.TeiyomiIOSBilling.onEvent({ type: "purchase", requestId: "req-1", status: "ok", jws: "JWS" });
  await flush();
  assert.equal(sent.filter((m) => m.type === "iap.verified").length, 0);
});

test("buy を待っていなくても(起動時の再配送)、purchase ok は検証して返事する", async () => {
  const { win, sent, reloads } = boot();
  win.TeiyomiIOSBilling.onEvent({ type: "purchase", requestId: "req-9", status: "ok", jws: "JWS" });
  await flush();
  assert.deepEqual(sent[0], { type: "iap.verified", requestId: "req-9", ok: true, token: "tok-1" });
  assert.equal(reloads.n, 1);
});

test("cancelled / pending / error はそれぞれの reason で返り、verify を呼ばない", async () => {
  for (const [status, reason] of [["cancelled", "cancelled"], ["pending", "pending"], ["error", "failed"]]) {
    let fetched = 0;
    const { win, sent } = boot({ fetch: () => { fetched++; return Promise.reject(new Error("x")); } });
    const r = win.TeiyomiBilling.buy();
    win.TeiyomiIOSBilling.onEvent({ type: "purchase", status });
    assert.deepEqual(await r, { ok: false, reason });
    assert.equal(fetched, 0);
    assert.equal(sent.filter((m) => m.type === "iap.verified").length, 0);
  }
});

test("requestId や jws が文字列でない ok は捨てる", async () => {
  let fetched = 0;
  const { win, sent } = boot({ fetch: () => { fetched++; return Promise.reject(new Error("x")); } });
  win.TeiyomiIOSBilling.onEvent({ type: "purchase", status: "ok", jws: "JWS" });
  win.TeiyomiIOSBilling.onEvent({ type: "purchase", requestId: "r", status: "ok", jws: 42 });
  await flush();
  assert.equal(fetched, 0);
  assert.equal(sent.length, 0);
});

// ---- 復元 ----

test("restore ok → verify → verified、empty → no_purchase、error → failed", async () => {
  {
    const { win, sent } = boot();
    const r = win.TeiyomiBilling.restore();
    assert.deepEqual(sent[0], { type: "iap.restore", token: "tok-1" });
    win.TeiyomiIOSBilling.onEvent({ type: "restore", requestId: "req-2", status: "ok", jws: "JWS" });
    assert.deepEqual(await r, { ok: true });
    assert.deepEqual(sent[1], { type: "iap.verified", requestId: "req-2", ok: true, token: "tok-1" });
  }
  {
    const { win } = boot();
    const r = win.TeiyomiBilling.restore();
    win.TeiyomiIOSBilling.onEvent({ type: "restore", status: "empty" });
    assert.deepEqual(await r, { ok: false, reason: "no_purchase" });
  }
  {
    const { win } = boot();
    const r = win.TeiyomiBilling.restore();
    win.TeiyomiIOSBilling.onEvent({ type: "restore", status: "error" });
    assert.deepEqual(await r, { ok: false, reason: "failed" });
  }
});

// ---- 起動時の復元(条件付き) ----

function fire(listeners, state) { listeners.forEach((fn) => fn(state)); }
const notActive = { active: false, user: { id: "u1", isAnonymous: false } };

test("4条件が揃ったときだけ、起動時に iap.restore を1回送る", () => {
  const { sent, membershipListeners, store } = boot();
  store.set("teiyomi_ios_verified", JSON.stringify({ userId: "u1", at: "x" }));
  fire(membershipListeners, notActive);
  fire(membershipListeners, notActive);   // 2回目は送らない(1セッション1回)
  assert.deepEqual(sent.filter((m) => m.type === "iap.restore").length, 1);
});

test("印が無い(初回購入前)なら起動時に何も送らない", () => {
  const { sent, membershipListeners } = boot();
  fire(membershipListeners, notActive);
  assert.equal(sent.length, 0);
});

test("印が別のアカウントのものなら送らない", () => {
  const { sent, membershipListeners, store } = boot();
  store.set("teiyomi_ios_verified", JSON.stringify({ userId: "someone-else", at: "x" }));
  fire(membershipListeners, notActive);
  assert.equal(sent.length, 0);
});

test("契約中(active:true)・匿名・状態不明(null)なら送らない", () => {
  const { sent, membershipListeners, store } = boot();
  store.set("teiyomi_ios_verified", JSON.stringify({ userId: "u1", at: "x" }));
  fire(membershipListeners, { active: true, user: { id: "u1", isAnonymous: false } });
  fire(membershipListeners, { active: false, user: { id: "u1", isAnonymous: true } });
  fire(membershipListeners, null);
  assert.equal(sent.length, 0);
});

test("殻の窓口が無ければ、印があっても送らない", () => {
  const { sent, membershipListeners, store } = boot({ noChannel: true });
  store.set("teiyomi_ios_verified", JSON.stringify({ userId: "u1", at: "x" }));
  fire(membershipListeners, notActive);
  assert.equal(sent.length, 0);
});


// ---- WP-3d: 未ログインで届いた取引はログイン後に検証する ----

test("未ログインで届いた purchase ok は保持し、ログイン完了後に verify → iap.verified", async () => {
  let fetched = 0;
  const { win, sent } = boot({
    user: { id: "anon", email: null, isAnonymous: true },
    fetch: () => { fetched++; return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ is_active: true }) }); },
  });
  win.TeiyomiIOSBilling.onEvent({ type: "purchase", requestId: "req-1", status: "ok", jws: "JWS" });
  await flush();
  assert.equal(fetched, 0, "未ログインでは検証しない");
  assert.equal(sent.length, 0, "iap.verified も送らない");

  // 殻が同じ requestId で送り直してきても、二重に保持しない(ログイン後の検証は1回)。
  win.TeiyomiIOSBilling.onEvent({ type: "purchase", requestId: "req-1", status: "ok", jws: "JWS" });

  win.__user = { id: "u1", email: "a@b", isAnonymous: false };
  win.dispatchEvent("teiyomi-auth-changed");
  await flush();
  assert.equal(fetched, 1);
  assert.deepEqual(sent, [{ type: "iap.verified", requestId: "req-1", ok: true, token: "tok-1" }]);
});

test("ログイン後の検証で 409(別アカウント)なら ok:false を返し、画面向けに理由を残す", async () => {
  const { win, sent } = boot({
    user: { id: "anon", email: null, isAnonymous: true },
    fetch: () => Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({}) }),
  });
  win.TeiyomiIOSBilling.onEvent({ type: "purchase", requestId: "req-1", status: "ok", jws: "JWS" });
  win.__user = { id: "u1", email: "a@b", isAnonymous: false };
  win.dispatchEvent("teiyomi-auth-changed");
  await flush();
  assert.deepEqual(sent, [{ type: "iap.verified", requestId: "req-1", ok: false, token: "tok-1" }]);
  assert.equal(win.TeiyomiBilling.lastRejection(), "other_account");
  assert.equal(win.TeiyomiBilling.lastRejection(), null, "一度読んだら消える");
});

test("buy 中に 409 なら reason は other_account", async () => {
  const { win } = boot({
    fetch: () => Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({}) }),
  });
  const r = win.TeiyomiBilling.buy();
  win.TeiyomiIOSBilling.onEvent({ type: "purchase", requestId: "req-1", status: "ok", jws: "JWS" });
  assert.deepEqual(await r, { ok: false, reason: "other_account" });
});

test("restore 中に 409 でも reason は other_account", async () => {
  const { win } = boot({
    fetch: () => Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({}) }),
  });
  const r = win.TeiyomiBilling.restore();
  win.TeiyomiIOSBilling.onEvent({ type: "restore", requestId: "req-1", status: "ok", jws: "JWS" });
  assert.deepEqual(await r, { ok: false, reason: "other_account" });
});

// ---- WP-3d: 二重読み込み ----

test("2回読まれても状態は1つ。billing.js に上書きされた TeiyomiBilling を戻す", async () => {
  const { win, sent, ctx } = boot();
  const first = win.TeiyomiBilling;
  win.TeiyomiBilling = { tag: "play-again" };      // billing.js があとから上書きした形
  vm.runInContext(SRC, ctx);                       // premium の静的タグで2回目
  assert.equal(win.TeiyomiBilling, first, "最初の実体に戻る");

  // 受け口も1つのまま。送り直しを受けても検証は1回。
  win.TeiyomiIOSBilling.onEvent({ type: "purchase", requestId: "req-1", status: "ok", jws: "JWS" });
  win.TeiyomiIOSBilling.onEvent({ type: "purchase", requestId: "req-1", status: "ok", jws: "JWS" });
  await flush();
  assert.equal(sent.filter((m) => m.type === "iap.verified").length, 1);
});

test("2回目の読み込みで、あとから来た membership に配線される", () => {
  const { win, ctx, membershipListeners } = boot();
  // 1回目は membership.js より先に読まれた形にする。
  const before = membershipListeners.length;
  vm.runInContext(SRC, ctx);
  assert.equal(membershipListeners.length, before, "配線済みなら二重に登録しない");
});
