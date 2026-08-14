# store-assets — Google Play 提出用の画像

サイトの一部ではない。ここのファイルはどこからもリンクしておらず、
`sitemap.xml` にも載せず、`robots.txt` で `Disallow` にしている
(GitHub Pages はリポジトリの中身をそのまま配るので、URLとしては存在する)。

## 中身

```
icon/
  play-icon-512.png        ストア掲載アイコン。512x512・透過なし・角丸なしの全面画像
  preview-circle.png       ↓ 確認用。アダプティブ版を3種のマスクで抜いたもの
  preview-rounded.png         赤い円がセーフゾーン(必ず見える範囲)
  preview-squircle.png
feature/
  feature-graphic-1024x500.png
screenshots/
  light/NN-*.png           素撮り 1080x2400(テーマ=翠)
  light/captioned/NN-*.png 上部に説明帯を足した版
  dark/…                   同上(テーマ=夜の水面)
```

ストアに載せるのは light / dark のどちらか一方に揃えること
(混ぜると同じアプリに見えなくなる)。

## 作り直しかた

```
pip install playwright pillow
python -m playwright install chromium

python make_app_icons.py      # アイコン一式(サイトのPWAアイコンも同時に更新される)
python make_store_assets.py   # フィーチャーグラフィックとスクリーンショット
```

スクリーンショットは本番URL(https://teiyomi.com)から撮る。
そのため、サイトの見た目を変えたら撮り直しが要る。
ログインが要る画面は撮らない(審査用の画像に個人のアカウント情報を写さないため)。

どちらのスクリプトもCI(daily.yml / results.yml)には入れていない。
毎晩動かす必要がなく、Pillow・Playwright・日本語フォントを
GitHub Actions 側に用意する手間だけが増えるため。
