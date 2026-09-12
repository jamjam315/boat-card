// push-ios.js の単体テスト(WP-4)。
//   node --test tests/*.test.mjs
//
// 守りたいのは4つ。
//   1. 許可を求めるのは利用者が押したときだけ(読み込んだだけでは求めない)
//   2. 保存は onConflict: token。**同じ端末で別の人がログインしたら移る**
//   3. ログアウト・通知OFFで行を消す(次に使う人へ前の人の通知が届かない)
//   4. 合言葉が無ければ殻へ何も送らない
// vm の中で作られた値は prototype が別なので、strict な deepEqual は使わない。
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "push-ios.js"), "utf8");

/** Supabaseのクライアントのうち、このファイルが使う分だけを持つ偽物。 */
function fakeDb(rows, log) {
  return {
    from(table) {
      return {
        upsert(row, opts) {
          log.push({ op: "upsert", table, row, onConflict: opts && opts.onConflict });
          return Promise.resolve({ error: log.failUpsert ? { message: "x" } : null });
        },
        delete() {
          return {
            eq(col, val) {
              log.push({ op: "delete", table, col, val });
              return Promise.resolve({ error: null });
            },
          };
        },
        select() {
          return {
            eq(col, val) {
              return {
                limit() {
                  log.push({ op: "select", table, col, val });
                  return Promise.resolve({ data: rows, error: null });
                },
              };
            },
          };
        },
      };
    },
  };
}

function boot(opts = {}) {
  const sent = [];
  const db = [];
  db.failUpsert = !!opts.failUpsert;
  const events = [];
  const win = {
    __teiyomiNative: opts.noToken ? undefined : { token: "tok-1" },
    TeiyomiIOS: {
      isIOSApp: () => !opts.notIOS,
      billingAvailable: () => !opts.noChannel,
      channel: () => (opts.noChannel ? null : win.TeiyomiNative),
    },
    TeiyomiNative: { postMessage: (s) => sent.push(JSON.parse(s)) },
    TeiyomiAuth: {
      getUser: () => (win.__user === undefined
        ? (opts.user === undefined ? { id: "u1", email: "a@b", isAnonymous: false } : opts.user)
        : win.__user),
      getClient: () => (opts.noDb ? null : fakeDb(opts.rows ?? [], db)),
    },
    Promise, JSON, Array, String, Date, Object, CustomEvent: class { constructor(n) { this.type = n } },
    __listeners: {},
    addEventListener(n, fn) { (this.__listeners[n] ||= []).push(fn) },
    dispatchEvent(e) { (this.__listeners[e.type || e] || []).forEach((fn) => fn()); events.push(e.type || e) },
  };
  win.window = win;
  const ctx = vm.createContext(win);
  vm.runInContext(SRC, ctx);
  return { win, sent, db, events, ctx };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const flush = async () => { for (let i = 0; i < 6; i++) await tick(); };

// ---- 差し替えの条件 ----

test("iOSでなければ何もしない(受け口も操作口も作らない)", () => {
  const { win } = boot({ notIOS: true });
  assert.equal(win.TeiyomiIOSPush, undefined);
  assert.equal(win.TeiyomiIOSPushControl, undefined);
});

test("iOSなら受け口と操作口を作る", () => {
  const { win } = boot();
  assert.equal(typeof win.TeiyomiIOSPush.onEvent, "function");
  assert.equal(typeof win.TeiyomiIOSPushControl.enable, "function");
});

// ---- ① 許可を求めるのは押したときだけ ----

test("読み込んだだけでは殻へ何も送らない(許可のプロンプトを出さない)", () => {
  const { sent } = boot();
  assert.equal(sent.length, 0);
});

test("enable() で初めて push.register を送る", async () => {
  const { win, sent } = boot();
  win.TeiyomiIOSPushControl.enable();
  await flush();
  assert.deepEqual(sent, [{ type: "push.register", token: "tok-1" }]);
});

// ---- ④ 合言葉 ----

test("token が無ければ殻へ何も送らない", async () => {
  const { win, sent } = boot({ noToken: true });
  const r = await win.TeiyomiIOSPushControl.enable();
  assert.equal(r.state, "unavailable");
  assert.equal(sent.length, 0);
});

test("殻の窓口が無ければ unavailable", async () => {
  const { win } = boot({ noChannel: true });
  assert.deepEqual(await win.TeiyomiIOSPushControl.getState(), { state: "unavailable" });
  assert.deepEqual(await win.TeiyomiIOSPushControl.enable(), { state: "unavailable" });
});

// ---- ② 保存 ----

test("トークンが届いたら onConflict:token で保存する", async () => {
  const { win, db } = boot();
  const p = win.TeiyomiIOSPushControl.enable();
  win.TeiyomiIOSPush.onEvent({ type: "token", token: "APNS-1", env: "sandbox" });
  assert.deepEqual(await p, { state: "on" });

  const up = db.find((d) => d.op === "upsert");
  assert.equal(up.table, "apns_tokens");
  assert.equal(up.onConflict, "token", "token で衝突させる(user_id ではない)");
  assert.equal(up.row.token, "APNS-1");
  assert.equal(up.row.env, "sandbox");
  assert.equal(up.row.user_id, "u1");
});

test("同じ端末で別の人がログインしたら、行の持ち主が移る", async () => {
  // **ここが要点。** onConflict:token なので、2人目の upsert で user_id が
  // その人へ移り、前の人にはもう届かない(端末を譲ったときに前の持ち主の
  // 出走通知が届き続けるのを防ぐ)。
  const { win, db } = boot();
  win.TeiyomiIOSPush.onEvent({ type: "token", token: "APNS-1", env: "production" });
  await flush();

  win.__user = { id: "u2", email: "c@d", isAnonymous: false };
  win.TeiyomiIOSPush.onEvent({ type: "token", token: "APNS-1", env: "production" });
  await flush();

  const ups = db.filter((d) => d.op === "upsert");
  assert.equal(ups.length, 2);
  assert.equal(ups[0].row.user_id, "u1");
  assert.equal(ups[1].row.user_id, "u2");
  assert.equal(ups[1].row.token, "APNS-1", "同じ行(トークンが同じ)");
});

test("env は sandbox か production にしか倒れない", async () => {
  const { win, db } = boot();
  win.TeiyomiIOSPush.onEvent({ type: "token", token: "A", env: "SANDBOX" });
  await flush();
  assert.equal(db.find((d) => d.op === "upsert").row.env, "production");
});

test("空のトークンは保存しない", async () => {
  const { win, db } = boot();
  win.TeiyomiIOSPush.onEvent({ type: "token", token: "", env: "sandbox" });
  win.TeiyomiIOSPush.onEvent({ type: "token", env: "sandbox" });
  await flush();
  assert.equal(db.filter((d) => d.op === "upsert").length, 0);
});

test("未ログインでは保存しない(誰の行か決まらない)", async () => {
  const { win, db } = boot({ user: { id: "anon", email: null, isAnonymous: true } });
  assert.deepEqual(await win.TeiyomiIOSPushControl.enable(), { state: "need-login" });
  assert.deepEqual(await win.TeiyomiIOSPushControl.getState(), { state: "need-login" });
  assert.equal(db.length, 0);
});

test("保存に失敗したら save-failed(ONに見えるのに届かない状態を作らない)", async () => {
  const { win } = boot({ failUpsert: true });
  const p = win.TeiyomiIOSPushControl.enable();
  win.TeiyomiIOSPush.onEvent({ type: "token", token: "A", env: "production" });
  assert.deepEqual(await p, { state: "save-failed" });
});

// ---- 断られたとき ----

test("断られたら denied(理由は載せない)", async () => {
  const { win, db } = boot();
  const p = win.TeiyomiIOSPushControl.enable();
  win.TeiyomiIOSPush.onEvent({ type: "denied" });
  assert.deepEqual(await p, { state: "denied" });
  assert.equal(db.length, 0, "保存しない");
});

// ---- ③ 消す ----

test("通知OFFで行を消し、殻にも解除を頼む", async () => {
  const { win, sent, db } = boot();
  win.TeiyomiIOSPush.onEvent({ type: "token", token: "APNS-1", env: "production" });
  await flush();
  sent.length = 0; db.length = 0;

  assert.deepEqual(await win.TeiyomiIOSPushControl.disable(), { state: "off" });
  const del = db.find((d) => d.op === "delete");
  assert.equal(del.table, "apns_tokens");
  assert.equal(del.col, "token");
  assert.equal(del.val, "APNS-1");
  assert.deepEqual(sent, [{ type: "push.unregister", token: "tok-1" }]);
});

test("ログアウトの掃除は通知OFFと同じ扱い", async () => {
  const { win, sent, db } = boot();
  win.TeiyomiIOSPush.onEvent({ type: "token", token: "APNS-1", env: "production" });
  await flush();
  sent.length = 0; db.length = 0;

  await win.TeiyomiIOSPushControl.signOutCleanup();
  assert.equal(db.find((d) => d.op === "delete").val, "APNS-1");
  assert.equal(sent.filter((m) => m.type === "push.unregister").length, 1);
});

test("解除したあとは、覚えているトークンが消える", async () => {
  const { win } = boot();
  win.TeiyomiIOSPush.onEvent({ type: "token", token: "APNS-1", env: "production" });
  await flush();
  assert.equal(win.TeiyomiIOSPushControl.currentToken().token, "APNS-1");

  await win.TeiyomiIOSPushControl.disable();
  assert.equal(win.TeiyomiIOSPushControl.currentToken(), null);
});

// ---- 状態 ----

test("保存済みなら on、無ければ off", async () => {
  const on = boot({ rows: [{ token: "APNS-1" }] });
  assert.deepEqual(await on.win.TeiyomiIOSPushControl.getState(), { state: "on" });

  const off = boot({ rows: [] });
  assert.deepEqual(await off.win.TeiyomiIOSPushControl.getState(), { state: "off" });
});

test("知らない合図は捨てる", async () => {
  const { win, db } = boot();
  win.TeiyomiIOSPush.onEvent({ type: "なにか" });
  win.TeiyomiIOSPush.onEvent(null);
  win.TeiyomiIOSPush.onEvent("token");
  await flush();
  assert.equal(db.length, 0);
});

test("状態が変わったら画面に知らせる", async () => {
  const { win, events } = boot();
  win.TeiyomiIOSPush.onEvent({ type: "token", token: "A", env: "production" });
  await flush();
  assert.ok(events.includes("teiyomi-ios-push-changed"));
});
