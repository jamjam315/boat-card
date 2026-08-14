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
  store/store_NN_*.png     Claude Design製の枠。端末部分がプレースホルダで空いている
store-final/
  NN-*.png                 枠に実スクショをはめ込んだ本命 1080x2400
  9x16/NN-*.png            同じものを9:16(1350x2400)に収めた版。左右に地の色を足しただけ
  thumb/NN-*.png           幅320pxの縮小版(一覧での見え方を確かめる用)
```

ストアに載せるのは store-final/ の8枚。screenshots/light と screenshots/dark は
枠なしの素材で、枠を使わない場合の予備。素材を混ぜて使わないこと
(枠あり・枠なしが並ぶと同じアプリに見えなくなる)。

## 作り直しかた

```
pip install playwright pillow
python -m playwright install chromium

pip install opencv-python numpy        # 枠へのはめ込みに使う

python make_app_icons.py      # アイコン一式(サイトのPWAアイコンも同時に更新される)
python make_store_assets.py   # フィーチャーグラフィックと、枠なしスクリーンショット
python make_store_frames.py   # 枠に実スクショをはめ込んだ store-final/ 一式
```

`make_store_frames.py` は枠のPNGからプレースホルダの位置を毎回測り直す。
枠を差し替えても座標を書き換える必要はない。8枚が同じテンプレでなくなった場合は
その場で止まる(黙ってずれた位置に貼らないため)。

スクリーンショットは本番URL(https://teiyomi.com)から撮る。
そのため、サイトの見た目を変えたら撮り直しが要る。
ログインが要る画面は撮らない(審査用の画像に個人のアカウント情報を写さないため)。

どちらのスクリプトもCI(daily.yml / results.yml)には入れていない。
毎晩動かす必要がなく、Pillow・Playwright・日本語フォントを
GitHub Actions 側に用意する手間だけが増えるため。
