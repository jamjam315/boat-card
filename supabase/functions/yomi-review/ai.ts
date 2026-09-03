// LLM呼び出し。レジャー帳(aibou-speak/ai.ts)からの移植。
//
// 【移植にあたって落としたもの】
// あちらはチャットなので会話履歴を積む仕組みがある。艇読みのAI講評は
// 答案1枚に対する一方向の生成で、履歴も追加発言も無い。積む仕組みごと落とした。
//
// 【そのまま持ってきたもの——ここが移植の値打ち】
//  ・プロバイダーは環境変数だけで差し替える(コードを変えずに Claude ↔
//    OpenAI互換を行き来できる)
//  ・失敗は例外ではなく **null** で返す。呼び出し側は「文が取れたか」だけを
//    見ればよく、catch漏れで成功扱いになる事故が起きない
//  ・max_tokens のキー名はモデルによって違う(GPT-5世代は
//    max_completion_tokens しか受け付けない)。環境変数で上書きできる
//  ・失敗の種類だけをログに残す。**プロンプト本文と生成文は絶対に出さない**

/** 応答の待ち時間の上限。クライアント側は20秒待つので、こちらが先に諦める。 */
export const AI_TIMEOUT_MS = 15_000;

/**
 * 1回の応答に許す最大トークン数。**暴走を止める天井**であって、文量の
 * 指定ではない(文量はシステムプロンプトの「7〜10行」で決まる)。
 *
 * 講評そのものは日本語300〜500字ぶんなので、本文だけなら800で足りる。
 * 1024にしてあるのは**GPT-5世代が推論トークンをこの予算から食う**ため。
 * レジャー帳の実測では、800相当の予算で1%前後(198回中2回を2セット)が
 * 推論だけで使い切り、本文が空になった。本文が空はブロック扱いなので
 * 回数は消費しないが、利用者から見れば「使えない」でしかない。
 */
export const AI_MAX_TOKENS = 1024;

// 既定は**実際に使うもの**に合わせる。ここをAnthropicのままにして
// Secretsで上書きする形にすると、AI_PROVIDER を入れ忘れたときに
// OpenAIのキーを持ったままAnthropicのエンドポイントへ投げて失敗する。
// 沈黙して落ちる経路を作らない。
export const DEFAULT_PROVIDER = "openai";
// ⚠️ **枝番まで書く。** 素の `gpt-5.6` は上位のSolへ回されて単価が変わり、
// しかも**HTTP 200で成功する**ので請求が来るまで気づけない(レジャー帳で実測・
// 2026-08-16)。/v1/models の一覧にも素の `gpt-5.6` は出てこない。
export const DEFAULT_MODEL = "gpt-5.6-luna";
export const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

export interface AiConfig {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  maxTokensParam: string;
  maxTokens: number;
}

/** 正の整数として読めない値は無視して既定に落とす(打ち間違いで黙るより既定で動く)。 */
export function resolveMaxTokens(value?: string): number {
  const n = Number(value?.trim());
  return Number.isInteger(n) && n > 0 ? n : AI_MAX_TOKENS;
}

/**
 * OpenAI互換経路で使うトークン上限のキー名。
 *
 * **GPT-5世代は max_tokens を受け付けない**(HTTP 400
 * `Unsupported parameter: 'max_tokens'`)。モデルIDから自動で決めるので、
 * 通常 AI_MAX_TOKENS_PARAM を設定する必要はない。
 *
 * gpt-5世代だけを切り替える。grokもRunbookどおり AI_PROVIDER=openai で
 * 動かすため、provider名ではOpenAI公式と区別できないが、grokは実測で
 * どちらのキーでも通る(レジャー帳・2026-08-16)。
 */
export function resolveMaxTokensParam(model: string, override?: string): string {
  const v = override?.trim();
  if (v === "max_tokens" || v === "max_completion_tokens") return v;
  return /^(gpt-5|o[1-9])/i.test(model) ? "max_completion_tokens" : "max_tokens";
}

export function readAiConfig(
  env: (k: string) => string | undefined = (k) => Deno.env.get(k),
): AiConfig | null {
  const apiKey = env("AI_API_KEY");
  // Secrets未設定＝呼べない。**設定を忘れたら黙って別の何かをする、にはしない。**
  if (!apiKey) return null;
  const provider = (env("AI_PROVIDER") ?? DEFAULT_PROVIDER).toLowerCase();
  const model = env("AI_MODEL") ?? DEFAULT_MODEL;
  const baseUrl = (env("AI_BASE_URL") ??
    (provider === "anthropic" ? DEFAULT_ANTHROPIC_BASE_URL : DEFAULT_OPENAI_BASE_URL))
    .replace(/\/+$/, "");
  return {
    provider,
    model,
    baseUrl,
    apiKey,
    maxTokensParam: resolveMaxTokensParam(model, env("AI_MAX_TOKENS_PARAM")),
    maxTokens: resolveMaxTokens(env("AI_MAX_TOKENS")),
  };
}

function logFailure(kind: string, detail: string) {
  // 本文は出さない。運用者が見るのは「どの種類で失敗したか」まで。
  console.log(`[yomi-review] ai failed: ${kind} ${detail.slice(0, 200)}`);
}

export type AiCaller = (
  system: string,
  user: string,
  userHash?: string,
) => Promise<string | null>;

export function createAiCaller(
  config: AiConfig,
  fetchImpl: typeof fetch = fetch,
): AiCaller {
  return async (system: string, user: string, userHash?: string) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
    try {
      return config.provider === "anthropic"
        ? await callAnthropic(config, system, user, fetchImpl, controller.signal, userHash)
        : await callOpenAiCompatible(config, system, user, fetchImpl, controller.signal, userHash);
    } catch (e) {
      logFailure(
        controller.signal.aborted ? "timeout" : "exception",
        e instanceof Error ? `${e.name}: ${e.message}` : String(e),
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}

async function callAnthropic(
  config: AiConfig,
  system: string,
  user: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
  userHash?: string,
): Promise<string | null> {
  const res = await fetchImpl(`${config.baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: config.maxTokens,
      // 規則は system に置く。答案データと同じ位置に置くと、その中身で
      // 指示を上書きされうる。
      system,
      messages: [{ role: "user", content: user }],
      // 悪用検知のためのエンドユーザー識別子。**ハッシュ済みを渡すこと。**
      ...(userHash ? { metadata: { user_id: userHash } } : {}),
    }),
    signal,
  });
  if (!res.ok) {
    logFailure("http_error", `${res.status} ${(await res.text()).slice(0, 200)}`);
    return null;
  }
  const body = await res.json();
  const text = body?.content?.[0]?.text;
  return typeof text === "string" && text.trim().length > 0 ? text.trim() : null;
}

async function callOpenAiCompatible(
  config: AiConfig,
  system: string,
  user: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
  userHash?: string,
): Promise<string | null> {
  const res = await fetchImpl(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      [config.maxTokensParam]: config.maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      ...(userHash ? { user: userHash } : {}),
    }),
    signal,
  });
  if (!res.ok) {
    logFailure("http_error", `${res.status} ${(await res.text()).slice(0, 200)}`);
    return null;
  }
  const body = await res.json();
  const text = body?.choices?.[0]?.message?.content;
  return typeof text === "string" && text.trim().length > 0 ? text.trim() : null;
}

/** AI事業者へ渡す識別子。生のuser_idは渡さない。 */
export async function hashUserId(userId: string): Promise<string> {
  const data = new TextEncoder().encode("teiyomi:" + userId);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}
