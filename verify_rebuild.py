# -*- coding: utf-8 -*-
"""
作り直した results_new/{年}.jsonl を、現行の results/{年}.jsonl と機械照合する。

【何を確認するか】
1. レースの取りこぼし・増減が無いこと(キー = date:会場:レース番号)
2. 既存の全キー・全値が完全に一致すること
   ただし 2025-07-05〜2026-05-05 の42,601レースは、当時のパーサーが
   モーター番号(モ)・選手名(名)を拾っていなかったため旧側に欠けている。
   この2キーは「旧に無い」場合だけ差分として数え、不一致とはしない
   (穴埋めできたことの確認として件数を報告する)。
3. 新しく増えたキー(レース名・種別・距離・ボ・RT)が入っていること

使い方:
    python verify_rebuild.py                # results_new にある全年を照合
    python verify_rebuild.py 2016 2026      # 年を指定
"""
import sys, os, json, glob, collections
import data_paths

DATA_ROOT = data_paths.DATA_ROOT
OLD_DIR = os.path.join(DATA_ROOT, "results")
NEW_DIR = os.path.join(DATA_ROOT, "results_new")

# 旧レコードのトップレベルキー(この5つが今回の新規追加)
NEW_TOP_KEYS = ["レース名", "種別", "距離", "進入固定"]
NEW_BOAT_KEYS = ["ボ", "RT"]
# 欠損期間で旧側に無いことが分かっているキー
FILLABLE_BOAT_KEYS = ["モ", "名"]


def key_of(r):
    return f'{r["date"]}:{r["会場"]}:{r["レース番号"]}'


def load(path):
    out = {}
    if not os.path.isfile(path):
        return out
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            out[key_of(r)] = r
    return out


def compare_year(year):
    old = load(os.path.join(OLD_DIR, f"{year}.jsonl"))
    new = load(os.path.join(NEW_DIR, f"{year}.jsonl"))
    if not new:
        return None

    stat = collections.Counter()
    diffs = []
    filled = collections.Counter()

    only_old = set(old) - set(new)
    only_new = set(new) - set(old)
    stat["旧のみ"] = len(only_old)
    stat["新のみ"] = len(only_new)

    for k in sorted(set(old) & set(new)):
        o, n = old[k], new[k]
        stat["照合"] += 1
        # --- トップレベル ---
        for f in o:
            if f in NEW_TOP_KEYS:
                continue
            if f == "結果":
                continue
            if o[f] != n.get(f):
                diffs.append((k, f, o[f], n.get(f)))
        # --- 艇ごと ---
        if len(o["結果"]) != len(n["結果"]):
            diffs.append((k, "結果の艇数", len(o["結果"]), len(n["結果"])))
            continue
        for i, (ob, nb) in enumerate(zip(o["結果"], n["結果"])):
            for f in ob:
                if ob[f] != nb.get(f):
                    diffs.append((k, f"結果[{i}].{f}", ob[f], nb.get(f)))
            for f in FILLABLE_BOAT_KEYS:
                if f not in ob and f in nb:
                    filled[f] += 1
        # --- 新キーが入っているか ---
        for f in NEW_TOP_KEYS:
            if f not in n:
                diffs.append((k, f"新キー欠落:{f}", "-", "-"))
        for f in NEW_BOAT_KEYS:
            if f not in n["結果"][0]:
                diffs.append((k, f"新キー欠落:結果[0].{f}", "-", "-"))
        if len(diffs) > 200:
            break
    return stat, diffs, filled, new


def main():
    years = sys.argv[1:] or sorted(
        os.path.basename(p)[:4] for p in glob.glob(os.path.join(NEW_DIR, "[0-9][0-9][0-9][0-9].jsonl")))
    if not years:
        print(f"results_new/ に年ファイルがありません: {NEW_DIR}")
        return

    total = collections.Counter()
    total_filled = collections.Counter()
    all_diffs = []
    kinds = collections.Counter()
    dists = collections.Counter()

    for y in years:
        res = compare_year(y)
        if res is None:
            print(f"{y}: results_new に無し(スキップ)")
            continue
        stat, diffs, filled, new = res
        total.update(stat)
        total_filled.update(filled)
        all_diffs.extend(diffs[:20])
        for r in new.values():
            kinds[r.get("種別")] += 1
            dists[r.get("距離")] += 1
        mark = "OK " if not diffs else "NG "
        print(f"{mark}{y}: 照合{stat['照合']:>7,}件 / 旧のみ{stat['旧のみ']} / 新のみ{stat['新のみ']}"
              f" / 不一致{len(diffs)}")

    print("\n================ まとめ ================")
    print(f"照合したレース: {total['照合']:,}")
    print(f"旧にしか無い  : {total['旧のみ']}   (0であるべき)")
    print(f"新にしか無い  : {total['新のみ']}   (欠損日の埋め戻し等で増える場合あり)")
    print(f"値の不一致    : {len(all_diffs)}")
    if all_diffs:
        print("\n-- 不一致の例(最大20件) --")
        for k, f, a, b in all_diffs[:20]:
            print(f"  {k}  {f}\n     旧: {a!r}\n     新: {b!r}")
    print(f"\n穴埋めできた項目(旧に無く新にある): {dict(total_filled)}")
    print(f"種別の内訳: {dict(kinds.most_common())}")
    print(f"距離の内訳: {dict(dists.most_common())}")


if __name__ == "__main__":
    main()
