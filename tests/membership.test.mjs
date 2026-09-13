// membership.js の単体テスト(WP-4追補2)。
//   node --test tests/*.test.mjs
//
// 守りたいのは3つ。
//   1. 失敗したら取り直す。**1回の失敗で契約者を「未契約」側に倒さない**
//      (ログイン直後の最初の問い合わせだけが401になることがある)
//   2. 取り直しても駄目なら null(判定できない)。いつまでも待たせない
//   3. 後から始まった読み込みの結果だけを配る(古い結果で上書きしない)
// vm の中で作られた値は prototype が別なので、strict な deepEqual は使わない。
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "membership.js"), "utf8");

const ACTIVE_ROW = { status: "active", price_id: "p", current_period_end: "2999-01-01T00:00:00Z" };

/**
 * replies: 問い合わせ1回ごとの返事。
 *   "401"  … res.error あり(PostgRESTに拒まれた)
 *   "net"  … 通信失敗(Promise が reject)
 *   {row}  … 成功
 */
function boot(replies, opts = {}) {
  const timers = [];
  const queries = [];
  const win = {
    __user: opts.user === undefined ? { id: "u1", email: "a@b", isAnonymous: false } : opts.user,
    TeiyomiAuth: {
      getUser: () => win.__user,
      getClient: () => ({
        from(table) {
          return {
            select() {
              return {
                eq(col, val) {
                  const reply = replies[queries.length] ?? replies[replies.length - 1];
                  queries.push({ table, col, val });
                  const p = typeof reply === "function" ? reply() : reply;
                  if (p === "net") return Promise.reject(new Error("offline"));
                  if (p === "401") return Promise.resolve({ data: null, error: { code: "PGRST303" } });
                  if (p instanceof Promise) return p;
                  return Promise.resolve({ data: p.row ? [p.row] : [], error: null });
                },
              };
            },
          };
        },
      }),
    },
    Promise, Date, Math, isNaN, CustomEvent: class { constructor(n) { this.type = n } },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    __listeners: {},
    addEventListener(n, fn) { (this.__listeners[n] ||= []).push(fn) },
  };
  win.window = win;
  vm.runInContext(SRC, vm.createContext(win));
  return { win, timers, queries };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const flush = async () => { for (let i = 0; i < 8; i++) await tick(); };

/** 仕掛けられた待ち時間を、古い順に1つ進める。 */
async function fire(timers) {
  const t = timers.find((x) => !x.done);
  assert.ok(t, "待ち時間が仕掛けられていない");
  t.done = true;
  t.fn();
  await flush();
  return t.ms;
}

test("成功すればそのまま返す(取り直さない)", async () => {
  const { win, timers, queries } = boot([{ row: ACTIVE_ROW }]);
  const st = await win.TeiyomiMembership.load();
  assert.equal(st.active, true);
  assert.equal(queries.length, 1);
  assert.equal(timers.length, 0);
});

test("ログイン直後の401が1回だけなら、取り直して契約中と判定する", async () => {
  // **ここが要点。** 以前は1回の失敗で null を返し、各画面が「未契約」側で描いたまま
  // 再読み込みまで戻らなかった(契約者に購入画面が出続ける)。
  const { win, timers, queries } = boot(["401", { row: ACTIVE_ROW }]);
  let result;
  win.TeiyomiMembership.load().then((s) => { result = s; });
  await flush();
  assert.equal(result, undefined, "失敗した時点ではまだ答えを出さない");

  await fire(timers);
  assert.equal(queries.length, 2);
  assert.equal(result.active, true);
  assert.equal(result.status, "active");
});

test("通信失敗も同じく取り直す", async () => {
  const { win, timers } = boot(["net", { row: ACTIVE_ROW }]);
  let result;
  win.TeiyomiMembership.load().then((s) => { result = s; });
  await flush();
  await fire(timers);
  assert.equal(result.active, true);
});

test("3回取り直しても駄目なら null(判定できない)。4回で止まる", async () => {
  const { win, timers, queries } = boot(["401"]);
  let result = "未決";
  win.TeiyomiMembership.load().then((s) => { result = s; });
  await flush();
  const waits = [];
  for (let i = 0; i < 3; i++) waits.push(await fire(timers));

  assert.equal(result, null);
  assert.equal(queries.length, 4, "最初の1回＋取り直し3回");
  assert.equal(timers.length, 3, "それ以上は待たない");
  // 待ち時間は伸びていき、合計は各画面の保険(8秒)より十分短い。
  assert.ok(waits[0] < waits[1] && waits[1] < waits[2]);
  assert.ok(waits.reduce((a, b) => a + b, 0) < 6000);
});

test("待っている間に別のアカウントへ切り替わったら、取り直さずに抜ける", async () => {
  const { win, timers, queries } = boot(["401", { row: ACTIVE_ROW }]);
  let result = "未決";
  win.TeiyomiMembership.load().then((s) => { result = s; });
  await flush();

  win.__user = { id: "u2", email: "c@d", isAnonymous: false };
  await fire(timers);
  assert.equal(queries.length, 1, "前の人の行を取り直さない");
  assert.equal(result, null);
});

test("匿名は問い合わせずに非会員(取り直しの対象にならない)", async () => {
  const { win, queries, timers } = boot(["401"], { user: { id: "anon", email: null, isAnonymous: true } });
  const st = await win.TeiyomiMembership.load();
  assert.equal(st.active, false);
  assert.equal(queries.length, 0);
  assert.equal(timers.length, 0);
});

test("画面へは、失敗の途中経過(null)を配らず、取り直した結果を1回だけ配る", async () => {
  const { win, timers } = boot(["401", { row: ACTIVE_ROW }]);
  const got = [];
  win.TeiyomiMembership.onChange((s) => got.push(s));
  await flush();
  assert.equal(got.length, 0);

  await fire(timers);
  assert.equal(got.length, 1);
  assert.equal(got[0].active, true);
});

test("後から始まった読み込みがあれば、古い読み込みの結果は配らない", async () => {
  // 1回目(匿名のころ始まったもの等)が取り直しで遅れ、その間にログインして
  // 2回目が始まった。1回目が後から返ってきても、2回目の結果を上書きしない。
  let releaseFirst;
  const first = new Promise((r) => { releaseFirst = () => r({ data: [], error: null }); });
  const { win } = boot([() => first, { row: ACTIVE_ROW }]);
  const got = [];
  win.TeiyomiMembership.onChange((s) => got.push(s));   // 1回目(遅い)
  await flush();
  win.TeiyomiMembership.reload();                         // 2回目(速い)
  await flush();
  assert.equal(got.length, 1);
  assert.equal(got[0].active, true);

  releaseFirst();   // 1回目は「行なし=未契約」で返ってくるが…
  await flush();
  assert.equal(got.length, 1, "古い結果で上書きしない");
});
