// App Store Server Notifications の疎通を確かめる道具（WP-6）。
//
// ============================================================================
// 使い方
// ============================================================================
//
//   cd ~/dev/boat-card && node tools/apple-test-notification.mjs
//
//   tools/.env.local（apple-jwt-check.mjs と同じもの）の鍵で、Apple に
//   「テスト通知を送って」と頼み、送った結果（成功・失敗の理由）を表示する。
//
//   既定は **Sandbox**（ASC の「Sandbox サーバ URL」に届く）。本番の URL を
//   確かめるときだけ --production を付ける（アプリの公開前は本番の API が
//   401 を返すので、公開後に使う）。
//
// ============================================================================
// 何が分かるか
// ============================================================================
//
//   SUCCESS … Apple から apple-notifications まで届き、200 が返った。
//             Supabase の apple_notifications 表の notification_uuid = 'test-sandbox'
//             （--production なら 'test-production'）の行の processed_at が今の時刻になる
//   それ以外 … Apple が付けた失敗の理由がそのまま出る（URL の誤り・TLS・タイムアウト等）
//
// 鍵・JWT・通知の本文は表示しない。
// main は GitHub Pages でそのまま公開されるので、ここに値を書き込まないこと。

import { createPrivateKey, createSign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(HERE, ".env.local");
const HOSTS = {
  sandbox: "https://api.storekit-sandbox.itunes.apple.com",
  production: "https://api.storekit.itunes.apple.com",
};

function fail(msg) {
  console.error("\n✖ " + msg);
  process.exit(1);
}

function readEnv() {
  if (!existsSync(ENV_PATH)) {
    fail("tools/.env.local がありません。`cp tools/env.local.sample tools/.env.local` で作って埋めてください。");
  }
  const out = {};
  const lines = readFileSync(ENV_PATH, "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const q = value[0];
    if ((q === '"' || q === "'") && !(value.length > 1 && value.endsWith(q))) {
      const buf = [value.slice(1)];
      while (++i < lines.length && !lines[i].endsWith(q)) buf.push(lines[i]);
      if (i < lines.length) buf.push(lines[i].slice(0, -1));
      value = buf.join("\n");
    } else if (q === '"' || q === "'") {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function privateKeyPem(env) {
  if (env.APPLE_PRIVATE_KEY_FILE) {
    let p = env.APPLE_PRIVATE_KEY_FILE.replace(/^~(?=\/)/, homedir());
    if (!isAbsolute(p)) p = join(HERE, p);
    if (!existsSync(p)) fail("APPLE_PRIVATE_KEY_FILE の場所に .p8 がありません。");
    return readFileSync(p, "utf8");
  }
  if (env.APPLE_PRIVATE_KEY) return env.APPLE_PRIVATE_KEY.replace(/\\n/g, "\n");
  fail("APPLE_PRIVATE_KEY_FILE か APPLE_PRIVATE_KEY を tools/.env.local に書いてください。");
}

function token(env) {
  for (const k of ["APPLE_KEY_ID", "APPLE_ISSUER_ID", "APPLE_BUNDLE_ID"]) {
    if (!env[k]) fail(`${k} が tools/.env.local にありません。`);
  }
  const b64 = (s) => Buffer.from(s).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = b64(JSON.stringify({ alg: "ES256", kid: env.APPLE_KEY_ID, typ: "JWT" })) + "." +
    b64(JSON.stringify({ iss: env.APPLE_ISSUER_ID, iat: now, exp: now + 600, aud: "appstoreconnect-v1", bid: env.APPLE_BUNDLE_ID }));
  const sig = createSign("SHA256").update(unsigned).end()
    .sign({ key: createPrivateKey(privateKeyPem(env)), dsaEncoding: "ieee-p1363" });
  return unsigned + "." + sig.toString("base64url");
}

async function main() {
  const which = process.argv.includes("--production") ? "production" : "sandbox";
  const env = readEnv();
  const auth = { authorization: "Bearer " + token(env) };
  const host = HOSTS[which];
  console.log(`テスト通知を頼みます（${which}。ASC の「${which === "sandbox" ? "Sandbox" : "本番"}サーバ URL」に届きます）`);

  const req = await fetch(`${host}/inApps/v1/notifications/test`, { method: "POST", headers: auth });
  if (!req.ok) {
    const hint = req.status === 401
      ? (which === "production" ? "（公開前は本番の API が401を返します。--production を外して Sandbox で）" : "（鍵・Issuer ID を確認）")
      : "";
    fail(`依頼が通りませんでした: HTTP ${req.status}${hint}`);
  }
  const { testNotificationToken } = await req.json();
  console.log("1/2 依頼が通りました。Apple が送り終わるのを待ちます…");

  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const res = await fetch(`${host}/inApps/v1/notifications/test/${encodeURIComponent(testNotificationToken)}`, { headers: auth });
    if (!res.ok) continue;
    const body = await res.json();
    const attempts = Array.isArray(body.sendAttempts) ? body.sendAttempts : [];
    if (attempts.length === 0) continue;
    const last = attempts[attempts.length - 1];
    const result = last.sendAttemptResult;
    console.log(`2/2 送信結果: ${result === "SUCCESS" ? "✅ SUCCESS" : "✖ " + result}（${new Date(last.attemptDate).toLocaleString("ja-JP")}）`);
    if (result === "SUCCESS") {
      console.log(`    Supabase の apple_notifications の test-${which} の行の processed_at が今の時刻になっているはずです。`);
      return;
    }
    console.log("    ASC の URL（末尾まで）と、apple-notifications をデプロイ済みか（--no-verify-jwt）を確認してください。");
    process.exit(2);
  }
  fail("30秒待っても送信結果が出ませんでした。少し待ってからもう一度実行してください。");
}

main().catch((e) => fail(e.message));
