// iOS版(App Store)の様子をひと目で見る道具。**読むだけ**で、何も書き換えない。
//
// ============================================================================
// 使い方
// ============================================================================
//
//   cd ~/dev/boat-card && node tools/ios-health.mjs           … 直近24時間
//   cd ~/dev/boat-card && node tools/ios-health.mjs 72        … 直近72時間
//
// 出るもの
//   1. Apple が送った通知（本番・Sandbox）と、その**配達結果**
//      SUCCESS 以外（TIMED_OUT 等）があれば、艇読み側が応答できていない
//   2. apple_notifications（確認の記録）… result が error: なら Apple への問い合わせに失敗
//   3. memberships の iOS の行 … 契約中の数と、期限切れなのに active のままの行
//   4. apns_tokens … 通知をオンにしている端末の数（env ごと）
//   5. 通知の受け口の応答時間 … 形の違う本文を1回投げて測る（記録は残らない）
//
// 鍵・トークン・本文は表示しない。Apple の鍵は tools/.env.local（他の道具と同じもの）、
// データベースは supabase CLI（リンク済みプロジェクト）を使う。
import { execFileSync } from "node:child_process";
import { createPrivateKey, createSign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(HERE, ".env.local");
const PROJECT_REF = "vynbhssakpxiikmseoja";
const FUNCTION_URL = `https://${PROJECT_REF}.supabase.co/functions/v1/apple-notifications`;
const HOSTS = {
  sandbox: "https://api.storekit-sandbox.itunes.apple.com",
  production: "https://api.storekit.itunes.apple.com",
};
const hours = Number(process.argv[2] || 24);
const since = Date.now() - hours * 3600_000;
const jst = (t) => new Date(t).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });

function readEnv() {
  if (!existsSync(ENV_PATH)) return null;
  const out = {};
  const lines = readFileSync(ENV_PATH, "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n").split("\n");
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    let value = line.slice(eq + 1).trim();
    if ((value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) value = value.slice(1, -1);
    out[line.slice(0, eq).trim()] = value;
  }
  return out;
}

function appleToken(env) {
  let pem;
  if (env.APPLE_PRIVATE_KEY_FILE) {
    let p = env.APPLE_PRIVATE_KEY_FILE.replace(/^~(?=\/)/, homedir());
    if (!isAbsolute(p)) p = join(HERE, p);
    pem = readFileSync(p, "utf8");
  } else {
    pem = (env.APPLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  }
  const b64 = (s) => Buffer.from(s).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = b64(JSON.stringify({ alg: "ES256", kid: env.APPLE_KEY_ID, typ: "JWT" })) + "." +
    b64(JSON.stringify({
      iss: env.APPLE_ISSUER_ID, iat: now, exp: now + 600,
      aud: "appstoreconnect-v1", bid: env.APPLE_BUNDLE_ID,
    }));
  const sig = createSign("SHA256").update(unsigned).end()
    .sign({ key: createPrivateKey(pem), dsaEncoding: "ieee-p1363" });
  return unsigned + "." + sig.toString("base64url");
}

/** Apple が送った通知と配達結果。 */
async function notifications(which, auth) {
  const rows = [];
  let cursor;
  for (let page = 0; page < 5; page++) {
    const url = `${HOSTS[which]}/inApps/v1/notifications/history` +
      (cursor ? `?paginationToken=${encodeURIComponent(cursor)}` : "");
    const res = await fetch(url, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ startDate: since, endDate: Date.now() }),
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const body = await res.json();
    for (const it of body.notificationHistory ?? []) {
      const p = JSON.parse(Buffer.from(it.signedPayload.split(".")[1], "base64url").toString());
      const attempts = (it.sendAttempts ?? []).map((a) => a.sendAttemptResult);
      rows.push({
        at: jst(p.signedDate),
        type: p.notificationType + (p.subtype ? "/" + p.subtype : ""),
        env: p.data?.environment ?? "?",
        results: attempts,
      });
    }
    if (!body.hasMore) break;
    cursor = body.paginationToken;
  }
  return { rows };
}

/** データベースを読む(supabase CLI 経由)。 */
function sql(query) {
  try {
    const out = execFileSync("supabase", ["db", "query", "--linked", "--project-ref", PROJECT_REF, "-o", "json", query], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], cwd: join(HERE, ".."),
    });
    return JSON.parse(out).rows;
  } catch {
    return null;
  }
}

function section(title) {
  console.log("\n== " + title);
}

const env = readEnv();
console.log(`艇読み iOS の様子（直近${hours}時間・${jst(Date.now())} 現在）`);

section("1. Apple が送った通知と配達結果");
if (!env?.APPLE_KEY_ID) {
  console.log("  tools/.env.local が無いので飛ばした");
} else {
  const auth = { authorization: "Bearer " + appleToken(env), "content-type": "application/json" };
  for (const which of ["production", "sandbox"]) {
    const { rows, error } = await notifications(which, auth);
    if (error) { console.log(`  ${which}: 取得できず（${error}）`); continue; }
    if (rows.length === 0) { console.log(`  ${which}: 0件`); continue; }
    for (const r of rows) {
      const ng = r.results.some((x) => x !== "SUCCESS");
      console.log(`  ${ng ? "✖" : "・"} ${which} ${r.at} ${r.type} env=${r.env} ${r.results.join(",")}`);
    }
  }
}

section("2. 確認の記録（apple_notifications）");
const notes = sql(`select notification_uuid, notification_type, environment, result,
  to_char(received_at at time zone 'Asia/Tokyo','MM-DD HH24:MI:SS') as r
  from apple_notifications where received_at > now() - interval '${hours} hours' order by received_at desc limit 50;`);
if (notes === null) console.log("  読めなかった（supabase CLI のリンクを確認）");
else if (notes.length === 0) console.log("  0件");
else {
  for (const n of notes) {
    const ng = String(n.result).startsWith("error") || n.result === "processing";
    console.log(`  ${ng ? "✖" : "・"} ${n.r} ${n.notification_type} ${n.environment} ${n.result}`);
  }
}

section("3. memberships（iOS）");
const members = sql(`select status, count(*) as n from memberships where platform='ios' group by status;`);
const stale = sql(`select count(*) as n from memberships
  where platform='ios' and status='active' and current_period_end is not null and current_period_end < now();`);
if (members === null) console.log("  読めなかった");
else {
  console.log("  " + (members.map((m) => `${m.status}=${m.n}`).join(" / ") || "0件"));
  const n = stale?.[0]?.n ?? 0;
  console.log(`  ${n > 0 ? "✖" : "・"} 期限切れなのに active の行: ${n}`);
}

section("4. 通知の登録（apns_tokens）");
const tokens = sql(`select env, count(*) as n, to_char(max(updated_at) at time zone 'Asia/Tokyo','MM-DD HH24:MI') as latest
  from apns_tokens group by env;`);
if (tokens === null) console.log("  読めなかった");
else if (tokens.length === 0) console.log("  0件");
else for (const t of tokens) console.log(`  ・${t.env}: ${t.n}件（最終更新 ${t.latest}）`);

section("5. 通知の受け口の応答時間");
const t0 = Date.now();
const res = await fetch(FUNCTION_URL, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ ping: 1 }),   // 通知の形ではないので 400。記録も残らない
}).catch((e) => ({ status: "接続できず " + e.message }));
const ms = Date.now() - t0;
console.log(`  ${ms > 3000 ? "✖" : "・"} HTTP ${res.status}（${(ms / 1000).toFixed(2)}秒）… 3秒を超えると Apple が TIMED_OUT にしうる`);
