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
// 【通知の中身】
// 送信側(Edge Function send-morning-push)から
//   {"title": "...", "body": "...", "url": "https://teiyomi.com/"}
// のJSONが届く。中身の組み立ては全部サーバー側でやっているので、
// ここは受け取って表示するだけに徹する。

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
  // userVisibleOnly: true で購読しているため、pushを受けたら必ず通知を出す
  // 決まりになっている。出さないまま抜けると、ブラウザが代わりに
  // 「このサイトはバックグラウンドで更新されました」という既定の通知を出す。
  // そうならないよう、中身が読めなかった場合でも最低限の通知を出す。
  var payload = { title: '艇読み', body: '', url: '/' };
  if (event.data) {
    try {
      var d = event.data.json();
      payload.title = d.title || payload.title;
      payload.body = d.body || '';
      payload.url = d.url || '/';
    } catch (e) {
      payload.body = event.data.text();
    }
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      lang: 'ja',
      // 同じtagにしておくと、朝の便が二重に届いても通知が積み上がらず
      // 新しいほうで置き換わる(利用者から見て静か)。
      tag: 'teiyomi-morning',
      renotify: false,
      data: { url: payload.url }
    })
  );
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
