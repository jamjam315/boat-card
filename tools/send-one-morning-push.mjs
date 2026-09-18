// 朝の便と**同じ文面**を、1人の端末にだけ1通送る道具（運営用）。
//
// ============================================================================
// 使い方
// ============================================================================
//
//   # まず文面だけ見る（送らない）
//   node tools/send-one-morning-push.mjs --user <UUID>
//
//   # 送る（iOSアプリだけに）
//   node tools/send-one-morning-push.mjs --user <UUID> --send
//
//   # ブラウザにも送る
//   node tools/send-one-morning-push.mjs --user <UUID> --send --with-web
//
// ============================================================================
// 何のためか
// ============================================================================
//
// App Store 用のスクリーンショットに「朝の通知が届いたロック画面」を使いたいが、
// 本物の朝の便は1日1回・全員宛てで、撮り直しがきかない。この道具は
// send-morning-push の**同じ組み立て**（buildMessage）を通して1人だけに出す。
// 「[テスト]」は付かず、その人の実際のお気に入り・契約で組み立てた文面になる。
//
// ・その日の送信記録(push_send_log)は見ないし、書かない（朝の便に影響しない）
// ・鍵は supabase CLI から取り、**画面にもファイルにも出さない**
// ・送る前に必ず --send 無しで文面を確かめること
import { execFileSync } from "node:child_process";

const PROJECT_REF = "vynbhssakpxiikmseoja";
const FUNCTION_URL = `https://${PROJECT_REF}.supabase.co/functions/v1/send-morning-push`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(msg) {
  console.error("\n✖ " + msg);
  process.exit(1);
}

function arg(name) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : null;
}
const has = (name) => process.argv.includes("--" + name);

/** 管理用の鍵の候補を取る。**中身は出さない。** */
function adminKeys() {
  let out;
  try {
    out = execFileSync("supabase", [
      "projects", "api-keys", "--project-ref", PROJECT_REF, "--reveal", "-o", "json",
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    fail("supabase CLI から鍵を取れませんでした（supabase login と、プロジェクトのリンクを確認）");
  }
  const items = JSON.parse(out);
  // Edge Function 側は環境変数 SUPABASE_SERVICE_ROLE_KEY と突き合わせる。その中身が
  // 従来の service_role(JWT)か、新しい形式(sb_secret_)かはプロジェクトによるので、
  // **両方を順に試す**（外れたほうは 401 が返るだけで、何も起こらない）。
  const keys = [];
  const legacy = items.find((i) => i.name === "service_role" && (i.api_key || "").split(".").length === 3);
  if (legacy) keys.push(legacy.api_key);
  for (const i of items) {
    if ((i.api_key || "").startsWith("sb_secret_")) keys.push(i.api_key);
  }
  if (keys.length === 0) fail("管理用の鍵が見つかりませんでした（supabase login を確認）");
  return keys;
}

async function main() {
  const user = arg("user");
  if (!user || !UUID_RE.test(user)) fail("--user に user_id（UUID）を渡してください");
  const send = has("send");
  const withWeb = has("with-web");

  const base = { "x-only-user": user, "content-type": "application/json" };
  if (!withWeb) base["x-only-channel"] = "ios";
  if (!send) base["x-dry-run"] = "1";

  console.log(send
    ? `送ります: user=${user.slice(0, 8)}… / 宛先=${withWeb ? "iOSアプリとブラウザ" : "iOSアプリだけ"}`
    : `文面を確かめます（送りません）: user=${user.slice(0, 8)}…`);

  let res, body;
  for (const key of adminKeys()) {
    res = await fetch(FUNCTION_URL, {
      method: "POST",
      headers: { ...base, authorization: "Bearer " + key },
    });
    const text = await res.text();
    try { body = JSON.parse(text); } catch { body = text; }
    if (res.status !== 401) break;   // 鍵が合った（合わなければ次の候補へ）
  }

  if (!res.ok) fail(`HTTP ${res.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);

  if (!send) {
    const m = body.message;
    if (!m) {
      console.log("\n（この人に送る文面はありません）");
      console.log(JSON.stringify(body, null, 2));
      return;
    }
    console.log(`\n― 通知に出る文面 ―`);
    console.log(`題名: ${m.title}`);
    console.log(`本文: ${m.body}`);
    console.log(`\n宛先: iOS ${body.destinations.ios}台 / ブラウザ ${body.destinations.web}件` +
      ` ／ お気に入りの出走 ${body.matched}件・条件アラート ${body.alerts}件` +
      ` ／ ${body.premium ? "プレミアム" : "無料"}の文面`);
    console.log("\nこの文面でよければ --send を付けて実行してください。");
    return;
  }

  console.log("\n" + JSON.stringify(body, null, 2));
  if (body.sentIos > 0) console.log("\n✅ iOSアプリへ送りました（端末に届くまで数秒）");
  else console.log("\n⚠ iOSへの送信は0件でした（端末のトークン・通知の設定を確認）");
}

main().catch((e) => fail(e.message));
