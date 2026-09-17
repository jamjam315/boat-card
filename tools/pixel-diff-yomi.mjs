// 読み採点の答案ページ(yomi.html)と、レースページの記録欄(yomi-race.js)が、変更の前後で
// 1ピクセルも変わらないかを確かめる手元用の道具。CIでは回さない。
// AI-14 v1②(答案の描画の部品化)で作り、v1④(記録欄の部品化)でレースページの記録欄を足した。
// 答案の部品(yomi-paper.js / yomi-paper.css)・yomi.html・記録欄(yomi-race.js)を触るときに使う。
//
//   node tools/pixel-diff-yomi.mjs            作業ツリー と HEAD を比べる
//   node tools/pixel-diff-yomi.mjs <ref>      作業ツリー と <ref>(コミット・ブランチ)を比べる
//   node tools/pixel-diff-yomi.mjs same       HEAD と HEAD(比べ方が安定しているかの確認)
//
// 【比べ方】
// - ローカルに2つのサーバーを立てる。「前」は COMPARE_FILES だけを git の <ref> から配り、ほかは
//   作業ツリーから配る(比べたいファイル以外の条件をそろえる)。「後」は作業ツリーをそのまま配る
// - ヘッドレス Chrome を CDP で動かし、同じ記録(端末の保存領域に入れる)・同じ時刻(Date を固定)・
//   同じ画面幅(390 / 1024px)・同じ配色(明 / 暗)で、ページ全体を撮って PNG をそのまま比べる
// - 外部(jsdelivr / supabase)への通信は前後とも止める(ログインや会員判定で表示が揺れないように)
// - 答案の元データは tests/fixtures/yomi-engine-races.json(実レース7本)を yomi.js で採点して作る。
//   実レース42答案に、採点待ち・タグ・スナップショット無し・AI講評あり/報告済み/報告フォーム/
//   同意画面・結果なし混在・記録なし・点外の数字を開く・つづきにフォーカス、を足した53通り
// - レースページの記録欄は、race/ にあるいちばん新しい日の最初のページで、閉じた欄・開いた欄・
//   券種と艇と金額を選んだ欄・記録した直後・出所タグ2種の内訳・締切後・上限エラーの7通り
//
// 【使うときの作法】
// 1. まず `same` で全部一致することを確かめる(比べ方そのものが安定しているか)
// 2. 変更の前後を比べる。違いが出たら、前後の PNG を OUT_DIR に書き出す
// 3. 「違いを拾えるか」も一度確かめる(CSS を1pxだけ変えて流し、違いが出ることを見てから戻す)
//
// 必要なもの: Node 22 以上(WebSocket が標準)、Chrome。Chrome の場所は環境変数 CHROME で変えられる。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import os from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(os.tmpdir(), "teiyomi-pixel-diff");
const ARG = process.argv[2] || "HEAD";
const SAME = ARG === "same";
const REF = SAME ? "HEAD" : ARG;
// git の <ref> から配るファイル。答案ページの見た目を決めるものを足していく
const COMPARE_FILES = new Set(["yomi.html", "yomi-paper.js", "yomi-paper.css", "yomi-race.js"]);
const CHROME = process.env.CHROME || [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
].find((p) => fs.existsSync(p));
if (!CHROME) { console.error("Chrome が見つかりません。環境変数 CHROME で場所を指定してください。"); process.exit(2); }
fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png" };
function serve(fromRef) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html";
      let body = null;
      try {
        body = fromRef && COMPARE_FILES.has(rel)
          ? execFileSync("git", ["show", `${REF}:${rel}`], { cwd: REPO, stdio: ["ignore", "pipe", "ignore"] })
          : fs.readFileSync(path.join(REPO, rel));
      } catch { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "Content-Type": TYPES[path.extname(rel)] || "application/octet-stream", "Cache-Control": "no-store" });
      res.end(body);
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

// ---- 答案の元データ ----
const NOW = "2026-09-17T11:22:00.000Z";
class FixedDate extends Date { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return Date.parse(NOW); } }
const win = { localStorage: { getItem: () => null, setItem() {} } };
vm.runInNewContext(fs.readFileSync(path.join(REPO, "yomi.js"), "utf8"), { window: win, localStorage: win.localStorage, Date: FixedDate });
const Y = win.TeiyomiYomi;
const plain = (x) => JSON.parse(JSON.stringify(x));
const RACES = JSON.parse(fs.readFileSync(path.join(REPO, "tests/fixtures/yomi-engine-races.json"), "utf8")).races;

function bundles(race) {
  const [c1, c2, c3] = race.pay["3連単"][0].c.split("-").map(Number);
  return {
    b1: [["3連単", [1, 2, 3], 100], ["3連単", [1, 3, 2], 100]],
    b2: [["3連単", [c1, c2, c3], 100]],
    b3: [["2連複", [5, 6], 200]],
    b4: [["単勝", [6], 500]],
    b5: [["複勝", [1], 100], ["拡連複", [1, 2], 100]],
    b6: [2, 3, 4, 5, 6].filter((n) => n !== c1).slice(0, 3).map((n) => ["2連単", [c1, n], 100]),
  };
}
const scenarios = [];
for (const { key, snapshot, race } of RACES) {
  for (const [name, list] of Object.entries(bundles(race))) {
    const records = list.map(([ken, lanes, amount], i) => {
      const r = { key, ken, lanes, amount, tag: "", id: name + i, at: NOW };
      return { ...r, score: plain(Y.scoreOne(r, race)) };
    });
    scenarios.push({ id: `${key}/${name}`, key, tag: "", records, snaps: { [key]: snapshot } });
  }
}
const R0 = RACES[0], R1 = RACES[1];
const scored = (r, recs, tag = "") => recs.map(([ken, lanes, amount], i) => {
  const x = { key: r.key, ken, lanes, amount, tag, id: "s" + i, at: NOW };
  return { ...x, score: plain(Y.scoreOne(x, r.race)) };
});
const snap0 = { [R0.key]: R0.snapshot }, snap1 = { [R1.key]: R1.snapshot };
scenarios.push({ id: "pending", key: R0.key, tag: "", records: [{ key: R0.key, ken: "3連単", lanes: [1, 2, 3], amount: 300, tag: "", id: "p", at: NOW }], snaps: snap0 });
scenarios.push({ id: "tag", key: R0.key, tag: "展示重視", records: scored(R0, [["3連単", [1, 3, 2], 100]], "展示重視"), snaps: snap0 });
scenarios.push({ id: "no-snapshot", key: R0.key, tag: "", records: scored(R0, [["3連単", [1, 3, 2], 100]]), snaps: {} });
{
  const recs = scored(R1, [["3連単", [1, 2, 3], 100]]);
  recs[0].score.ai = { text: "AIの講評の本文です。\n2行目です。", model: "gpt-test", at: "2026-09-15T03:04:00.000Z" };
  scenarios.push({ id: "ai-saved", key: R1.key, tag: "", records: recs, snaps: snap1 });
  const recs2 = plain(recs);
  recs2[0].score.ai.reported = true;
  scenarios.push({ id: "ai-reported", key: R1.key, tag: "", records: recs2, snaps: snap1 });
  scenarios.push({ id: "ai-report-form", key: R1.key, tag: "", records: recs, snaps: snap1, action: "document.getElementById('aiRp').click()" });
}
scenarios.push({ id: "ai-consent", key: R0.key, tag: "", records: scored(R0, [["3連単", [1, 3, 2], 100]]), snaps: snap0, action: "document.getElementById('aiGo').click()" });
{
  const recs = scored(R0, [["単勝", [1], 100]]);
  recs.push({ key: R0.key, ken: "2連単", lanes: [2, 1], amount: 100, tag: "", id: "nd", at: NOW, score: { at: NOW, st: "nodata", pt: null } });
  scenarios.push({ id: "nodata-mixed", key: R0.key, tag: "", records: recs, snaps: snap0 });
}
scenarios.push({ id: "empty", key: "2026-01-01:桐生:1", tag: "", records: [], snaps: {} });
scenarios.push({ id: "details-open", key: R0.key, tag: "", records: scored(R0, [["3連単", [1, 3, 2], 100]]), snaps: snap0, action: "document.querySelector('details.p-out') && (document.querySelector('details.p-out').open = true)" });
scenarios.push({ id: "next-focus", key: R0.key, tag: "", records: scored(R0, [["3連単", [1, 3, 2], 100]]), snaps: snap0, action: "document.querySelector('#nextBt') && document.querySelector('#nextBt').focus()" });

// ---- レースページの記録欄 ----
{
  const raceRoot = path.join(REPO, "race");
  const day = fs.existsSync(raceRoot) ? fs.readdirSync(raceRoot).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().pop() : null;
  const venue = day ? fs.readdirSync(path.join(raceRoot, day)).sort()[0] : null;
  if (day && venue) {
    const url = `/race/${day}/${venue}/1R.html`;
    const html = fs.readFileSync(path.join(raceRoot, day, venue, "1R.html"), "utf8");
    const snap = JSON.parse(/id="raceSnapshot">([\s\S]*?)<\/script>/.exec(html)[1].split("<\\/").join("</"));
    const before = `${day}T00:05:00.000+09:00`;              // その日の締切より前
    const after = new Date(Date.parse(before) + 2 * 86400000).toISOString();  // 締切後
    const rec = (i, tag, ken = "3連単", lanes = [1, 2, 3]) => ({ key: snap.key, ken, lanes, amount: 100 * (i + 1), tag, id: "r" + i, at: before });
    const ACT = (body) => `(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms)); const $ = (s) => document.querySelector(s); ${body} })()`;
    const openForm = "$('#yOpen').click(); await w(80);";
    scenarios.push({ id: "race:closed-button", url, now: before, records: [], snaps: {} });
    scenarios.push({ id: "race:open-form", url, now: before, records: [], snaps: {}, action: ACT(openForm) });
    scenarios.push({ id: "race:picked", url, now: before, records: [], snaps: {}, action: ACT(openForm +
      "$('.ychip[data-ken=\"2連単\"]').click(); await w(50); $('.ylane[data-lane=\"2\"]').click(); $('.ylane[data-lane=\"1\"]').click(); await w(50);" +
      "$('#yTag').value = '展示重視'; $('.yq[data-amt=\"500\"]').click(); await w(50);") });
    scenarios.push({ id: "race:saved", url, now: before, records: [], snaps: {}, action: ACT(openForm +
      "[3,1,2].forEach((n) => $(`.ylane[data-lane=\"${n}\"]`).click()); await w(50); $('#ySave').click(); await w(80); $('#yOpen').click(); await w(80);") });
    scenarios.push({ id: "race:tags", url, now: before, records: [rec(0, ""), rec(1, "1号艇軸", "2連複", [1, 2]), rec(2, "1号艇軸", "単勝", [4])], snaps: { [snap.key]: snap } });
    scenarios.push({ id: "race:after-deadline", url, now: after, records: [rec(0, ""), rec(1, "展示重視", "3連複", [1, 3, 5])], snaps: { [snap.key]: snap } });
    scenarios.push({ id: "race:too-many", url, now: before, snaps: { [snap.key]: snap },
      records: Array.from({ length: 30 }, (_, i) => ({ ...rec(i, ""), amount: 100 })),
      action: ACT(openForm + "[1,2,3].forEach((n) => $(`.ylane[data-lane=\"${n}\"]`).click()); await w(50); $('#ySave').click(); await w(80);") });
  }
}

// ---- Chrome(CDP) ----
const PORT = 9333;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "teiyomi-pxdiff-profile-"));
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-first-run",
  "--hide-scrollbars", "--force-device-scale-factor=1", "--font-render-hinting=none", "--disable-extensions", "about:blank",
], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pageWs = null;
for (let i = 0; i < 50 && !pageWs; i++) {
  await sleep(200);
  try { pageWs = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === "page")?.webSocketDebuggerUrl; } catch {}
}
const ws = new WebSocket(pageWs);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let seq = 0; const pending = new Map(); const waiters = [];
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); }
  else if (m.method) { for (const w of waiters.splice(0)) if (w.method === m.method) w.resolve(m.params); else waiters.push(w); }
});
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
const once = (method) => new Promise((resolve) => waiters.push({ method, resolve }));
await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");
await send("Network.setBlockedURLs", { urls: ["*cdn.jsdelivr.net*", "*supabase.co*"] });

const before = await serve(true), after = await serve(SAME);
const VIEWS = [{ w: 390, mobile: true }, { w: 1024, mobile: false }];
const SCHEMES = ["light", "dark"];

async function shoot(base, sc, view, scheme) {
  await send("Emulation.setDeviceMetricsOverride", { width: view.w, height: 900, deviceScaleFactor: 1, mobile: view.mobile });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
  const seed = `(() => {
    const F = Date.parse(${JSON.stringify(sc.now || NOW)}); const D = Date;
    class FD extends D { constructor(...a) { super(...(a.length ? a : [F])); } static now() { return F; } }
    window.Date = FD;
    try { localStorage.clear();
      localStorage.setItem("teiyomi_yomi_records", ${JSON.stringify(JSON.stringify(sc.records))});
      localStorage.setItem("teiyomi_yomi_snapshots", ${JSON.stringify(JSON.stringify(sc.snaps))}); } catch (e) {}
  })();`;
  const { identifier } = await send("Page.addScriptToEvaluateOnNewDocument", { source: seed });
  const loaded = once("Page.loadEventFired");
  const page = sc.url || `/yomi.html?key=${encodeURIComponent(sc.key)}&tag=${encodeURIComponent(sc.tag)}`;
  await send("Page.navigate", { url: base + page });
  await loaded;
  await send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
  await send("Runtime.evaluate", { expression: "document.fonts.ready.then(() => 1)", awaitPromise: true });
  await sleep(250);
  if (sc.action) { await send("Runtime.evaluate", { expression: sc.action, awaitPromise: true }); await sleep(250); }
  const { cssContentSize } = await send("Page.getLayoutMetrics");
  const h = Math.ceil(cssContentSize.height);
  await send("Emulation.setDeviceMetricsOverride", { width: view.w, height: h, deviceScaleFactor: 1, mobile: view.mobile });
  await sleep(150);
  const shot = (await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: view.w, height: h, scale: 1 } })).data;
  return { shot, h };
}

let same = 0; const diffs = [];
const origin = (s) => `http://127.0.0.1:${s.address().port}`;
for (const sc of scenarios) for (const view of VIEWS) for (const scheme of SCHEMES) {
  const a = await shoot(origin(before), sc, view, scheme);
  const b = await shoot(origin(after), sc, view, scheme);
  if (a.shot === b.shot && a.h === b.h) { same++; continue; }
  const tag = `${sc.id}@${view.w}-${scheme}`;
  const safe = tag.replace(/[^\w@.-]+/g, "_");
  fs.writeFileSync(path.join(OUT_DIR, safe + ".before.png"), Buffer.from(a.shot, "base64"));
  fs.writeFileSync(path.join(OUT_DIR, safe + ".after.png"), Buffer.from(b.shot, "base64"));
  diffs.push({ tag, height: [a.h, b.h] });
}
console.log(JSON.stringify({ compared: SAME ? "HEAD と HEAD" : `作業ツリー と ${REF}`, scenarios: scenarios.length,
  shots: same + diffs.length, identical: same, different: diffs.length, diffs: diffs.slice(0, 20),
  pngs: diffs.length ? OUT_DIR : null }, null, 1));
ws.close(); chrome.kill(); before.close(); after.close();
process.exit(diffs.length ? 1 : 0);
