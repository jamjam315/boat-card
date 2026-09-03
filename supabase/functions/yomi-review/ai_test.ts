// LLM呼び出し側のテスト。
//
//   deno test supabase/functions/yomi-review/ai_test.ts
//
// ここが無かったせいで、モデルIDを変えたときにトークン上限のキー名が壊れても
// 気づけない状態だった(本番で HTTP 400 `Unsupported parameter` が出て初めて
// 分かる)。プロバイダを切り替えるときに真っ先に壊れるところを固定する。
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  AI_MAX_TOKENS,
  createAiCaller,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  hashUserId,
  readAiConfig,
  resolveMaxTokens,
  resolveMaxTokensParam,
} from "./ai.ts";

// ---------------------------------------------------------------- 既定

Deno.test("既定は実際に使うもの(OpenAI / gpt-5.6-luna)に合わせてある", () => {
  // 既定をAnthropicのままにしてSecretsで上書きする形にすると、AI_PROVIDER の
  // 入れ忘れでOpenAIのキーをAnthropicのエンドポイントへ投げて失敗する。
  assertEquals(DEFAULT_PROVIDER, "openai");
  assertEquals(DEFAULT_MODEL, "gpt-5.6-luna");
});

Deno.test("モデルIDは枝番まで書いてある", () => {
  // 素の `gpt-5.6` は上位のSolへ回されて単価が変わり、しかもHTTP 200で
  // 成功するので請求が来るまで気づけない。枝番が落ちていないことを固定する。
  // 型としては定数なので、文字列として見て確かめる(素の "gpt-5.6" に
  // 書き換えられたら、この行が落ちてほしい)。
  const model: string = DEFAULT_MODEL;
  assert(model.endsWith("-luna"), `枝番が落ちている: ${model}`);
  assert(model !== "gpt-5.6");
});

Deno.test("既定のトークン上限は1024(GPT-5世代は推論ぶんも食う)", () => {
  assertEquals(AI_MAX_TOKENS, 1024);
});

// ---------------------------------------------------------------- キー名の判定

Deno.test("GPT-5世代には max_completion_tokens を送る", () => {
  for (const m of ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5", "GPT-5.2", "o3", "o1-mini"]) {
    assertEquals(resolveMaxTokensParam(m), "max_completion_tokens", m);
  }
});

Deno.test("それ以外は max_tokens のまま(grok・gpt-4o・Anthropic)", () => {
  for (const m of ["grok-4.20-non-reasoning", "gpt-4o", "claude-haiku-4-5-20251001"]) {
    assertEquals(resolveMaxTokensParam(m), "max_tokens", m);
  }
});

Deno.test("AI_MAX_TOKENS_PARAM で上書きできる。読めない値は無視する", () => {
  assertEquals(resolveMaxTokensParam("gpt-5.6-luna", "max_tokens"), "max_tokens");
  assertEquals(resolveMaxTokensParam("gpt-4o", "max_completion_tokens"), "max_completion_tokens");
  // 打ち間違いで黙るより、モデルIDからの自動判定に落ちるほうがよい
  assertEquals(resolveMaxTokensParam("gpt-5.6-luna", "  "), "max_completion_tokens");
  assertEquals(resolveMaxTokensParam("gpt-5.6-luna", "maxTokens"), "max_completion_tokens");
});

Deno.test("AI_MAX_TOKENS は正の整数だけ受ける", () => {
  assertEquals(resolveMaxTokens("2048"), 2048);
  assertEquals(resolveMaxTokens("0"), AI_MAX_TOKENS);
  assertEquals(resolveMaxTokens("-5"), AI_MAX_TOKENS);
  assertEquals(resolveMaxTokens("たくさん"), AI_MAX_TOKENS);
  assertEquals(resolveMaxTokens(undefined), AI_MAX_TOKENS);
});

// ---------------------------------------------------------------- 設定の読み取り

Deno.test("AI_API_KEY が無ければ設定を返さない(フェイルクローズ)", () => {
  assertEquals(readAiConfig(() => undefined), null);
  assertEquals(readAiConfig((k) => (k === "AI_PROVIDER" ? "openai" : undefined)), null);
});

Deno.test("Secretsが AI_API_KEY だけでも、既定でLunaを呼ぶ", () => {
  const c = readAiConfig((k) => (k === "AI_API_KEY" ? "sk-test" : undefined))!;
  assertEquals(c.provider, "openai");
  assertEquals(c.model, "gpt-5.6-luna");
  assertEquals(c.baseUrl, "https://api.openai.com/v1");
  assertEquals(c.maxTokensParam, "max_completion_tokens");
  assertEquals(c.maxTokens, 1024);
});

Deno.test("Anthropicへ戻すときは3つを書き戻せばよい", () => {
  const env: Record<string, string> = {
    AI_API_KEY: "sk-test",
    AI_PROVIDER: "anthropic",
    AI_MODEL: "claude-haiku-4-5-20251001",
    AI_BASE_URL: "https://api.anthropic.com",
  };
  const c = readAiConfig((k) => env[k])!;
  assertEquals(c.provider, "anthropic");
  assertEquals(c.baseUrl, "https://api.anthropic.com");
  assertEquals(c.maxTokensParam, "max_tokens");
});

Deno.test("AI_BASE_URL の末尾のスラッシュは落とす", () => {
  const env: Record<string, string> = {
    AI_API_KEY: "sk-test",
    AI_BASE_URL: "https://api.openai.com/v1///",
  };
  assertEquals(readAiConfig((k) => env[k])!.baseUrl, "https://api.openai.com/v1");
});

// ---------------------------------------------------------------- 実際に送る形

function fakeFetch(capture: { url?: string; body?: any; headers?: any }, reply: unknown) {
  return ((url: string, init: RequestInit) => {
    capture.url = String(url);
    capture.body = JSON.parse(String(init.body));
    capture.headers = init.headers;
    return Promise.resolve(
      new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } }),
    );
  }) as unknown as typeof fetch;
}

Deno.test("Lunaには max_completion_tokens だけを送る(max_tokensは送らない)", async () => {
  const cap: { url?: string; body?: any } = {};
  const config = readAiConfig((k) => (k === "AI_API_KEY" ? "sk-test" : undefined))!;
  const call = createAiCaller(config, fakeFetch(cap, {
    choices: [{ message: { content: "講評です。" } }],
  }));
  const out = await call("規則", "答案", "hash123");

  assertEquals(out, "講評です。");
  assertEquals(cap.url, "https://api.openai.com/v1/chat/completions");
  assertEquals(cap.body.model, "gpt-5.6-luna");
  assertEquals(cap.body.max_completion_tokens, 1024);
  assert(!("max_tokens" in cap.body), "max_tokens を送ると HTTP 400 になる");
  // 規則は system に置く。答案と同じ位置に置くと、その中身で上書きされうる。
  assertEquals(cap.body.messages[0].role, "system");
  assertEquals(cap.body.messages[0].content, "規則");
  assertEquals(cap.body.messages[1].content, "答案");
  assertEquals(cap.body.user, "hash123");
});

Deno.test("識別子を渡さないときは user を乗せない", async () => {
  const cap: { body?: any } = {};
  const config = readAiConfig((k) => (k === "AI_API_KEY" ? "sk-test" : undefined))!;
  const call = createAiCaller(config, fakeFetch(cap, {
    choices: [{ message: { content: "x" } }],
  }));
  await call("規則", "答案");
  assert(!("user" in cap.body));
});

Deno.test("Anthropic経路では max_tokens と system を送る", async () => {
  const cap: { url?: string; body?: any } = {};
  const env: Record<string, string> = { AI_API_KEY: "sk-test", AI_PROVIDER: "anthropic" };
  const call = createAiCaller(
    readAiConfig((k) => env[k])!,
    fakeFetch(cap, { content: [{ text: "講評です。" }] }),
  );
  assertEquals(await call("規則", "答案"), "講評です。");
  assertEquals(cap.url, "https://api.anthropic.com/v1/messages");
  assertEquals(cap.body.max_tokens, 1024);
  assertEquals(cap.body.system, "規則");
});

// ---------------------------------------------------------------- 失敗はnull

Deno.test("失敗は例外ではなく null(呼び出し側は文が取れたかだけ見ればよい)", async () => {
  const config = readAiConfig((k) => (k === "AI_API_KEY" ? "sk-test" : undefined))!;

  // HTTPエラー
  const err = createAiCaller(config, (() =>
    Promise.resolve(new Response("boom", { status: 500 }))) as unknown as typeof fetch);
  assertEquals(await err("s", "u"), null);

  // 通信断
  const down = createAiCaller(config, (() =>
    Promise.reject(new Error("network down"))) as unknown as typeof fetch);
  assertEquals(await down("s", "u"), null);

  // 本文が空(GPT-5世代が推論だけで予算を使い切った場合)
  const cap = {};
  const empty = createAiCaller(config, fakeFetch(cap, { choices: [{ message: { content: "   " } }] }));
  assertEquals(await empty("s", "u"), null);

  // 応答の形が読めない
  const weird = createAiCaller(config, fakeFetch(cap, { nonsense: true }));
  assertEquals(await weird("s", "u"), null);
});

// ---------------------------------------------------------------- 識別子

Deno.test("AI事業者へ渡すのはハッシュで、生のuser_idではない", async () => {
  const uid = "11111111-2222-3333-4444-555555555555";
  const h = await hashUserId(uid);
  assertEquals(h.length, 32);
  assert(!h.includes(uid));
  assert(!uid.includes(h));
  // 同じ人は同じ値になる(悪用検知に使うため)
  assertEquals(h, await hashUserId(uid));
  assert(h !== await hashUserId("99999999-2222-3333-4444-555555555555"));
});
