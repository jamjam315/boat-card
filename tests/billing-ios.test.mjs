// billing-ios.js の単体テスト。
//   node --test tests/*.test.mjs
//
// 守りたいのは3つ。
//   1. onEvent の各 status で、画面に返す reason が正しいこと
//   2. サーバーが答えていないとき(通信失敗・5xx)に iap.verified を**送らない**こと
//   3. 合言葉(token)が無いときに殻へ**何も送らない**こと
//   4. 同じ取引を複数タブが同時に verify しないこと(WP-3e)
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
  // opts.store を渡すと複数の boot で localStorage を共有できる＝別タブを作れる。
  const store = opts.store || new Map();
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
    localStorage: { getItem: (k) => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) },
    sessionStorage: { getItem: (k) => sess.has(k) ? sess.get(k) : null, setItem: (k, v) => sess.set(k, v) },
    fetch: opts.fetch || (() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ is_active: true }) })),
    setTimeout, clearTimeout, AbortController, Promise, JSON, Array, String, Date, Object,
    __listeners: {},
    addEventListener(name, fn) { (this.__listeners[name] ||= []).push(fn); },
    dispatchEvent(name, ev) { (this.__listeners[name] || []).forEach((fn) => fn(ev)); },
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
  assert.equal(win.TeiyomiBilling.lastRejection(), "other_account", "読んでも消えない(WP-3e追補2)");
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

// ---- WP-3e: 409の案内を、押していない経路でも出す ----

test("起動時の再配送が 409 なら、画面向けに理由を残す", async () => {
  // 押した人がいない＝結果の届け先が無い。ここで控えておかないと、
  // premium を開いても 409 の案内文に到達しない(実機で発生した形)。
  const { win, sent, reloads } = boot({
    fetch: () => Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({}) }),
  });
  win.TeiyomiIOSBilling.onEvent({ type: "purchase", requestId: "req-1", status: "ok", jws: "JWS" });
  await flush();

  assert.deepEqual(sent, [{ type: "iap.verified", requestId: "req-1", ok: false, token: "tok-1" }]);
  assert.equal(win.TeiyomiBilling.lastRejection(), "other_account");
  // 控えるだけでは足りない。再配送は premium の price() をきっかけに届くので、
  // 検証の結果はその回の描画より後になる。描き直させて初めて案内文が出る。
  assert.equal(reloads.n, 1, "画面を描き直させる");
});

test("起動時の自動復元が 409 でも、画面向けに理由を残す", async () => {
  const { win } = boot({
    fetch: () => Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({}) }),
  });
  win.TeiyomiIOSBilling.onEvent({ type: "restore", requestId: "req-1", status: "ok", jws: "JWS" });
  await flush();

  assert.equal(win.TeiyomiBilling.lastRejection(), "other_account");
});

test("押した本人にも控えを残す(あとで画面が描き直されても案内が消えないため・WP-3e追補2)", async () => {
  const { win, reloads } = boot({
    fetch: () => Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({}) }),
  });
  const r = win.TeiyomiBilling.buy();
  win.TeiyomiIOSBilling.onEvent({ type: "purchase", requestId: "req-1", status: "ok", jws: "JWS" });
  assert.deepEqual(await r, { ok: false, reason: "other_account" });
  assert.equal(win.TeiyomiBilling.lastRejection(), "other_account");
  // 押している最中は描き直さない(ボタンの状態が飛ぶ)。結果は reason で本人に返る。
  assert.equal(reloads.n, 0);
});

// ---- WP-3e: タブ間の二重検証抑止 ----

test("同じ取引が4タブに届いても、verify は1回だけ", async () => {
  // 実機の形。殻は開いている全タブへ同じ合図を配るので、抑えないと4回飛ぶ
  // (殻側では `知らない requestId の返事を捨てました` ×3 として現れる)。
  const store = new Map();
  let fetched = 0;
  const fetch = () => {
    fetched++;
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ is_active: true }) });
  };
  const tabs = [boot({ store, fetch }), boot({ store, fetch }), boot({ store, fetch }), boot({ store, fetch })];

  tabs.forEach((t) => t.win.TeiyomiIOSBilling.onEvent({ type: "purchase", requestId: "req-1", status: "ok", jws: "JWS" }));
  await flush();

  assert.equal(fetched, 1, "印を取れたタブだけが検証する");
  assert.equal(tabs.reduce((n, t) => n + t.sent.length, 0), 1, "iap.verified も1回だけ");
});

test("別の取引なら、印があっても検証する", async () => {
  const store = new Map();
  let fetched = 0;
  const fetch = () => {
    fetched++;
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ is_active: true }) });
  };
  const a = boot({ store, fetch });
  const b = boot({ store, fetch });

  a.win.TeiyomiIOSBilling.onEvent({ type: "purchase", requestId: "req-1", status: "ok", jws: "JWS-1" });
  b.win.TeiyomiIOSBilling.onEvent({ type: "purchase", requestId: "req-2", status: "ok", jws: "JWS-2" });
  await flush();

  assert.equal(fetched, 2, "印は requestId ごと");
});

test("60秒を過ぎた印は効かない（取ったタブが閉じられた場合の救済）", async () => {
  const store = new Map([["teiyomi_ios_verify_lock:req-1", String(Date.now() - 120000)]]);
  let fetched = 0;
  const { win } = boot({
    store,
    fetch: () => {
      fetched++;
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ is_active: true }) });
    },
  });
  win.TeiyomiIOSBilling.onEvent({ type: "purchase", requestId: "req-1", status: "ok", jws: "JWS" });
  await flush();

  assert.equal(fetched, 1);
});

test("押した本人のタブは、他タブが印を持っていても検証する", async () => {
  // 先を越されたせいで「確認できませんでした」を出すほうが困る。
  const store = new Map([["teiyomi_ios_verify_lock:req-1", String(Date.now())]]);
  const { win } = boot({
    store,
    fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ is_active: true }) }),
  });
  const r = win.TeiyomiBilling.buy();
  win.TeiyomiIOSBilling.onEvent({ type: "purchase", requestId: "req-1", status: "ok", jws: "JWS" });

  assert.deepEqual(await r, { ok: true });
});

test("印を取れなかったタブは、iap.verified を送らない", async () => {
  const store = new Map([["teiyomi_ios_verify_lock:req-1", String(Date.now())]]);
  let fetched = 0;
  const { win, sent } = boot({
    store,
    fetch: () => { fetched++; return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ is_active: true }) }); },
  });
  win.TeiyomiIOSBilling.onEvent({ type: "purchase", requestId: "req-1", status: "ok", jws: "JWS" });
  await flush();

  assert.equal(fetched, 0, "検証しない");
  assert.equal(sent.length, 0, "返事も送らない(送った側が返す)");
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


// ---- WP-3e追補: 409の控えはタブをまたぐ ----

test("別のタブが 409 を受けても、premium 側の lastRejection() で読める（読んだら消える）", async () => {
  const store = new Map();
  const a = boot({ store, fetch: () => Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({}) }) });
  const b = boot({ store });   // premium を出しているタブ

  // 起動時の再配送が A に届き、A が検証して 409。
  a.win.TeiyomiIOSBilling.onEvent({ type: "purchase", requestId: "req-1", status: "ok", jws: "JWS" });
  await flush();
  assert.equal(a.sent.filter((m) => m.type === "iap.verified" && m.ok === false).length, 1);
  assert.ok(store.get("teiyomi_ios_last_denial").includes('"other_account"'));

  // B は検証していないが、控えを読める。
  assert.equal(b.win.TeiyomiBilling.lastRejection(), "other_account");
  assert.equal(b.win.TeiyomiBilling.lastRejection(), "other_account", "読んでも消えない(2回目の描画でも出る)");
  b.win.TeiyomiBilling.clearRejection();
  assert.equal(b.win.TeiyomiBilling.lastRejection(), null);
  assert.equal(store.has("teiyomi_ios_last_denial"), false);
});

test("別のタブが控えを置いたら、storage イベントでこのタブの画面が描き直される", () => {
  const store = new Map();
  const b = boot({ store });
  b.win.dispatchEvent("storage", { key: "teiyomi_ios_last_denial", newValue: "{}" });
  assert.equal(b.reloads.n, 1);
  // 関係ない鍵・削除(newValue null)では描き直さない。
  b.win.dispatchEvent("storage", { key: "other", newValue: "x" });
  b.win.dispatchEvent("storage", { key: "teiyomi_ios_last_denial", newValue: null });
  assert.equal(b.reloads.n, 1);
});

test("24時間より古い控えは出さない", () => {
  const store = new Map();
  store.set("teiyomi_ios_last_denial", JSON.stringify({ requestId: "r", reason: "other_account", at: Date.now() - 25 * 60 * 60 * 1000 }));
  const b = boot({ store });
  assert.equal(b.win.TeiyomiBilling.lastRejection(), null);
});

test("ログイン後のまとめ検証で 409 でも、控えを置いて描き直す（3経路目）", async () => {
  const store = new Map();
  const a = boot({
    store,
    user: { id: "anon", email: null, isAnonymous: true },
    fetch: () => Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({}) }),
  });
  a.win.TeiyomiIOSBilling.onEvent({ type: "purchase", requestId: "req-1", status: "ok", jws: "JWS" });
  a.win.__user = { id: "u1", email: "a@b", isAnonymous: false };
  a.win.dispatchEvent("teiyomi-auth-changed");
  await flush();
  assert.equal(a.reloads.n, 1, "描き直しを起こす");
  assert.equal(a.win.TeiyomiBilling.lastRejection(), "other_account");
});


// ---- WP-3e追補2: 4経路それぞれで、premium が読む控えが「2回読んでも」残る ----
// premium は読み込み直後に2回描画される(onChange 即時 + INITIAL_SESSION)。
// 1回目で消える控えは、2回目の描画で #buyMsg を空に戻してしまう(シミュレータで再現)。

const deny409 = () => Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({}) });

async function expectDenialSurvivesTwoReads(win, label) {
  assert.equal(win.TeiyomiBilling.lastRejection(), "other_account", `${label}: 1回目の描画`);
  assert.equal(win.TeiyomiBilling.lastRejection(), "other_account", `${label}: 2回目の描画でも残る`);
}

test("経路1: 起動時再配送(押していない・ログイン済み) → 控えが2回の描画を越えて残る", async () => {
  const { win } = boot({ fetch: deny409 });
  win.TeiyomiIOSBilling.onEvent({ type: "purchase", requestId: "req-1", status: "ok", jws: "JWS" });
  await flush();
  await expectDenialSurvivesTwoReads(win, "再配送");
});

test("経路2: ログイン後のまとめ検証 → 控えが2回の描画を越えて残る", async () => {
  const { win } = boot({ user: { id: "anon", email: null, isAnonymous: true }, fetch: deny409 });
  win.TeiyomiIOSBilling.onEvent({ type: "purchase", requestId: "req-1", status: "ok", jws: "JWS" });
  win.__user = { id: "u1", email: "a@b", isAnonymous: false };
  win.dispatchEvent("teiyomi-auth-changed");
  await flush();
  await expectDenialSurvivesTwoReads(win, "まとめ検証");
});

test("経路3: buy の再送(押している) → reason と控えの両方が other_account", async () => {
  const { win } = boot({ fetch: deny409 });
  const r = win.TeiyomiBilling.buy();
  win.TeiyomiIOSBilling.onEvent({ type: "purchase", requestId: "req-1", status: "ok", jws: "JWS" });
  assert.deepEqual(await r, { ok: false, reason: "other_account" });
  await expectDenialSurvivesTwoReads(win, "buy");
});

test("経路4: restore(押している) → reason と控えの両方が other_account", async () => {
  const { win } = boot({ fetch: deny409 });
  const r = win.TeiyomiBilling.restore();
  win.TeiyomiIOSBilling.onEvent({ type: "restore", requestId: "req-1", status: "ok", jws: "JWS" });
  assert.deepEqual(await r, { ok: false, reason: "other_account" });
  await expectDenialSurvivesTwoReads(win, "restore");
});

test("検証が通ったら控えは下がる", async () => {
  const store = new Map();
  store.set("teiyomi_ios_last_denial", JSON.stringify({ requestId: "r0", reason: "other_account", at: Date.now() }));
  const { win } = boot({ store });
  win.TeiyomiIOSBilling.onEvent({ type: "purchase", requestId: "req-1", status: "ok", jws: "JWS" });
  await flush();
  assert.equal(win.TeiyomiBilling.lastRejection(), null);
});
