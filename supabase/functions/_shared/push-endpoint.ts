// Web Push の宛先(push_subscriptions.endpoint)として送ってよいURL(2026-10-23 点検の中-2)。
//
// 【なぜ絞るのか】
// endpoint は本来ブラウザの通知サービスが発行するURLだが、DB には形の制限が無く、
// 匿名のアカウントでも任意のURLを自分の行として登録できる。応答しないサーバーを登録されると、
// 送信がそこで待ち続けて朝の便全体が止まりうる。主要ブラウザの通知サービスにだけ送る。
// 表に無い宛先には送らず、朝の便が Issue で知らせる(正規のブラウザが新しい通知サービスを
// 使い始めたら、そこで気づいて表に足す)。
//
// favorites.js も同じ表で、保存する前に確かめている。**ここを直したら favorites.js も直すこと。**
const HOSTS = new Set([
  'fcm.googleapis.com',                 // Chrome・Android・Opera・Samsung Internet など
  'updates.push.services.mozilla.com',  // Firefox
  'web.push.apple.com',                 // Safari(Mac・iPhone のホーム画面のアプリ)
])
// Edge(Windows の WNS)は地域ごとにホスト名が変わる(wns2-xx.notify.windows.com など)
const HOST_SUFFIXES = ['.notify.windows.com']

/** 送ってよい宛先か。https で、上の通知サービスのホストだけ。 */
export function isAllowedPushEndpoint(endpoint: unknown): boolean {
  if (typeof endpoint !== 'string') return false
  let u: URL
  try {
    u = new URL(endpoint)
  } catch {
    return false
  }
  if (u.protocol !== 'https:' || u.port !== '' || u.username !== '' || u.password !== '') return false
  const host = u.hostname.toLowerCase()
  return HOSTS.has(host) || HOST_SUFFIXES.some((s) => host.endsWith(s) && host.length > s.length)
}

/**
 * 1件の送信を待つ上限(ミリ秒)。web-push は timeout を渡さないと応答の無い宛先を待ち続ける
 * (3.6.7 で確認)。通知サービスはふだん1秒もかからない。
 */
export const PUSH_TIMEOUT_MS = 10000
