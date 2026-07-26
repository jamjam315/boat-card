# -*- coding: utf-8 -*-
"""
データ本体(results/ program/ raw/)がどこにあるかを決める、唯一の場所。

【なぜ分けたのか】
GitHub Pagesの公開サイトには1GBの上限がある。results/だけで673MBまで育ち、
年186MBのペースで増えるため、8〜9か月で上限に達する見込みだった。
ブラウザが直接読まないデータ(results/ program/ raw/)を data ブランチへ移し、
mainには公開に必要なものだけを置くようにした(2026-07-26)。
backtest-data/ は5b(条件指定バックテスト)がブラウザから直接fetchするので
mainに残してある。ここでいう「データ本体」には含まない。

【探す順番】
  1. 環境変数 TEIYOMI_DATA_ROOT があればそこ (CIはこれで _data を指す)
  2. リポジトリ直下に results/ があればそこ (分離前の構成でもそのまま動く)
  3. 隣り合わせの ../boat-card-data (ローカルの既定のworktree置き場)
  4. どれも無ければリポジトリ直下 (この場合、読み込み側が明示的にエラーを出す)

【ローカルでの用意のしかた】
  git worktree add F:\\dev\\boat-card-data data
これで 3. に該当し、環境変数を設定しなくてもバックフィル等がそのまま動く。
別の場所に置きたい場合だけ TEIYOMI_DATA_ROOT を設定する。
"""
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SIBLING_DIR = os.path.join(os.path.dirname(BASE_DIR), "boat-card-data")


def _resolve():
    env = os.environ.get("TEIYOMI_DATA_ROOT")
    if env:
        return os.path.abspath(env)
    if os.path.isdir(os.path.join(BASE_DIR, "results")):
        return BASE_DIR
    if os.path.isdir(os.path.join(SIBLING_DIR, "results")):
        return SIBLING_DIR
    return BASE_DIR


DATA_ROOT = _resolve()


def describe():
    """どこを見ているかを1行で返す(スクリプトのログ用)。"""
    return f"data root = {DATA_ROOT}"


def missing_message(subdir):
    """データが見つからないときに出す、次の一手が分かるメッセージ。"""
    return (
        f"{subdir}/ が見つかりません (探した場所: {DATA_ROOT})。\n"
        f"データ本体は data ブランチにあります。次のどちらかを行ってください:\n"
        f"  1) git worktree add {SIBLING_DIR} data\n"
        f"  2) 環境変数 TEIYOMI_DATA_ROOT に data ブランチの作業ディレクトリを指定する\n"
        f"詳しくは DATA.md を参照。"
    )
