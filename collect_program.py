# -*- coding: utf-8 -*-
"""
番組表(B票)を日次で履歴保存するスクリプト。毎朝のワークフローで
fetch_update.py の直後に実行する。

保存するものは2つ:
  1. raw/B/{年}/b{yymmdd}.lzh … 公式の生データを圧縮のまま(保険)
  2. program/{年}.jsonl       … parse_program.py が読み取れる全項目(すぐ使える形)

【なぜ生データも残すのか】
結果(K票)は生テキストを取り込み後に毎回捨てていたため、後から「レース種別も
欲しい」となったときに10年分を再ダウンロードするしかなく、その所要が約13時間と
判明した(1年分の実測が約74分)。同じことをB票で繰り返さないための保険。
lzhは平均31KB/日=年11MBと小さく、既に圧縮済みなのでそのまま置くのが最も安い。

【公式サーバーへの配慮】
fetch_update.py が既に同じ日のlzhをダウンロード・解凍しているので、
作業ディレクトリに残っていればそれを使い、二重ダウンロードはしない。
単独で動かしたときだけ自分で取得する。

【冪等性】
同じ日に何度実行しても program/{年}.jsonl に同じレースは二重に入らない
("date:会場:レース番号" で判定)。raw/ は同名ファイルを上書きするだけ。
毎朝のワークフローは07:30と08:30の2回動く(取得失敗時の再挑戦)ため、
この性質は必須。

【同じ日でもB票は差し替わることがある(実測で確認)】
2026-07-26に13分あけて2回取得したところ、公式のb260726.lzhは30,298→30,307
バイトに変わっていた(選手変更・欠場などで日中に差し替えられる)。この結果:
  program/ … その日いちばん最初に取り込んだ内容が残る(以後は重複スキップ)
  raw/     … いちばん最後に取得した内容で上書きされる
つまり通常運用では「program=07:30時点の番組表 / raw=08:30時点の最新版」になる。
検証用途では「朝の時点で分かっていた情報」であるprogram側が適切なので、この
非対称はそのまま許容する(rawはあくまで再パース用の保険なので、より新しい=
より正確な版が残るほうが望ましい)。両者を厳密に一致させたくなった場合は、
raw側も「既にあれば上書きしない」に変えること。

使い方:
    python collect_program.py                # 今日(JST)ぶん
    python collect_program.py 2026-07-26     # 日付を指定(手動の取りこぼし補填用)
"""
import sys, os, glob, json, shutil, time, datetime, zoneinfo, subprocess
import urllib.request, urllib.error
from parse_program import parse_program
import program_store
import data_paths

JST = zoneinfo.ZoneInfo("Asia/Tokyo")
BASE_DIR = data_paths.DATA_ROOT   # 保存先は data ブランチ側(data_paths.py が決める)
RAW_DIR = os.path.join(BASE_DIR, "raw", "B")
DL_TRIES = 3

# parse_program.py のラベル → program/{年}.jsonl での短いキー。
# results/{年}.jsonl の結果[] と同じ「短くするが読めば分かる」流儀に揃える。
BOAT_KEYS = [
    ("艇番", "艇"), ("登番", "登番"), ("選手名", "名"), ("級別", "級"),
    ("年齢", "年齢"), ("支部", "支部"), ("体重", "体重"),
    ("全国勝率", "全国"), ("全国2連率", "全国2"),
    ("当地勝率", "当地"), ("当地2連率", "当地2"),
    ("モーター番号", "モ"), ("モーター2連率", "モ2"),
    ("ボート番号", "ボ"), ("ボート2連率", "ボ2"),
]


def today_jst():
    return datetime.datetime.now(JST).date()


def download(url, dest, tries=DL_TRIES):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    for i in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=30) as r, open(dest, "wb") as f:
                f.write(r.read())
            return True
        except urllib.error.HTTPError as e:
            if e.code == 404:
                print(f"[info] まだ公開されていない可能性 (404): {url}")
                return False
            print(f"[warn] HTTP {e.code} 再試行 {i+1}/{tries}")
        except Exception as e:
            print(f"[warn] {e} 再試行 {i+1}/{tries}")
        time.sleep(10)
    return False


def extract(lzh):
    """lzhを解凍する。CI(Ubuntu)はlhasa、手元のWindowsは7-Zipを使う。"""
    for cmd in (["lhasa", "-xqw=.", lzh],
                [r"C:\Program Files\7-Zip\7z.exe", "x", "-y", lzh]):
        try:
            subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL)
            return True
        except FileNotFoundError:
            continue   # そのツールが無い環境なので次を試す
        except subprocess.CalledProcessError as e:
            print(f"[warn] 解凍に失敗({cmd[0]}): {e}")
            return False
    print("[warn] 解凍ツール(lhasa / 7-Zip)が見つかりません。")
    return False


def ensure_files(d):
    """その日のlzhとtxtを用意する。fetch_update.pyが残したものがあれば再利用する。
    戻り値: (lzhのパス or None, txtのパス or None)"""
    yyyymm, yymmdd = d.strftime("%Y%m"), d.strftime("%y%m%d")
    lzh = f"b{yymmdd}.lzh"

    if not os.path.isfile(lzh):
        url = f"https://www1.mbrace.or.jp/od2/B/{yyyymm}/b{yymmdd}.lzh"
        print(f"[info] 作業ディレクトリにlzhが無いので取得します: {url}")
        if not download(url, lzh):
            return None, None
    else:
        print(f"[info] 既にある {lzh} を再利用します(二重ダウンロードしない)")

    txts = glob.glob("[Bb]" + yymmdd + ".[Tt][Xx][Tt]")
    if not txts:
        if not extract(lzh):
            return lzh, None
        txts = glob.glob("[Bb]" + yymmdd + ".[Tt][Xx][Tt]")
    return lzh, (txts[0] if txts else None)


def save_raw(lzh, d):
    """生データを raw/B/{年}/b{yymmdd}.lzh へ保存する(同名は上書き=冪等)。"""
    out_dir = os.path.join(RAW_DIR, d.strftime("%Y"))
    os.makedirs(out_dir, exist_ok=True)
    dest = os.path.join(out_dir, os.path.basename(lzh))
    shutil.copyfile(lzh, dest)
    return dest


def to_record(date_iso, r):
    """parse_programの1レースを program/{年}.jsonl の1行の形に整える。"""
    boats = []
    for b in r["艇"]:
        rec = {}
        for src, dst in BOAT_KEYS:
            rec[dst] = b.get(src)
        # 今節着順は ["4","6","4","1","3"] のような配列。1文字1日なので文字列に畳む。
        rec["今節"] = "".join(b.get("今節着順") or [])
        boats.append(rec)
    return {
        "date": date_iso,
        "会場": r["会場"],
        "レース番号": r["レース番号"],
        "開催日目": r.get("開催日目"),
        "締切予定": r.get("締切予定"),
        "レース条件": r.get("レース条件"),
        "艇": boats,
    }


def append_races(date_iso, races):
    """program/{年}.jsonl へ追記する。既にあるレースは飛ばす(冪等)。
    戻り値: (追加した件数, 重複で飛ばした件数, 6艇そろっていない件数)"""
    keys = program_store.keys_of_year(program_store.year_of(date_iso))
    added = skipped = incomplete = 0
    with program_store.open_year_file_append(date_iso) as fout:
        for r in races:
            key = f'{date_iso}:{r["会場"]}:{r["レース番号"]}'
            if key in keys:
                skipped += 1
                continue
            keys.add(key)
            if len(r["艇"]) != 6:
                # 6艇そろわない行は元データ側の事情(発売中止等)。捨てずに残し、
                # 件数だけ報告する(生データも raw/ にあるので後から検証できる)。
                incomplete += 1
            fout.write(json.dumps(to_record(date_iso, r), ensure_ascii=False,
                                  separators=(",", ":")) + "\n")
            added += 1
    return added, skipped, incomplete


def main():
    if len(sys.argv) > 1:
        d = datetime.date.fromisoformat(sys.argv[1])
    else:
        d = today_jst()
    date_iso = d.isoformat()
    print(f"[info] 対象日: {date_iso} / {data_paths.describe()}")

    lzh, txt = ensure_files(d)
    if not lzh:
        print(f"[NG] {date_iso}: B票を取得できませんでした。")
        sys.exit(1)

    raw_path = save_raw(lzh, d)
    raw_size = os.path.getsize(raw_path)
    print(f"[info] 生データ保存: {os.path.relpath(raw_path, BASE_DIR)} ({raw_size:,} bytes)")

    if not txt:
        print(f"[NG] {date_iso}: 解凍後のテキストが見つからず、program/ に追記できません。")
        sys.exit(1)

    races = parse_program(txt)
    if not races:
        print(f"[NG] {date_iso}: レースが0件です(非開催か書式変更の疑い)。")
        sys.exit(1)

    added, skipped, incomplete = append_races(date_iso, races)
    print(f"[info] program/{program_store.year_of(date_iso)}.jsonl: "
          f"+{added}レース(重複スキップ {skipped} / 6艇未満 {incomplete})")

    # ---- 保存漏れ検知(この行だけ見れば今日の保存が成功したか分かる) ----
    saved = program_store.count_for_date(date_iso)
    raw_ok = os.path.isfile(raw_path) and raw_size > 0
    prog_ok = saved > 0
    print(f"[check] {date_iso} raw={'OK' if raw_ok else 'NG'}({raw_size:,}B) "
          f"program={'OK' if prog_ok else 'NG'}({saved}レース)")
    if not (raw_ok and prog_ok):
        sys.exit(1)


if __name__ == "__main__":
    main()
