# -*- coding: utf-8 -*-
"""
program/{年}.jsonl(番組表=B票の日次履歴)の読み書きを一箇所に集約するモジュール。
results_store.py と対になる作り(置き場所・分割単位・重複排除キーの考え方を揃えている)。

【なぜ貯めるのか】
番組表にしかない項目(級別・年齢・支部・体重・全国/当地勝率・全国/当地2連率・
モーター2連率・ボート番号/2連率・今節着順・レース条件)は、これまで毎朝
data.jsを作った後に捨てていた(data.jsは上書き、レースページは7日で削除)。
そのため「A1級だけで検証する」「モーター2連率が高い艇に絞る」といった条件が
過去に遡って一切使えない。公式の過去B票を10年分あらためて収集するには
十数時間かかるため、まず今日から貯め始めて複利で増やす。

【置き場所】
  program/{年}.jsonl   例: program/2026.jsonl
  results/ と同じく data ブランチに置く(2026-07-26にmainから分離。GitHub Pagesの
  公開サイト1GB上限への対応)。実際にどこを見るかは data_paths.py が決める。

【中身・形式】1行1レースのJSON Lines。
  date        … 開催日(ISO)
  会場        … 会場名
  レース番号  … 1〜12
  開催日目    … 節の何日目か(取れない場合はnull)
  締切予定    … "10:52" 形式(取れない場合はnull)
  レース条件  … 見出し行そのまま(予選/準優勝戦/優勝戦・距離などが含まれる)
  艇[]        … 1艇=1要素。キーは results/{年}.jsonl の結果[] と同じ流儀で短くしている:
                艇(艇番) / 登番 / 名(選手名) / 級(級別 A1・A2・B1・B2) / 年齢 / 支部 /
                体重 / 全国(全国勝率) / 全国2(全国2連率) / 当地(当地勝率) /
                当地2(当地2連率) / モ(モーター番号) / モ2(モーター2連率) /
                ボ(ボート番号) / ボ2(ボート2連率) / 今節(今節着順を並べた文字列。
                例 "46413"。数字=着順、S=妨害、F=フライング、K=欠場)

【重複排除キー】results/ と同じ "date:会場:レース番号"。
"""
import glob, json, os
import data_paths

PROGRAM_DIR = os.path.join(data_paths.DATA_ROOT, "program")


def year_of(date_iso):
    return date_iso[:4]


def year_file_path(year):
    return os.path.join(PROGRAM_DIR, f"{year}.jsonl")


def all_year_files():
    """存在する年ファイルを年の昇順で返す。"""
    paths = glob.glob(os.path.join(PROGRAM_DIR, "[0-9][0-9][0-9][0-9].jsonl"))
    return sorted(paths)


def exists():
    return os.path.isdir(PROGRAM_DIR) and len(all_year_files()) > 0


def iter_records(year=None):
    """レコード(dict)を1件ずつ返す。yearを指定するとその年のファイルだけを読む。
    壊れた行は静かに無視する(results_store.pyと同じ作法)。"""
    paths = [year_file_path(year)] if year else all_year_files()
    for path in paths:
        if not os.path.isfile(path):
            continue
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    yield json.loads(line)
                except Exception:
                    continue


def keys_of_year(year):
    """その年のファイルに既に入っているレースのキー集合を返す。
    キーに日付が含まれるため、年をまたいだ突き合わせは不要
    (=毎朝、対象年の1ファイルだけ読めば重複判定ができる)。"""
    keys = set()
    for r in iter_records(year):
        try:
            keys.add(f'{r["date"]}:{r["会場"]}:{r["レース番号"]}')
        except Exception:
            pass
    return keys


def count_for_date(date_iso):
    """指定日のレコード件数。保存できたかどうかの確認に使う。"""
    n = 0
    for r in iter_records(year_of(date_iso)):
        if r.get("date") == date_iso:
            n += 1
    return n


def open_year_file_append(date_iso):
    """指定日付が属する年のファイルを追記モードで開く(無ければ作る)。
    呼び出し側で with 文を使ってクローズすること。"""
    os.makedirs(PROGRAM_DIR, exist_ok=True)
    return open(year_file_path(year_of(date_iso)), "a", encoding="utf-8")
