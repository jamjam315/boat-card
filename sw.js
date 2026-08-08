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
// 送信側(Edge Function send-morning-push など)から
//   {"title": "...", "body": "...", "url": "https://teiyomi.com/mypage.html",
//    "tag": "teiyomi-morning"}
// のJSONが届く。中身の組み立ては全部サーバー側でやっているので、
// ここは受け取って表示するだけに徹する。
// tag は通知の「置き換え単位」。同じtagの通知は積み上がらず新しいほうで
// 置き換わるため、朝の便と「データ更新の遅れ」のように性質の違う通知は
// 別のtagで送る。省略された場合は従来どおり朝の便として扱う。

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
  var payload = { title: '艇読み', body: '', url: '/', tag: 'teiyomi-morning' };
  if (event.data) {
    try {
      var d = event.data.json();
      payload.title = d.title || payload.title;
      payload.body = d.body || '';
      payload.url = d.url || '/';
      // 送信側が種類を指定してきたらそれを使う。指定が無ければ従来どおり朝の便。
      if (d.tag) payload.tag = d.tag;
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
      // 種類が違う通知(データ更新の遅れ等)は別のtagで送り、朝の便を
      // 消してしまわないようにする。
      tag: payload.tag,
      renotify: false,
      data: { url: payload.url }
    })
  );
});

self.addEventListener('notificationclick', function (event) {
  // 通知をタップしたら、既に開いている艇読みのタブがあればそれを前面に、
  // 無ければ新しく開く。通知に url が入っていればその画面へ。
  //
  // 既存タブを前面に出すだけだと、トップを開きっぱなしの人は
  // 通知の行き先(マイページ)に着かない。そのため、行き先と違う画面を
  // 開いているタブは navigate() で行き先へ移してから前面に出す。
  event.notification.close();
  var target = (event.notification.data && event.notification.data.url) || '/';
  var targetUrl = new URL(target, self.registration.scope).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      var same = null;   // 既に行き先を開いているタブ
      var other = null;  // 艇読みの別の画面を開いているタブ
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (c.url.indexOf(self.registration.scope) !== 0 || !('focus' in c)) continue;
        if (c.url === targetUrl) { same = c; break; }
        if (!other) other = c;
      }
      if (same) return same.focus();
      if (other && 'navigate' in other) {
        // navigate() は環境によって失敗する(未対応・別オリジンへの遷移など)。
        // 失敗しても通知が無反応にならないよう、そのときは前面に出すだけにする。
        return other.navigate(targetUrl).then(function (c) {
          return (c || other).focus();
        }).catch(function () {
          return other.focus();
        });
      }
      if (other) return other.focus();
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
