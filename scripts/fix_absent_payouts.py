# -*- coding: utf-8 -*-
"""
欠場・出遅れのあったレースの払戻を、保存済みの results/{年}.jsonl に埋め直す(2026-09-17)。
1回きりの修復。何度流しても同じ結果になる(直し済みのレースは飛ばす)。

  python scripts/fix_absent_payouts.py          # 直して書き戻す
  python scripts/fix_absent_payouts.py --dry    # 数えるだけ(書き戻さない)

【何が起きていたか】
parse_results.py は「着順が6艇そろった直後」だけ払戻を読んでいた。欠場(K0/K1)・
出遅れ(L0/L1)の艇は結果表に進入・STの欄が無く結果として取れないので、そのレースは
5艇以下になり、払戻が丸ごと空になっていた。読み採点の払戻JSON(payouts/)では
「不成立」になり、そのレースの答案が採点されなかった。parse_results.py は同日に直した。

【何をするか】
対象は「結果が5艇以下・払戻が空・欠場キーがまだ無い」レースだけ。その日の生K票
(raw/K/{年}/k{yymmdd}.lzh)を直したパーサーで読み直し、
  - 結果[] が保存済みのものと完全に一致することを確かめてから
  - 払戻 と 欠場 だけを書き足す。
結果が一致しないレースは書き換えずに数だけ報告する。対象外の行は元の文字列のまま書き戻す。
"""
import glob
import json
import os
import shutil
import subprocess
import sys
import tempfile
from collections import Counter, defaultdict

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import data_paths  # noqa: E402
import results_store  # noqa: E402
from parse_results import parse_results, boat_record, absent_record  # noqa: E402

RAW_DIR = os.path.join(data_paths.DATA_ROOT, "raw", "K")
SEVENZIP = r"C:\Program Files\7-Zip\7z.exe"


def is_target(rec):
    return (len(rec.get("結果") or []) < 6 and "欠場" not in rec
            and not any((rec.get("払戻") or {}).values()))


def parse_day(date_iso):
    """その日の生K票を読み、(会場, レース番号) → レース の辞書を返す。無ければ None。"""
    yy, mm, dd = date_iso[2:4], date_iso[5:7], date_iso[8:10]
    lzh = os.path.join(RAW_DIR, date_iso[:4], f"k{yy}{mm}{dd}.lzh")
    if not os.path.isfile(lzh):
        return None
    tmp = tempfile.mkdtemp(prefix="fixabs_")
    try:
        try:
            subprocess.run([SEVENZIP, "x", "-y", f"-o{tmp}", lzh], check=True, stdout=subprocess.DEVNULL)
        except FileNotFoundError:
            subprocess.run(["lhasa", "-xqw=" + tmp, lzh], check=True, stdout=subprocess.DEVNULL)
        txts = glob.glob(os.path.join(tmp, "[Kk]*.[Tt][Xx][Tt]"))
        if not txts:
            return None
        return {(r["会場"], r["レース番号"]): r for r in parse_results(txts[0])}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def fix_year(path, dry):
    with open(path, encoding="utf-8") as f:
        lines = f.read().split("\n")
    targets = defaultdict(list)   # date → [行番号]
    for i, line in enumerate(lines):
        if not line.strip():
            continue
        rec = json.loads(line)   # 行末の \r は空白として読み飛ばされる
        if is_target(rec):
            targets[rec["date"]].append(i)

    st = Counter(targets=sum(len(v) for v in targets.values()))
    for date_iso in sorted(targets):
        day = parse_day(date_iso)
        if day is None:
            st["raw_missing"] += len(targets[date_iso])
            continue
        for i in targets[date_iso]:
            rec = json.loads(lines[i])
            p = day.get((rec["会場"], rec["レース番号"]))
            if p is None:
                st["race_missing"] += 1
                continue
            if [boat_record(x) for x in p["結果"]] != rec["結果"]:
                st["result_mismatch"] += 1
                continue
            if not p["欠場"]:
                st["no_absent"] += 1      # 5艇立てのレースなど。払戻が空のままなら本当に無い
            if not any(p["払戻"].values()):
                st["still_empty"] += 1
                continue
            rec["払戻"] = p["払戻"]
            if p["欠場"]:
                rec["欠場"] = [absent_record(x) for x in p["欠場"]]
            # 作業コピーの行末(CRLF/LF)は元の行に合わせる
            eol = "\r" if lines[i].endswith("\r") else ""
            lines[i] = json.dumps(rec, ensure_ascii=False) + eol
            st["fixed"] += 1

    if not dry and st["fixed"]:
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8", newline="\n") as f:
            f.write("\n".join(lines))
        os.replace(tmp, path)
    return st


def main():
    dry = "--dry" in sys.argv
    total = Counter()
    for path in results_store.all_year_files():
        st = fix_year(path, dry)
        total.update(st)
        print(f"{os.path.basename(path)}: {dict(st)}", flush=True)
    print(f"[{'dry' if dry else 'done'}] {dict(total)}")


if __name__ == "__main__":
    main()
