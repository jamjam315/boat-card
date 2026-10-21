# -*- coding: utf-8 -*-
"""
過去の番組表(B票)を公式からまとめて取得し、手元のキャッシュに置く(2026-10-20・最初の一度だけ)。

  python scripts/fetch_program_archive.py fetch [--from 2016-07-05] [--to 2026-07-25]
  python scripts/fetch_program_archive.py parse        … 取得した lzh を program/{年}.jsonl に直す

【なぜ要るのか】
バックテストの「艇の材料」(全国勝率・級別・モーター2連率)は番組表にしか無い。番組表は
2026-07-26 から data ブランチに貯め始めたので、それより前の10年分は公式の過去分から取る。
全国勝率は結果から計算し直しても公式の値と合わない(一致10%・2026-10-20 調査)ので、
当時の番組表の値そのものを使う。

【置き場所】リポジトリの外(既定 F:/dev/boat-card-cache/)。git の履歴を増やさない。
  B/{年}/b{yymmdd}.lzh   … 公式の生データ(約3,700日・約110MB)
  program/{年}.jsonl     … collect_program.py と同じ形(build_bt_materials.py が読む)
過去の月の材料は一度作れば変わらないので、毎晩の CI はこれを使わない(今月分は data ブランチの
program/ にある)。材料の定義を変えて作り直すときだけ、手元でこのキャッシュから作る。
消えても公式から取り直せる。

【公式サーバーへの配慮】(2026-10-20 に robots.txt・サイトポリシーを確認)
robots.txt は全面許可。サイトポリシーが禁じているのは「大量の情報送受信及び大量のアクセスなど、
本サイトの運営に支障を与える行為」で、取得そのものは禁じていない。支障を与えないよう:
  - 1件ずつ順番に取る(並列にしない)。間隔は既定2秒
  - 取れなかったら30秒おいて2回まで。続けて失敗したら止める(相手が困っている印なので押さない)
  - 取得済みのファイルは取らない(途中で止めても、もう一度動かせば続きから)
  - 二重に動かさない(B/.lock を握れなければ、何もせずに終わる)。Windows のタスクスケジューラから
    1時間ごとに起動しても、前の回が動いているあいだは重ならない(2026-10-21)
  - 公式に無かった日(404・非開催日など)は B/missing.txt にその場で記録し、次からは取りに行かない
  - 全部取れたら B/done.txt に日数と欠けた日を書く(タスクを片付ける合図)
"""
import argparse
import datetime
import glob
import json
import os
import shutil
import sys
import tempfile
import time
import urllib.error
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)

CACHE = os.environ.get("TEIYOMI_PROGRAM_CACHE", "F:/dev/boat-card-cache")
URL = "https://www1.mbrace.or.jp/od2/B/{ym}/b{ymd}.lzh"
STOP_AFTER = 3          # 続けてこれだけ失敗したら止める


def hold_lock():
    """B/.lock を排他で握る。握れなければ None(ほかで取得中)。プロセスが終われば自動で外れる。
    ※ Windows では os.kill(pid, 0) で生存確認をすると相手を止めてしまうので、ファイルのロックを使う。"""
    os.makedirs(os.path.join(CACHE, "B"), exist_ok=True)
    f = open(os.path.join(CACHE, "B", ".lock"), "a+")
    try:
        if os.name == "nt":
            import msvcrt
            f.seek(0)
            msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        f.close()
        return None
    return f   # 開いたまま持っておく(閉じると外れる)


def known_missing():
    p = os.path.join(CACHE, "B", "missing.txt")
    if not os.path.isfile(p):
        return set()
    with open(p, encoding="utf-8") as f:
        return {line.strip() for line in f if line.strip()}


def lzh_path(d):
    return os.path.join(CACHE, "B", d.strftime("%Y"), f"b{d.strftime('%y%m%d')}.lzh")


def get(url):
    """1件取る。(状態, 中身)。状態は ok / missing(404) / error。"""
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return "ok", r.read()
    except urllib.error.HTTPError as e:
        return ("missing" if e.code == 404 else "error"), f"HTTP {e.code}"
    except Exception as e:
        return "error", f"{type(e).__name__}: {e}"


def remaining(a):
    """まだ取っていない日(公式に無いと分かっている日は除く)。"""
    skip = known_missing()
    d, end = datetime.date.fromisoformat(a.since), datetime.date.fromisoformat(a.until)
    out = []
    while d <= end:
        p = lzh_path(d)
        if not (os.path.isfile(p) and os.path.getsize(p) > 0) and d.isoformat() not in skip:
            out.append(d)
        d += datetime.timedelta(days=1)
    return out


def fetch(a):
    lock = hold_lock()
    if lock is None:
        print(f"[fetch] {datetime.datetime.now():%m/%d %H:%M} ほかで取得中のため、何もせずに終わります", flush=True)
        return
    todo = remaining(a)
    print(f"[fetch] {datetime.datetime.now():%m/%d %H:%M} {a.since}〜{a.until} のうち未取得 {len(todo)}日"
          f" / 間隔 {a.interval}秒 / 置き場所 {CACHE}", flush=True)
    fails = 0
    missing = []
    for i, d in enumerate(todo, 1):
        url = URL.format(ym=d.strftime("%Y%m"), ymd=d.strftime("%y%m%d"))
        for attempt in range(3):
            state, body = get(url)
            if state != "error":
                break
            print(f"[fetch] {d} {body} … 30秒おいてもう一度({attempt + 1}/2)", flush=True)
            time.sleep(30)
        if state == "ok":
            fails = 0
            p = lzh_path(d)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p + ".part", "wb") as f:
                f.write(body)
            os.replace(p + ".part", p)     # 書き終わってから名前を付ける(途中で止まっても壊れたファイルを残さない)
        elif state == "missing":
            fails = 0
            missing.append(d.isoformat())   # 非開催日など。その場で記録して、次からは取りに行かない
            with open(os.path.join(CACHE, "B", "missing.txt"), "a", encoding="utf-8") as f:
                f.write(d.isoformat() + "\n")
        else:
            fails += 1
            print(f"[fetch] {d} を取れませんでした: {body}", flush=True)
            if fails >= STOP_AFTER:
                sys.exit(f"[fetch] 続けて{STOP_AFTER}回失敗したので止めます。時間をおいて同じコマンドを動かせば続きから取ります。")
        if i % 100 == 0 or i == len(todo):
            print(f"[fetch] {i}/{len(todo)} ({d})", flush=True)
        time.sleep(a.interval)
    left = remaining(a)
    print(f"[fetch] 終わりました。この回で公式に無かった日 {len(missing)}日 / 残り {len(left)}日", flush=True)
    if not left:
        # 全部そろった。日数と欠けた日を残す(タスクスケジューラの片付けの合図にもなる)
        got = sum(1 for _ in glob.glob(os.path.join(CACHE, "B", "*", "b*.lzh")))
        miss = sorted(known_missing())
        with open(os.path.join(CACHE, "B", "done.txt"), "w", encoding="utf-8") as f:
            f.write(f"{datetime.datetime.now():%Y-%m-%d %H:%M} 取得 {got}日 / 公式に無かった日 {len(miss)}日\n")
            f.write("".join(m + "\n" for m in miss))
        print(f"[fetch] すべて取得済み: {got}日 / 公式に無かった日 {len(miss)}日 → B/done.txt", flush=True)


def parse(a):
    """lzh を解凍して parse_program にかけ、collect_program と同じ形で年ごとの jsonl に書く。"""
    from parse_program import parse_program
    import collect_program
    out_dir = os.path.join(CACHE, "program")
    os.makedirs(out_dir, exist_ok=True)
    years = sorted(os.listdir(os.path.join(CACHE, "B")))
    for y in [y for y in years if y.isdigit()]:
        files = sorted(glob.glob(os.path.join(CACHE, "B", y, "b*.lzh")))
        n_race = 0
        tmp_out = os.path.join(out_dir, f"{y}.jsonl.part")
        with open(tmp_out, "w", encoding="utf-8") as fout:
            for lzh in files:
                ymd = os.path.basename(lzh)[1:7]
                date_iso = f"20{ymd[:2]}-{ymd[2:4]}-{ymd[4:6]}"
                work = tempfile.mkdtemp(prefix="bprog-")
                try:
                    shutil.copyfile(lzh, os.path.join(work, os.path.basename(lzh)))
                    cwd = os.getcwd()
                    os.chdir(work)
                    try:
                        if not collect_program.extract(os.path.basename(lzh)):
                            print(f"[parse] {date_iso} 解凍できませんでした")
                            continue
                        txts = glob.glob("[Bb]" + ymd + ".[Tt][Xx][Tt]") or glob.glob("*.[Tt][Xx][Tt]")
                        races = parse_program(txts[0]) if txts else []
                    finally:
                        os.chdir(cwd)
                finally:
                    shutil.rmtree(work, ignore_errors=True)
                for r in races:
                    fout.write(json.dumps(collect_program.to_record(date_iso, r), ensure_ascii=False,
                                          separators=(",", ":")) + "\n")
                n_race += len(races)
        os.replace(tmp_out, os.path.join(out_dir, f"{y}.jsonl"))
        print(f"[parse] {y}: {len(files)}日 / {n_race:,}レース", flush=True)


def main():
    p = argparse.ArgumentParser(description="過去の番組表(B票)を手元のキャッシュに取る")
    sub = p.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("fetch")
    f.add_argument("--from", dest="since", default="2016-07-05")
    f.add_argument("--to", dest="until", default="2026-07-25")
    f.add_argument("--interval", type=float, default=2.0)
    sub.add_parser("parse")
    a = p.parse_args()
    fetch(a) if a.cmd == "fetch" else parse(a)


if __name__ == "__main__":
    main()
