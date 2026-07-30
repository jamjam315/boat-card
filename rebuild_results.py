# -*- coding: utf-8 -*-
"""
results/{年}.jsonl を新パーサーで作り直す(フェーズB、2026-07-26)。

【なぜ作り直すのか】
公式K票には入っているのに取り込んでいなかった項目がある:
  レース単位: レース名・種別(優勝戦/準優勝戦/予選/一般/その他)・距離
  艇単位   : ボート番号・レースタイム
加えて、2025-07-05〜2026-05-05に取り込んだ42,601レース(全体の8.3%)には、
当時のパーサーが拾っていなかった「モーター番号」「選手名」が入っていない。
作り直せばこの穴も同時に埋まる。

【前回の教訓 = 生データを捨てない】
K票の生データを取り込み後に毎回消していたため、この作り直しに10年分の
再ダウンロード(実測で約12〜13時間)が必要になった。二度と繰り返さないよう、
今回からは raw/K/{年}/k{yymmdd}.lzh として圧縮のまま残す(B票と同じ流儀)。
2回目以降は raw/ にあるファイルを使うのでダウンロードは発生しない。

【安全のための作り】
- 出力先は results_new/{年}.jsonl。既存の results/ には一切触らない。
  照合が通ってから差し替える(差し替えは人の判断で、別途行う)。
- 途中で止まっても再開できる。完了した日付は results_new/_progress.txt に
  1行ずつ記録し、再実行時はそこに無い日付だけを処理する。
- 公式サーバーへの礼儀ウェイトは3秒(現行踏襲)。並列ダウンロードはしない。
  raw/ に既にある日はダウンロードしないのでウェイトも入れない。

使い方:
    python rebuild_results.py                       # 全期間(2016-07-05〜昨日)
    python rebuild_results.py 2016-07-05 2016-07-07 # 範囲を指定(パイロット用)
"""
import sys, os, glob, json, time, shutil, datetime, zoneinfo, subprocess
import urllib.request, urllib.error
from parse_results import parse_results, boat_record
import data_paths

JST = zoneinfo.ZoneInfo("Asia/Tokyo")
DATA_ROOT = data_paths.DATA_ROOT
RAW_DIR = os.path.join(DATA_ROOT, "raw", "K")
OUT_DIR = os.path.join(DATA_ROOT, "results_new")
TMP_DIR = os.path.join(DATA_ROOT, "_rebuild_tmp")
PROGRESS = os.path.join(OUT_DIR, "_progress.txt")
LOG_PATH = os.path.join(DATA_ROOT, "rebuild_results_log.txt")

DEFAULT_START = datetime.date(2016, 7, 5)
POLITE_WAIT = 3
DL_TRIES = 3
SEVENZIP = r"C:\Program Files\7-Zip\7z.exe"
MAX_CONSECUTIVE_FAILURES = 10   # ダウンロード失敗がこれだけ続いたら異常とみなして停止
MAX_CONSECUTIVE_EMPTY = 3       # 解凍できたのに0レースがこれだけ続いたら書式違いを疑う


def log(msg):
    line = f"{datetime.datetime.now(JST).strftime('%m-%d %H:%M:%S')} {msg}"
    print(line, flush=True)
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def load_progress():
    if not os.path.isfile(PROGRESS):
        return set()
    with open(PROGRESS, encoding="utf-8") as f:
        return {ln.strip() for ln in f if ln.strip()}


def mark_done(date_iso):
    with open(PROGRESS, "a", encoding="utf-8") as f:
        f.write(date_iso + "\n")


def raw_path(d):
    return os.path.join(RAW_DIR, d.strftime("%Y"), f"k{d.strftime('%y%m%d')}.lzh")


def download(d):
    """生データを raw/K/{年}/ へ保存する。既にあれば何もしない(=再開が速い)。
    戻り値: (パス or None, 実際にダウンロードしたか)"""
    dest = raw_path(d)
    if os.path.isfile(dest) and os.path.getsize(dest) > 0:
        return dest, False
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    url = f"https://www1.mbrace.or.jp/od2/K/{d.strftime('%Y%m')}/k{d.strftime('%y%m%d')}.lzh"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    tmp = dest + ".part"
    for i in range(DL_TRIES):
        try:
            with urllib.request.urlopen(req, timeout=30) as r, open(tmp, "wb") as f:
                f.write(r.read())
            os.replace(tmp, dest)   # 途中で落ちても中途半端なファイルを残さない
            return dest, True
        except urllib.error.HTTPError as e:
            if e.code == 404:
                log(f"  [skip] 公式に無い日 (404): {d}")
                return None, True
            log(f"  [warn] HTTP {e.code} 再試行 {i+1}/{DL_TRIES}: {d}")
        except Exception as e:
            log(f"  [warn] {e} 再試行 {i+1}/{DL_TRIES}: {d}")
        time.sleep(10)
    return None, True


def extract(lzh, d):
    """作業用の一時ディレクトリへ解凍し、テキストのパスを返す。"""
    if os.path.isdir(TMP_DIR):
        shutil.rmtree(TMP_DIR, ignore_errors=True)
    os.makedirs(TMP_DIR, exist_ok=True)
    try:
        subprocess.run([SEVENZIP, "x", "-y", f"-o{TMP_DIR}", lzh],
                       check=True, stdout=subprocess.DEVNULL)
    except FileNotFoundError:
        subprocess.run(["lhasa", "-xqw=" + TMP_DIR, lzh], check=True, stdout=subprocess.DEVNULL)
    hits = glob.glob(os.path.join(TMP_DIR, "[Kk]" + d.strftime("%y%m%d") + ".[Tt][Xx][Tt]"))
    return hits[0] if hits else None


def to_record(date_iso, r):
    """results/{年}.jsonl の1行の形。既存のキー・順序をそのまま維持し、
    新しいキー(レース名・種別・距離・ボ・RT)を足しただけにしてある。"""
    return {
        "date": date_iso, "会場": r["会場"], "レース番号": r["レース番号"],
        "天候": r.get("天候"), "風向": r.get("風向"),
        "風速": r.get("風速"), "波高": r.get("波高"),
        "決まり手": r.get("決まり手"),
        "レース名": r.get("レース名"), "種別": r.get("種別"), "距離": r.get("距離"),
        "進入固定": r.get("進入固定"),
        "払戻": r.get("払戻"),
        "結果": [boat_record(x) for x in r["結果"]],
    }


def main():
    if len(sys.argv) > 2:
        start = datetime.date.fromisoformat(sys.argv[1])
        end = datetime.date.fromisoformat(sys.argv[2])
    else:
        start = DEFAULT_START
        end = datetime.datetime.now(JST).date() - datetime.timedelta(days=1)

    os.makedirs(OUT_DIR, exist_ok=True)
    done = load_progress()
    total_days = (end - start).days + 1
    log(f"[start] {start}〜{end} ({total_days}日) / 済み {len(done)}日 / 出力 {OUT_DIR}")
    log(f"        data root = {DATA_ROOT}")

    added_total = 0
    processed = 0
    downloaded = 0
    consecutive_fail = 0
    consecutive_empty = 0
    t0 = time.time()

    d = start
    while d <= end:
        date_iso = d.isoformat()
        if date_iso in done:
            d += datetime.timedelta(days=1)
            continue

        lzh, did_dl = download(d)
        if did_dl:
            downloaded += 1
        if not lzh:
            # 404(非開催日)は正常。連続失敗が続く場合だけ異常とみなす。
            consecutive_fail += 1
            if consecutive_fail >= MAX_CONSECUTIVE_FAILURES:
                log(f"[STOP] ダウンロード失敗が{MAX_CONSECUTIVE_FAILURES}日連続。{d} で停止します。")
                return
            mark_done(date_iso)
            d += datetime.timedelta(days=1)
            if did_dl:
                time.sleep(POLITE_WAIT)
            continue
        consecutive_fail = 0

        txt = extract(lzh, d)
        if not txt:
            log(f"[STOP] 解凍後のテキストが見つかりません: {d}")
            return

        try:
            races = parse_results(txt)
        except Exception as e:
            log(f"[STOP] パースでエラー({d}): {e}")
            return

        if not races:
            consecutive_empty += 1
            log(f"  {date_iso}: 0レース(解凍は成功) 連続{consecutive_empty}回")
            if consecutive_empty >= MAX_CONSECUTIVE_EMPTY:
                log(f"[STOP] 0レースが{MAX_CONSECUTIVE_EMPTY}日連続。書式違いの疑いがあるため停止します。")
                return
        else:
            consecutive_empty = 0

        out_path = os.path.join(OUT_DIR, f"{d.strftime('%Y')}.jsonl")
        with open(out_path, "a", encoding="utf-8") as fout:
            for r in races:
                fout.write(json.dumps(to_record(date_iso, r), ensure_ascii=False) + "\n")
        added_total += len(races)
        processed += 1
        mark_done(date_iso)

        if processed % 30 == 0 or len(races) == 0:
            elapsed = time.time() - t0
            remain_days = (end - d).days
            speed = elapsed / max(processed, 1)
            eta = datetime.datetime.now(JST) + datetime.timedelta(seconds=speed * remain_days)
            log(f"  {date_iso}: {len(races)}レース (累計 {added_total:,}レース / "
                f"{processed}日処理 / 残り{remain_days}日 / 完了見込み {eta.strftime('%m-%d %H:%M')})")

        d += datetime.timedelta(days=1)
        if did_dl:
            time.sleep(POLITE_WAIT)

    shutil.rmtree(TMP_DIR, ignore_errors=True)
    log(f"[done] 完了。{processed}日処理 / {added_total:,}レース / "
        f"ダウンロード{downloaded}日 / 所要 {(time.time()-t0)/3600:.1f}時間")
    log(f"       出力: {OUT_DIR} (results/ はまだ差し替えていません)")


if __name__ == "__main__":
    main()
