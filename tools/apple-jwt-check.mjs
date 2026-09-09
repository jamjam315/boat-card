// App Store Server API の認証だけを、Supabaseを経由せずに確かめる道具。
//
// レジャー帳の tools/apple-jwt-check.mjs からの移植（実行環境をMacに合わせた）。
//
// ============================================================================
// 使い方
// ============================================================================
//
//   1) 設定ファイルを作る。
//
//        cd ~/dev/boat-card
//        cp tools/env.local.sample tools/.env.local
//        open -e tools/.env.local
//
//      キーID・Issuer ID と、.p8 の置き場所を書く。
//      .p8 は tools/ に置いてファイル名だけを書いてもよいし、
//      ~/Documents/… の絶対パスを書いてもよい。
//
//   2) リポジトリのルートで実行する。
//
//        node tools/apple-jwt-check.mjs
//
//      Node が無く Deno があるなら:
//
//        deno run --allow-read --allow-net tools/apple-jwt-check.mjs
//
// ============================================================================
// 何を見るための道具か
// ============================================================================
//
// Edge Function が `apple api production=… sandbox=…` で401を返すとき、
// 原因は2つに割れる。
//
//   (A) Secretsの値が違う／キーの種類が違う
//   (B) 値は正しく、Edge Function側の作り（JWT生成・問い合わせ先）に問題
//
// この道具は Supabase をまったく通らずに、同じ4つの値で Apple を直接叩く。
// **Sandbox と 本番の両方**を叩くのが要点で、
//
//   Sandbox が 200/404 → 認証は通っている＝値は正しい → (B)
//   Sandbox も 401     → 値かキーの種類の問題         → (A)
//
// 本番が401でSandboxが404、という並びなら「アプリが公開されるまで本番の
// App Store Server API は401を返す」という既知の挙動そのもの。
// verify-purchase は401でもSandboxへ問い直す作りなので、この状態でも動く。
//
// .env.local に `FORCE_WEBCRYPTO=1` を足すと、Edge Functionと同じWebCryptoで
// 署名する。node:crypto版と結果が変わるなら署名の作り方そのものが疑わしい
// （変わらなければ署名は無実）。
//
// ============================================================================
// 秘密の扱い
// ============================================================================
//
// `.env.local`（`.env.*`）と `*.p8` は .gitignore 済み。この道具は**値そのものを
// 一切表示しない**（桁数・行数・秒数だけを出す）。JWTもトークンも出力しない。
//
// なお main は GitHub Pages でそのまま公開される。このファイル自体は
// https://teiyomi.com/tools/apple-jwt-check.mjs から読めるので、
// **ここに値を直接書き込まないこと。**
// ============================================================================

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(HERE, ".env.local");

const APPLE_SANDBOX =
  "https://api.storekit-sandbox.itunes.apple.com/inApps/v1/transactions";
const APPLE_PRODUCTION =
  "https://api.storekit.itunes.apple.com/inApps/v1/transactions";

/** 見つからないIDでも認証の可否は分かる（401か404かの違いだけ見たい）。 */
const FALLBACK_TRANSACTION_ID = "2000000000000000";

class ExitSignal extends Error {}

function setExit(code) {
  const p = globalThis.process;
  if (p) p.exitCode = code;
}

function die(message) {
  console.error(`\n[中断] ${message}\n`);
  setExit(2);
  throw new ExitSignal();
}

// --- .env.local の読み取り -------------------------------------------------

/**
 * ごく素朴な .env パーサ。BOMとCRLF、複数行のPEMをそのまま貼った場合
 * （`KEY="..." 〜 "`）に耐える。
 */
function parseEnv(raw) {
  const text = raw.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const out = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    const quote = value[0];
    if (quote === '"' || quote === "'") {
      if (value.length > 1 && value.endsWith(quote)) {
        value = value.slice(1, -1);
      } else {
        // 閉じ引用符が出るまで読み進める（PEMをそのまま貼った場合）。
        const buf = [value.slice(1)];
        while (++i < lines.length) {
          const next = lines[i];
          if (next.endsWith(quote)) {
            buf.push(next.slice(0, -1));
            break;
          }
          buf.push(next);
        }
        value = buf.join("\n");
      }
    }
    out[key] = value;
  }
  return out;
}

function required(env, key) {
  const value = env[key];
  if (!value) die(`${key} が tools/.env.local にありません。`);
  return value;
}

// --- base64url -------------------------------------------------------------

const stripPad = (s) =>
  s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlText = (s) => stripPad(btoa(s));
const b64urlBytes = (bytes) =>
  stripPad(btoa(String.fromCharCode(...new Uint8Array(bytes))));

// --- 署名 ------------------------------------------------------------------

/**
 * ES256で署名する。**Edge Functionとは別の実装（node:crypto）を先に試す。**
 * 同じ実装を使うと、実装側の不具合をこの道具でも再現してしまい、切り分けに
 * ならない。使えなければWebCryptoに落とし、どちらを使ったかを表示する。
 */
async function signEs256(unsigned, pem, forceWebCrypto = false) {
  if (forceWebCrypto) {
    console.log("  FORCE_WEBCRYPTO=1 のため、WebCryptoで署名します。");
  } else {
    try {
      const { createPrivateKey, createSign } = await import("node:crypto");
      const key = createPrivateKey(pem);
      const sig = createSign("SHA256")
        .update(unsigned)
        .end()
        .sign({ key, dsaEncoding: "ieee-p1363" });
      return { sig: b64urlBytes(sig), impl: "node:crypto (ieee-p1363)" };
    } catch (e) {
      console.log(`  node:crypto での署名に失敗しました（${e.message}）。`);
      console.log("  WebCryptoで試し直します。");
    }
  }

  const body = pem
    .replace(/-----BEGIN [A-Z ]+-----/, "")
    .replace(/-----END [A-Z ]+-----/, "")
    .replace(/\s/g, "");
  let der;
  try {
    der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  } catch {
    die(
      ".p8 の中身をbase64として読めませんでした。" +
        "ファイルが壊れているか、改行が `\\n` の2文字のまま入っています。",
    );
  }
  const key = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(unsigned),
  );
  return { sig: b64urlBytes(sig), impl: "WebCrypto (ECDSA P-256)" };
}

// --- 問い合わせ ------------------------------------------------------------

async function probe(label, base, transactionId, jwt) {
  console.log(`\n--- ${label} ---`);
  console.log(`GET ${base}/****`);
  let res;
  try {
    res = await fetch(`${base}/${encodeURIComponent(transactionId)}`, {
      headers: { authorization: `Bearer ${jwt}` },
    });
  } catch (e) {
    console.log(`  通信に失敗しました: ${e.message}`);
    return null;
  }
  const text = await res.text();
  console.log(`  status: ${res.status} ${res.statusText}`);
  if (!text) {
    console.log("  本文: なし");
    return res.status;
  }
  try {
    const body = JSON.parse(text);
    if (body.errorCode !== undefined) console.log(`  errorCode: ${body.errorCode}`);
    if (body.errorMessage !== undefined) {
      console.log(`  errorMessage: ${body.errorMessage}`);
    }
    if (body.signedTransactionInfo !== undefined) {
      console.log("  signedTransactionInfo: あり（中身は表示しません）");
    }
  } catch {
    // Appleが返すエラー文言はこちらの秘密を含まない。短いものはそのまま出す
    // （401のときの `Unauthenticated` などが切り分けの手がかりになる）。
    if (text.length <= 200) {
      console.log(`  本文: ${text.replace(/\s+/g, " ").trim()}`);
    } else {
      console.log(`  本文: JSONではありません（${text.length}文字）`);
    }
  }
  return res.status;
}

// --- 本体 ------------------------------------------------------------------

async function main() {
  if (!existsSync(ENV_PATH)) {
    die(
      "tools/.env.local がありません。\n" +
        "  cp tools/env.local.sample tools/.env.local\n" +
        "で作ってから、値を書いてください。",
    );
  }

  const env = parseEnv(readFileSync(ENV_PATH, "utf8"));
  const keyId = required(env, "APPLE_KEY_ID");
  const issuerId = required(env, "APPLE_ISSUER_ID");
  const bundleId = required(env, "APPLE_BUNDLE_ID");

  let pem;
  let pemSource;
  if (env.APPLE_PRIVATE_KEY_FILE) {
    // `~/Documents/...` のようにチルダで書かれていても開けるようにする。
    let raw = env.APPLE_PRIVATE_KEY_FILE;
    if (raw.startsWith("~/")) {
      const home = globalThis.process?.env?.HOME;
      if (home) raw = join(home, raw.slice(2));
    }
    const p8Path = isAbsolute(raw) ? raw : join(HERE, raw);
    if (!existsSync(p8Path)) {
      die("APPLE_PRIVATE_KEY_FILE が指すファイルが見つかりません。");
    }
    pem = readFileSync(p8Path, "utf8");
    pemSource = "APPLE_PRIVATE_KEY_FILE（.p8ファイル）";
  } else if (env.APPLE_PRIVATE_KEY) {
    // Secretsに `\n` の2文字で入っている場合に合わせて戻す。
    pem = env.APPLE_PRIVATE_KEY.replace(/\\n/g, "\n");
    pemSource = "APPLE_PRIVATE_KEY（文字列）";
  } else {
    die("APPLE_PRIVATE_KEY_FILE か APPLE_PRIVATE_KEY のどちらかが要ります。");
  }
  pem = pem.replace(/^﻿/, "").replace(/\r\n/g, "\n").trim();

  const transactionId = env.TRANSACTION_ID?.trim() || FALLBACK_TRANSACTION_ID;

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "ES256", kid: keyId, typ: "JWT" };
  const claim = {
    iss: issuerId,
    iat: now,
    exp: now + 20 * 60,
    aud: "appstoreconnect-v1",
    bid: bundleId,
  };
  const unsigned = `${b64urlText(JSON.stringify(header))}.${
    b64urlText(JSON.stringify(claim))
  }`;

  console.log("\n--- 設定の形（値そのものは出しません） ---");
  const pemLines = pem.split("\n");
  console.log(`  実行環境          : ${
    globalThis.Deno ? "Deno" : `Node ${globalThis.process?.version ?? "?"}`
  }`);
  console.log(`  kid の桁数        : ${keyId.length}`);
  console.log(`  iss の桁数        : ${issuerId.length}`);
  console.log(`  bid               : ${bundleId}`);
  console.log(`  aud               : ${claim.aud}`);
  console.log(`  exp - iat（秒）   : ${claim.exp - claim.iat}`);
  console.log(`  秘密鍵の渡し方    : ${pemSource}`);
  console.log(`  .p8 の行数        : ${pemLines.length}`);
  console.log(`  .p8 の1行目       : ${pemLines[0]}`);
  console.log(`  .p8 の最終行      : ${pemLines[pemLines.length - 1]}`);
  console.log(`  transactionId桁数 : ${transactionId.length}`);
  if (!pemLines[0].includes("BEGIN PRIVATE KEY")) {
    console.log(
      "  [注意] 1行目が `-----BEGIN PRIVATE KEY-----` ではありません。" +
        "App Store Connect の .p8 はPKCS#8のはずです。",
    );
  }
  if (bundleId !== "com.mtpworks.teiyomi") {
    console.log(
      "  [注意] bid が艇読みのBundle ID（com.mtpworks.teiyomi）ではありません。",
    );
  }

  const { sig, impl } = await signEs256(
    unsigned,
    pem,
    env.FORCE_WEBCRYPTO === "1",
  );
  console.log(`  署名の実装        : ${impl}`);
  const jwt = `${unsigned}.${sig}`;

  // **この2つの差が、そのまま切り分けの答えになる。**
  const sandbox = await probe("Apple Sandbox", APPLE_SANDBOX, transactionId, jwt);
  const production = await probe("Apple 本番", APPLE_PRODUCTION, transactionId, jwt);

  console.log("\n--- 判定 ---");
  if (sandbox === 200 || sandbox === 404) {
    console.log("  Sandboxの認証は通っています＝**Secretsの値は正しい**。");
    if (production === 401) {
      console.log(
        "  本番だけ401。アプリがApp Storeで公開されるまで本番の\n" +
          "  App Store Server API は401を返す、という既知の挙動と一致します。",
      );
      console.log(
        "  verify-purchase は本番401でもSandboxへ問い直す作りなので、\n" +
          "  この状態のままiOSの購入を検証できます（サーバー側の修正は不要）。",
      );
    } else {
      console.log(`  本番のstatusは ${production}。`);
    }
    setExit(0);
  } else if (sandbox === 401) {
    console.log("  Sandboxでも401。**値かキーの種類の問題**です。");
    console.log("  App Store Connect で次を確認してください:");
    console.log(
      "   - キーは「ユーザーとアクセス → 統合 → App内課金」で作ったものか\n" +
        "     （「App Store Connect API」のチームキーではないか）",
    );
    console.log("   - Issuer ID は、そのキーが載っている画面のものか");
    console.log("   - kid（キーID）と Issuer ID を取り違えていないか");
    console.log("   - .p8 はそのキーIDのものか（作り直すと旧鍵は失効する）");
    setExit(1);
  } else {
    console.log(`  Sandboxのstatusは ${sandbox}。上の出力を見て判断してください。`);
    setExit(1);
  }
  console.log("");
}

try {
  await main();
} catch (e) {
  if (!(e instanceof ExitSignal)) {
    console.error(`\n[想定外の失敗] ${e?.message ?? e}\n`);
    setExit(2);
  }
}
