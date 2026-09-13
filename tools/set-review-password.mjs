// 審査用アカウントのパスワードを、1コマンドで設定して確かめる道具（WP-5）。
//
// ============================================================================
// 使い方
// ============================================================================
//
//   cd ~/dev/boat-card && node tools/set-review-password.mjs
//
//   別のアカウント（例: Play の審査用）に使うときだけ --email を付ける。
//
//   node tools/set-review-password.mjs --email <審査用メール>
//
// ============================================================================
// やること（この順）
// ============================================================================
//
//   1. service role キーを supabase CLI から取る（ログイン済み・リンク済みの設定を使う）
//   2. メールアドレスでユーザーを探す（ちょうど1人であること）
//   3. パスワードを生成する（英数字32文字・Node の暗号用乱数）
//   4. Auth の Admin API でパスワードを設定する
//   5. **実際に signInWithPassword と同じ口（/token?grant_type=password）でログインして**
//      成功を確かめ、作ったセッションはすぐログアウトする
//   6. パスワードを画面に1度だけ出す
//
// ============================================================================
// 守っていること
// ============================================================================
//
// - **キーは画面にもファイルにも出さない。** CLI から受け取ってメモリの中で使うだけ。
// - **パスワードはファイルに書かない・コマンドの引数にもしない**（シェルの履歴や
//   ps に残らない）。スクリプトの中で作り、最後に1度だけ表示する。
//   表示したら「パスワード」アプリなどへ移し、ターミナルは ⌘K で消す。
// - SQL で auth.users.encrypted_password を直接書き換える方法は**使わない**。
//   GoTrue が保存時にやること（暗号化の設定・コスト）を素通りするうえ、
//   入れた値が実際にログインで通るかを、その場で確かめる手段が無いため
//   （2026-09-13 に2回試して2回とも invalid_credentials で、原因を確定できなかった。
//   docs/ops/review-account-password.md）。
//
// 自己診断（ネットワークもキーも使わない）: node tools/set-review-password.mjs --self-test

import { execFileSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_REF = "vynbhssakpxiikmseoja";
const DEFAULT_EMAIL = "mtpworks.info+applereview@gmail.com";
const PASSWORD_LENGTH = 32;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// 部品（--self-test で確かめる）
// ---------------------------------------------------------------------------

/** 英数字だけのパスワード。randomInt は偏りの無い整数を返す（剰余の偏りが無い）。 */
export function generatePassword(length = PASSWORD_LENGTH) {
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/**
 * `supabase projects api-keys -o json --reveal` の出力から、管理用のキーを選ぶ。
 *
 * 旧来の service_role（JWT）があればそれ、無ければ新しい形式の secret キー（sb_secret_）。
 * **伏せ字で返ってきたものは使わない**（そのまま送ると 401 になり、原因が分かりにくい）。
 */
export function pickAdminKey(parsed) {
  const items = [];
  (function walk(v) {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      if (typeof v.api_key === "string") items.push(v);
      else Object.values(v).forEach(walk);
    }
  })(parsed);

  const isJwt = (k) => /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(k);
  const isSecret = (k) => /^sb_secret_[A-Za-z0-9_-]{16,}$/.test(k);

  const legacy = items.find((i) => i.name === "service_role" && isJwt(i.api_key));
  if (legacy) return { key: legacy.api_key, kind: "service_role" };
  const secret = items.find((i) => (i.type === "secret" || /secret/i.test(i.name ?? "")) && isSecret(i.api_key));
  if (secret) return { key: secret.api_key, kind: "secret" };
  return null;
}

/**
 * 管理用キーの送り方。
 * 旧来の JWT は apikey と Authorization の両方、sb_secret_ は apikey だけ
 * （新しい形式のキーは Authorization: Bearer に載せない決まり）。
 */
export function adminHeaders({ key, kind }) {
  const h = { apikey: key, "content-type": "application/json" };
  if (kind === "service_role") h.authorization = "Bearer " + key;
  return h;
}

function parseArgs(argv) {
  const args = { email: DEFAULT_EMAIL, selfTest: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--email") args.email = String(argv[++i] ?? "").trim();
    else if (argv[i] === "--self-test") args.selfTest = true;
    else throw new Error("知らない引数です: " + argv[i]);
  }
  if (!args.selfTest && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(args.email)) {
    throw new Error("メールアドレスの形ではありません: " + args.email);
  }
  return args;
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

function fail(msg) {
  console.error("\n✖ " + msg);
  process.exit(1);
}

function readSiteConfig() {
  const cfg = JSON.parse(readFileSync(join(ROOT, "supabase-config.json"), "utf8"));
  if (!cfg.url || !cfg.anonKey) fail("supabase-config.json に url / anonKey がありません");
  return { url: cfg.url.replace(/\/+$/, ""), anonKey: cfg.anonKey };
}

function loadAdminKey() {
  let out;
  try {
    out = execFileSync(
      "supabase",
      ["projects", "api-keys", "--project-ref", PROJECT_REF, "--reveal", "-o", "json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (e) {
    // stderr にキーは含まれない（失敗時の案内だけ）。
    fail("supabase CLI からキーを取れませんでした。`supabase login` 済みか確認してください。\n  " +
      String(e.stderr || e.message).split("\n").filter(Boolean).slice(0, 3).join("\n  "));
  }
  let parsed;
  try {
    // 念のため、JSON の始まり（[ か {）より前に何か出ていても読み飛ばす。
    parsed = JSON.parse(out.slice(Math.max(0, out.search(/[[{]/))));
  } catch {
    fail("supabase CLI の出力を読めませんでした（JSON ではありません）");
  }
  const picked = pickAdminKey(parsed);
  if (!picked) fail("管理用のキー（service_role / sb_secret_）が見つからないか、伏せ字で返ってきました");
  return picked;
}

async function findUserByEmail(url, admin, email) {
  const target = email.toLowerCase();
  const found = [];
  for (let page = 1; page <= 50; page++) {
    const res = await fetch(`${url}/auth/v1/admin/users?page=${page}&per_page=200`, { headers: adminHeaders(admin) });
    if (!res.ok) fail(`ユーザー一覧を取れませんでした（HTTP ${res.status}）`);
    const body = await res.json();
    const users = Array.isArray(body) ? body : body.users ?? [];
    for (const u of users) if ((u.email ?? "").toLowerCase() === target) found.push(u);
    if (users.length < 200) break;
  }
  if (found.length === 0) fail(`${email} のユーザーが見つかりません`);
  if (found.length > 1) fail(`${email} のユーザーが${found.length}人います（止めます）`);
  return found[0];
}

async function setPassword(url, admin, userId, password) {
  const res = await fetch(`${url}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: "PUT",
    headers: adminHeaders(admin),
    body: JSON.stringify({ password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) fail(`パスワードを設定できませんでした（HTTP ${res.status} ${body.error_code ?? body.code ?? ""} ${body.msg ?? body.message ?? ""}）`);
  if (body.id !== userId) fail("設定の応答が別のユーザーを指しています（止めます）");
}

/** アプリの signInWithPassword と同じ口で、実際にログインしてみる。 */
async function tryLogin(url, anonKey, email, password) {
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anonKey, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok && typeof body.access_token === "string", status: res.status, body };
}

async function logout(url, anonKey, accessToken) {
  // 確かめるためだけに作ったセッションなので、残さない。
  await fetch(`${url}/auth/v1/logout?scope=local`, {
    method: "POST",
    headers: { apikey: anonKey, authorization: "Bearer " + accessToken },
  }).catch(() => {});
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) return selfTest();

  const { url, anonKey } = readSiteConfig();
  console.log(`対象: ${args.email}（プロジェクト ${PROJECT_REF}）`);

  const admin = loadAdminKey();
  console.log(`1/5 管理用キーを CLI から取得（種類: ${admin.kind}。値は表示しません）`);

  const user = await findUserByEmail(url, admin, args.email);
  console.log(`2/5 ユーザーを確認  UID: ${user.id}`);

  const password = generatePassword();
  await setPassword(url, admin, user.id, password);
  console.log("3/5 パスワードを生成して、Admin API で設定");

  let login = null;
  for (let i = 0; i < 3; i++) {
    login = await tryLogin(url, anonKey, args.email, password);
    if (login.ok) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  const verified = login.ok && login.body.user?.id === user.id;
  if (verified) {
    console.log("4/5 ログイン確認: ✅ 成功（/token?grant_type=password。UID も一致）");
    await logout(url, anonKey, login.body.access_token);
    console.log("5/5 確認用のセッションはログアウト済み");
  } else {
    const b = login.body ?? {};
    console.log(`4/5 ログイン確認: ✖ 失敗（HTTP ${login.status} ${b.error_code ?? b.code ?? ""} ${b.msg ?? b.error_description ?? ""}）`);
    console.log("    パスワードは設定済みです。この1行をそのまま Claude に貼ってください。");
  }

  console.log("\n────────────────────────────────────────");
  console.log("パスワード（この1回だけ表示します）:");
  console.log("\n  " + password + "\n");
  console.log("→ すぐに「パスワード」アプリへ保存し、ターミナルは ⌘K で消してください。");
  console.log("────────────────────────────────────────");
  if (!verified) process.exit(2);
}

function selfTest() {
  const assert = (cond, msg) => { if (!cond) { console.error("✖ " + msg); process.exit(1); } console.log("✔ " + msg); };

  const a = generatePassword();
  const b = generatePassword();
  assert(a.length === 32 && /^[A-Za-z0-9]+$/.test(a), "パスワードは英数字32文字");
  assert(a !== b, "毎回違う値になる");

  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2lnbmF0dXJl";
  const secret = "sb_secret_abcdefghijklmnopqrstuvwxyz";
  assert(pickAdminKey([{ name: "anon", api_key: jwt }, { name: "service_role", api_key: jwt }]).kind === "service_role",
    "旧来の service_role を選ぶ");
  assert(pickAdminKey([{ name: "anon", api_key: jwt }]) === null, "anon しか無ければ選ばない");
  assert(pickAdminKey([{ name: "default", type: "secret", api_key: secret }]).kind === "secret", "新形式の secret を選ぶ");
  assert(pickAdminKey([{ name: "default", type: "secret", api_key: "sb_secret_abcd··········" }]) === null,
    "伏せ字のキーは選ばない");
  assert(pickAdminKey({ keys: [{ name: "service_role", api_key: jwt }] })?.kind === "service_role", "入れ子の形でも読める");

  assert(adminHeaders({ key: jwt, kind: "service_role" }).authorization === "Bearer " + jwt, "旧来のキーは Authorization にも載せる");
  assert(!("authorization" in adminHeaders({ key: secret, kind: "secret" })), "sb_secret_ は Authorization に載せない");

  assert(parseArgs([]).email === DEFAULT_EMAIL, "既定は Apple 審査用のアカウント");
  let threw = false;
  try { parseArgs(["--email", "not-an-email"]); } catch { threw = true; }
  assert(threw, "メールの形でなければ止まる");
  console.log("\nself-test OK");
}

main().catch((e) => fail(e.message));
