# -*- coding: utf-8 -*-
"""
results.jsonl の読み書きを一箇所に集約するモジュール。

【経緯】単一ファイルのresults.jsonlが約198.7MBまで育ち、GitHubの単一ファイル
上限(100MB)を超えてpushできなくなった(2026-07-19)。これを受けて、年(暦年)
ごとのファイルに分割した。以後、results.jsonlという単一ファイルは存在しない。
results.jsonlを読み書きする全スクリプトは、このモジュール経由で行うこと
(年境界・複数ファイルをまたぐ扱いをここに集約し、各スクリプト側で
個別にファイル一覧を組み立てないようにするため)。

【置き場所】
  results/{年}.jsonl   例: results/2023.jsonl, results/2024.jsonl, ...
  2026-07-26に、この results/ は main から data ブランチへ移した(GitHub Pagesの
  公開サイト1GB上限への対応)。実際にどこを見るかは data_paths.py が決める。

【中身・形式】
  1行1レースのJSON Lines。フィールドは分割前のresults.jsonlと完全に同じ
  (date/会場/レース番号/天候/風向/風速/波高/決まり手/払戻/結果)。
  年をまたいでも、レコードの中身・重複排除キー(date:会場:レース番号)の
  考え方は一切変えていない。
"""
import glob, json, os
import data_paths

RESULTS_DIR = os.path.join(data_paths.DATA_ROOT, "results")


def year_of(date_iso):
    return date_iso[:4]


def year_file_path(year):
    return os.path.join(RESULTS_DIR, f"{year}.jsonl")


def all_year_files():
    """存在する年ファイルを年の昇順で返す。"""
    paths = glob.glob(os.path.join(RESULTS_DIR, "[0-9][0-9][0-9][0-9].jsonl"))
    return sorted(paths)


def exists():
    return os.path.isdir(RESULTS_DIR) and len(all_year_files()) > 0


def iter_records():
    """全年ファイルを跨いで、レコード(dict)を1件ずつ返す。
    壊れた行は静かに無視する(既存コードの挙動を踏襲)。

    データが1件も無いまま静かに進むと、集計結果が空のまま stats.js や
    backtest-data/ を上書きしてしまう(=サイトを壊す)。置き場所の指定ミスを
    黙って通さないよう、ディレクトリごと無い場合はここで明示的に止める。"""
    if not os.path.isdir(RESULTS_DIR):
        raise FileNotFoundError(data_paths.missing_message("results"))
    for path in all_year_files():
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    yield json.loads(line)
                except Exception:
                    continue


def load_all_records():
    return list(iter_records())


def open_year_file_append(date_iso):
    """指定日付が属する年のファイルを追記モードで開く(無ければ作る)。
    呼び出し側で with 文を使ってクローズすること。"""
    os.makedirs(RESULTS_DIR, exist_ok=True)
    return open(year_file_path(year_of(date_iso)), "a", encoding="utf-8")
