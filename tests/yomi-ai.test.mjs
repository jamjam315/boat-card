// AI講評の同意画面とプライバシーポリシーの、送信先の書き方のテスト(App Store 5.1.2(i))。
//   node --test tests/*.test.mjs
//
// レジャー帳 iOS の差し戻し(第三者AIの送信先を特定していない)と同じ水準を守る。
//   1. 同意画面の最初の一文に、送信先の事業者名(法人名)が出る
//   2. 同意画面とポリシーに、送信先での取り扱い(学習に使わない・保存期間)が書いてある
//   3. 「いずれか」のような複数社の書き方や、使っていない事業者名を出さない
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = readFileSync(join(ROOT, "yomi-ai.js"), "utf8");
const PRIVACY = readFileSync(join(ROOT, "privacy.html"), "utf8");

function load() {
  const win = { localStorage: { getItem: () => null, setItem() {} } };
  vm.runInNewContext(SRC, { window: win, localStorage: win.localStorage });
  return win.TeiyomiYomiAi;
}

/** HTML の <p> を順に、タグを外した文字列で返す。 */
function paragraphs(html) {
  return [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map((m) => m[1].replace(/<[^>]+>/g, ""));
}

test("同意画面の最初の一文(見出しの次)に、送信先の法人名が出る", () => {
  const ai = load();
  assert.strictEqual(ai.PROVIDER_NAME, "OpenAI, L.L.C.（米国）");
  const ps = paragraphs(ai.consentHtml());
  assert.strictEqual(ps[0], "AI講評を読む前に");
  const first = ps[1].split("。")[0];
  assert.ok(first.includes("OpenAI, L.L.C."), first);
});

test("同意画面に、送信先での取り扱い(学習に使わない・最長30日)が出る", () => {
  const ai = load();
  const text = paragraphs(ai.consentHtml()).join("\n");
  assert.ok(text.includes(ai.PROVIDER_HANDLING));
  assert.match(ai.PROVIDER_HANDLING, /学習に使われず/);
  assert.match(ai.PROVIDER_HANDLING, /最長30日間/);
});

test("プライバシーポリシーに、送信先・他社に送らないこと・学習・保存期間・用途が書いてある", () => {
  const sec = PRIVACY.slice(PRIVACY.indexOf("生成AIの利用について"), PRIVACY.indexOf("2. AI講評の報告"));
  assert.ok(sec.length > 0);
  for (const s of ["OpenAI, L.L.C.（米国）", "他の事業者へ送ることはありません", "モデルの学習に使用しない",
    "最長30日間保存され", "講評の生成だけ", "端末の他のアプリやセンサーから取得することはありません",
    "変更後の社名をお知らせしたうえで"]) {
    assert.ok(sec.includes(s), s);
  }
});

test("使っていない事業者名や「いずれか」を出さない", () => {
  const ai = load();
  for (const body of [ai.consentHtml(), PRIVACY]) {
    assert.doesNotMatch(body, /Anthropic|xAI|Grok|いずれか/);
  }
});

// ---- 回数の上限の言い分け(2026-09-17 匿名アカウント全体の1日上限) ----
function loadWith(status, body) {
  const win = {
    localStorage: { getItem: () => null, setItem() {} },
    TeiyomiAuth: { getAccessToken: () => Promise.resolve("token") },
  };
  const fetch = () => Promise.resolve({ status, json: () => Promise.resolve(body) });
  vm.runInNewContext(SRC, { window: win, localStorage: win.localStorage, fetch, setTimeout, clearTimeout, AbortController });
  return win.TeiyomiYomiAi;
}
const P = { key: "2026-09-11:大村:11", records: [], snapshot: { boats: [] }, wave: 1, yomi: null, inn: null };

test("サーバーが匿名全体の上限(anon_limit)を返したら「本日のお試し枠が上限に達しました」", async () => {
  const r = await loadWith(429, { ok: false, code: "anon_limit", premium: false, remaining: 0 }).generate(P);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.message, "本日のお試し枠が上限に達しました。");
});

test("ひとりぶんの上限は、これまでどおり無料/プレミアムで言い分ける", async () => {
  assert.strictEqual((await loadWith(429, { ok: false, code: "limit", premium: false }).generate(P)).message,
    "お試しの5回を使い切りました。プレミアムでは毎日3回使えます。");
  assert.strictEqual((await loadWith(429, { ok: false, code: "limit", premium: true }).generate(P)).message,
    "本日ぶんの3回を使い切りました。明朝また使えます。");
});

test("AIの側で返せなかったときは「混み合っています」+もう一度(回数は消費されない)", async () => {
  const busy = "AIの応答が混み合っています。少し待ってからもう一度お試しください。";
  for (const [status, body] of [[502, { ok: false, code: "blocked", kind: "empty" }], [503, { ok: false, code: "ai_unavailable" }], [500, {}]]) {
    const r = await loadWith(status, body).generate(P);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.retry, true, `${status} はもう一度押せる`);
    assert.strictEqual(r.message, busy);
  }
  assert.strictEqual(load().MSG.retry_note, "回数は消費されません。");
  // 形が崩れている(400)・ログインが要る(401)・回数の上限(429)は、もう一度押しても同じなので出さない
  for (const [status, body] of [[400, { ok: false, code: "bad_request" }], [401, {}], [429, { ok: false, code: "limit" }]]) {
    assert.ok(!(await loadWith(status, body).generate(P)).retry, `${status} はもう一度を出さない`);
  }
});

test("60秒待っても返らなかったときも「混み合っています」+もう一度", async () => {
  const win = { localStorage: { getItem: () => null, setItem() {} }, TeiyomiAuth: { getAccessToken: () => Promise.resolve("token") } };
  const fetch = () => Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
  vm.runInNewContext(SRC, { window: win, localStorage: win.localStorage, fetch, setTimeout, clearTimeout, AbortController });
  const r = await win.TeiyomiYomiAi.generate(P);
  assert.strictEqual(r.retry, true);
  assert.strictEqual(r.message, "AIの応答が混み合っています。少し待ってからもう一度お試しください。");
  assert.ok(/var TIMEOUT_MS = 60000;/.test(SRC), "ブラウザは60秒待つ");
});
