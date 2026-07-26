# データの置き場所（main と data の2ブランチ構成）

2026-07-26 に、**ブラウザが直接読まないデータを `data` ブランチへ移しました。**

## なぜ分けたか

GitHub Pages の公開サイトには **1GB の上限**があります。公開対象が 864MB
（`results/` 673MB ＋ `backtest-data/` 140MB）まで育ち、年 186MB のペースで
増えるため、8〜9か月で上限に達する見込みでした。

Pages が公開するのは `main` ブランチだけなので、`main` から外せば公開サイトは
軽くなり、データは GitHub 上に従来どおり残ります。

## どちらに何があるか

| ブランチ | 中身 | 誰が読むか |
|---|---|---|
| `main` | サイト一式（HTML/JS/画像）、Pythonスクリプト、**`backtest-data/`** | ブラウザ（Pagesが公開） |
| `data` | `results/`（レース結果）、`program/`（番組表）、`raw/`（公式の生データ） | ビルド用スクリプトだけ |

**`backtest-data/` は `main` に残しています。** 5b（条件指定バックテスト）が
ブラウザから直接 fetch するため、`data` へ移すと 5b が動かなくなります。

## ローカルでの準備（1回だけ）

```bash
git worktree add F:\dev\boat-card-data data
```

これで `F:\dev\boat-card-data` に `data` ブランチが展開されます。
`data_paths.py` が「隣の `../boat-card-data`」を自動で見つけるので、
**環境変数の設定は不要**です。バックフィル（`backfill_*.py`）や
`collect_results.py` を手元で動かすと、この worktree 側に書かれます。

別の場所に置きたいときだけ、環境変数で指定します。

```bash
set TEIYOMI_DATA_ROOT=D:\somewhere\boat-card-data
```

### 手元で追記したデータを反映する

`data` ブランチの worktree でコミット・push します（`main` とは別のブランチ
なので、サイト側のコミットとぶつかりません）。

```bash
cd F:\dev\boat-card-data
git add -A results/
git commit -m "backfill 20XX"
git push origin data
```

`backtest-data/` を作り直す必要がある場合は、そのあと `main` 側で実行します。

```bash
cd F:\dev\boat-card
python build_backtest_custom.py
git add -A backtest-data/ && git commit -m "backtest-data 再生成" && git push
```

**以前必要だった「results 先行方式」（results だけ先にコミットして rebase して
から backtest-data を作り直す手順）は不要になりました。** 衝突していた相手
（日次の自動コミット）と results/ が別ブランチに分かれたためです。

## CI（GitHub Actions）での扱い

両方のワークフローが `data` ブランチを `_data/` に checkout し、
環境変数 `TEIYOMI_DATA_ROOT` でそこを指しています。

- `daily.yml`（毎朝）… `program/` `raw/` を `data` へ、`data.js` 等を `main` へ
- `results.yml`（毎晩）… `results/` を `data` へ、`backtest-data/` `stats.js` 等を `main` へ

どちらも「データが揃っているか確認」ステップを持ち、`_data/results/*.jsonl` が
10ファイル未満なら**そこで停止**します。置き場所の指定ミスで中身が空のまま
`stats.js` や `backtest-data/` を上書きコミットする事故を防ぐためです。

## 元に戻したくなったら

`main` から3ディレクトリを消したコミットを `git revert` すれば復元されます。
履歴は書き換えていないので、過去のコミットからも従来どおり取り出せます。
