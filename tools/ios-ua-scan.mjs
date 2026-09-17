// iOSアプリの中で見たときに、出してはいけない文字とリンクが無いかを確かめる道具。
//
// ============================================================================
// 使い方
// ============================================================================
//
//   cd ~/dev/boat-card
//   npm i -D playwright && npx playwright install --with-deps chromium   … 初回だけ
//   node tools/ios-ua-scan.mjs              … 固定ページ＋生成ページの見本
//   node tools/ios-ua-scan.mjs --all-races  … レースページも全部(遅い。手元でだけ)
//
// CI（.github/workflows/ios-ua-scan.yml）が push のたびに回す。
//
// ============================================================================
// なぜ要るか
// ============================================================================
//
// iOSアプリの中身は teiyomi.com をそのまま出している。**出してはいけないものは
// HTMLから消えているのではなく、JS（ios.js / twa.js / app-links.js / billing-ios.js）が
// UAを見て出し分けている**。つまりHTMLをgrepしても分からず、実際に描かせて確かめるしかない。
//
//   ・他のストアの名前と、そこへのリンク（App Store Review Guideline 3.1.1）
//   ・「準備中」「開発中」（2.1 未完成のアプリと読まれる）
//   ・boatrace.jp へのリンク（5.2.2。殻の許可リストから外したので、押しても何も起きない）
//   ・許可リストに無い外部リンク（同上。アプリの中では開けない）
//
// ============================================================================
// 確かめ方
// ============================================================================
//
// 1. リポジトリをそのまま静的配信する（本番と同じファイル）
// 2. 殻と同じUA（TeiyomiIOS/1）で開く
// 3. 外への通信は全部遮る。**Supabase も遮る**ので、CIが本番に匿名ユーザーを作らない
// 4. 描き終わった本文とリンクを見て、禁止語・禁止リンクを探す
// 5. 最後に、**ブラウザのUAでは同じ語が出ること**も確かめる（出し分けが効いていない
//    ／JSが動いていないだけ、という「素通り」を見抜くため）
import { createServer } from 'node:http'
import { readFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 8899
const BASE = `http://127.0.0.1:${PORT}`
/** 本文がこれより短いページは「描けていない」とみなす。 */
const MIN_TEXT = 120

// lib/shell/user_agent.dart の userAgentMarker と一字一句そろえる。
const IOS_APP_MARKER = 'TeiyomiIOS/1'
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Mobile/15E148'

/** アプリの中に出てはいけない語。 */
export const BANNED_WORDS = [
  'Google Play', 'GooglePlay', 'Playストア', 'Play ストア', 'Google play',
  'Android', 'android',
  '準備中', '開発中',
  'ホーム画面に追加', 'ホーム画面へ追加',
  'ウェブサイトからのお申し込み',   // Web側の購入案内(ストア外への導線)
]

/**
 * 殻が開ける外部リンク。
 *
 * **正は teiyomi-ios の `lib/shell/external_allowlist.dart`**（実際に通す／通さないを
 * 決めているのはあちら）。ここはその写しなので、食い違うとこのスキャンが嘘をつく
 * （殻では開けないリンクを「問題なし」と言ってしまう）。
 * 食い違いは teiyomi-ios の `test/external_allowlist_sync_test.dart` が落として教える。
 * このファイルを直したら、あちらも直すこと（逆も同じ）。
 */
export const ALLOWED_EXTERNAL = [
  ['www.caa.go.jp', '/policies/policy/consumer_policy/caution/caution_012/'],
  ['x.com', '/intent/post'],
  ['openai.com', '/policies/row-privacy-policy/'],
  ['apps.apple.com', '/account/subscriptions'],
]

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml',
}

function serve() {
  const server = createServer(async (req, res) => {
    try {
      let path = decodeURIComponent((req.url || '/').split('?')[0])
      if (path.endsWith('/')) path += 'index.html'
      const file = join(ROOT, path)
      if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return }
      const body = await readFile(file)
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
      res.end(body)
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
    }
  })
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)))
}

/** 見に行くページ。固定ページ＋生成ページ（レース・選手・検証）の見本。 */
async function pages(allRaces) {
  const fixed = JSON.parse(await readFile(join(ROOT, 'site_pages.json'), 'utf8')).fixed
  const out = [...fixed]

  // レースページ。いちばん新しい日から、会場順に数本（--all-races で全部）。
  const dates = (await readdir(join(ROOT, 'race'))).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort()
  const latest = dates[dates.length - 1]
  if (latest) {
    const venues = (await readdir(join(ROOT, 'race', latest))).sort()
    for (const venue of allRaces ? venues : venues.slice(0, 2)) {
      const races = (await readdir(join(ROOT, 'race', latest, venue)))
        .filter((f) => f.endsWith('.html')).sort()
      for (const r of allRaces ? races : races.slice(0, 1)) out.push(`/race/${latest}/${venue}/${r}`)
    }
  }
  // 選手ページと検証ページも1枚ずつ（テンプレートが同じなので見本で足りる）。
  for (const [dir, n] of [['players', 2], ['checked', 1]]) {
    if (!existsSync(join(ROOT, dir))) continue
    const files = (await readdir(join(ROOT, dir))).filter((f) => f.endsWith('.html') && f !== 'index.html').sort()
    for (const f of files.slice(0, n)) out.push(`/${dir}/${f}`)
  }
  return out
}

/** 1ページ描いて、本文とリンクを取り出す。 */
async function render(context, url) {
  const page = await context.newPage()
  const blocked = []
  await page.route('**/*', (route) => {
    const target = new URL(route.request().url())
    // 外への通信は全部遮る。**Supabase を叩かせない**(CIが本番に匿名ユーザーを作らないため)。
    if (target.hostname !== '127.0.0.1') { blocked.push(target.host); return route.abort() }
    return route.continue()
  })
  await page.goto(BASE + url, { waitUntil: 'load', timeout: 30000 })
  // ios.js は DOMContentLoaded とその後の書き換えでも動く。少し待ってから読む。
  await page.waitForTimeout(700)
  const found = await page.evaluate(() => ({
    text: document.body ? document.body.innerText : '',
    links: Array.from(document.querySelectorAll('a[href]')).map((a) => ({
      href: a.href,
      text: (a.textContent || '').trim().slice(0, 40),
    })),
  }))
  await page.close()
  return { ...found, blocked }
}

function externalProblem(href) {
  let u
  try { u = new URL(href) } catch { return null }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null   // mailto: 等は殻が扱う
  if (u.hostname === '127.0.0.1') return null                          // 自分のページ
  const ok = ALLOWED_EXTERNAL.some(([host, path]) => u.hostname === host && u.pathname.startsWith(path))
  return ok ? null : `許可リストに無い外部リンク: ${u.host}${u.pathname}`
}

async function main() {
  const allRaces = process.argv.includes('--all-races')
  const { chromium } = await import('playwright')
  const server = await serve()
  const browser = await chromium.launch()
  const list = await pages(allRaces)
  const problems = []

  // ---- 1. アプリのUAで見る ----
  const app = await browser.newContext({ userAgent: `${IPHONE_UA} ${IOS_APP_MARKER}` })
  for (const url of list) {
    const { text, links } = await render(app, url)
    for (const word of BANNED_WORDS) {
      if (text.includes(word)) problems.push(`${url}: 禁止語「${word}」が出ている`)
    }
    for (const a of links) {
      const problem = externalProblem(a.href)
      if (problem) problems.push(`${url}: ${problem}（文字: ${a.text}）`)
    }
    // 真っ白なページを「禁止語なし」で通さない(描けていないだけ、を見抜く)。
    // いちばん短い正常なページは /yomi.html の「この端末に記録がありません」(約190字)。
    if (text.trim().length < MIN_TEXT) {
      problems.push(`${url}: 本文がほとんど無い(${text.trim().length}字)。描けていない可能性`)
    }
    process.stdout.write('.')
  }
  await app.close()
  process.stdout.write('\n')

  // ---- 2. 素通りしていないか（ブラウザのUAでは出ること） ----
  const web = await browser.newContext({ userAgent: IPHONE_UA })
  // 外への通信を遮っているので、**通信なしでも出るもの**で確かめる。
  // app-links.js がフッターに入れるストアのリンクがそれにあたる。
  const canary = [
    ['/', 'Google Play'],
    ['/about.html', 'Google Play'],
  ]
  for (const [url, word] of canary) {
    const { text } = await render(web, url)
    if (!text.includes(word)) {
      problems.push(`素通りの疑い: ${url} はブラウザで見ても「${word}」が出ない（出し分け以前にJSが動いていない可能性）`)
    }
  }
  await web.close()

  await browser.close()
  server.close()

  console.log(`\n見たページ: ${list.length}`)
  if (problems.length === 0) {
    console.log('✅ 禁止語・禁止リンクは見つからなかった')
    return
  }
  console.log(`✖ ${problems.length}件`)
  for (const p of problems) console.log('  - ' + p)
  process.exit(1)
}

// このファイルを直接動かしたときだけ走らせる（テストからは表だけを取り込む）。
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1) })
}
