// 艇読みの Service Worker。役割は「通知の受け口」だけに絞っている。
//
// 【オフラインキャッシュを意図的に入れていない理由】
// 艇読みは毎朝データが入れ替わるサイト(data.js・レースページ・backtest-data)。
// ここでページやJSONをキャッシュすると、「昨日の出走表が出たまま気づかない」
// 「バックテストの集計だけ古い」といった、利用者から見て何が起きているか
// 分からない事故を招く。キャッシュ戦略を正しく作り込むこと自体は可能だが、
// 誤ったデータを見せるくらいなら通信して待つほうがこのサイトの性質に合う。
// そのため fetch イベントは一切扱わない(=通信は今までどおりブラウザ任せ)。
// この判断を変える場合は、少なくとも data.js とレースページを
// network-first にしてからにすること。
//
// 【現時点(工程0)では通知は一切出ない】
// push を受け取る土台を用意しただけで、購読(subscribe)する導線も
// VAPID鍵も、送信側の仕組みもまだ無い。購読が存在しない以上、
// push イベントが配信されることもない。中身は工程2で実装する。

// 新しい sw.js を置いたら、古いものを待たずに差し替える。
// キャッシュを持たないので、途中で入れ替わっても表示に影響しない。
self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

// ---- 通知の受け口(骨組み。中身は工程2) ----

self.addEventListener('push', function (event) {
  // 工程2で、送られてきたJSON(会場・レース番号・締切時刻など)を読んで
  // showNotification する。今は購読者が存在しないためここには到達しない。
  // 何もしないまま抜けると、ブラウザによっては「サイトが更新されました」の
  // 既定の通知が出ることがあるため、将来ここを空のままにはしないこと。
  if (!event.data) return;
});

self.addEventListener('notificationclick', function (event) {
  // 通知をタップしたら、既に開いている艇読みのタブがあればそれを前面に、
  // 無ければ新しく開く。通知に url が入っていればその画面へ。
  event.notification.close();
  var target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].url.indexOf(self.registration.scope) === 0 && 'focus' in list[i]) {
          return list[i].focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});
