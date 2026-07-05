# -*- coding: utf-8 -*-
"""
「モーターの前回使用者」を選び、motors.js に書き出す。

前回使用者の定義：同じ会場・同じモーター番号で、今の開催(今節)より前に、
最後にそのモーターを使っていた登番。モーターは節ごとの抽選で決まり、節の間は
同じ選手が使うため、1モーターにつき前回使用者は1人に定まる。

今日出走する選手が使っているモーター(会場×モーター番号)だけを対象にする
(全会場・全モーターの履歴を持つ必要は無い)。daily.ymlでfetch_update.pyの
直後に実行する前提。results.jsonlに「モ」(モーター番号)「名」(選手名)が
無い古い記録は自然に無視される(get()でNoneになるだけ)。
"""
import json, re
from collections import defaultdict
from build_profiles_v5 import load_fan_master

DATA_JS = "data.js"
RESULTS = "results.jsonl"
OUT = "motors.js"


def load_json_assignment(path):
    with open(path, encoding="utf-8") as f:
        s = f.read()
    m = re.search(r"=\s*([\[{].*[\]}])\s*;?\s*$", s, re.S)
    return json.loads(m.group(1))


def main():
    data = load_json_assignment(DATA_JS)

    # 今日、各会場でどのモーターが使われているか + その会場の今節開始日
    venue_kstart = {}
    venue_motors = defaultdict(set)
    for v in data["venues"]:
        venue_kstart[v["name"]] = v.get("kstart")
        for r in v["races"]:
            for b in r["boats"]:
                mno = b.get("mno")
                if mno is not None:
                    venue_motors[v["name"]].add(mno)

    if not venue_motors:
        print("[skip] 今日のデータに会場×モーターの情報が無い。motors.jsは更新しない。")
        return

    # results.jsonlを1回だけ走査し、対象の会場×モーターに関係する行だけ拾う
    history = defaultdict(list)   # (会場,モーター番号) -> [(date, 登番, 選手名), ...]
    with open(RESULTS, encoding="utf-8") as f:
        for line in f:
            try:
                r = json.loads(line)
            except Exception:
                continue
            v = r["会場"]
            motors_here = venue_motors.get(v)
            if not motors_here:
                continue
            date = r["date"]
            for x in r["結果"]:
                mno = x.get("モ")
                if mno is None or mno not in motors_here:
                    continue
                history[(v, mno)].append((date, x["登番"], x.get("名")))

    fan_master = load_fan_master()

    out = {}
    for v, motors in venue_motors.items():
        kstart = venue_kstart.get(v)
        for mno in motors:
            key = f"{v}:{mno}"
            entries = history.get((v, mno), [])
            if kstart:
                entries = [e for e in entries if e[0] < kstart]
            if not entries:
                out[key] = None
                continue
            entries.sort()
            date, touban, name = entries[-1]
            rec = {"touban": touban, "date": date, "name": name}
            fp = fan_master.get(touban)
            if fp:
                rec["k"] = fp.get("級別")
            out[key] = rec

    with open(OUT, "w", encoding="utf-8") as f:
        f.write("window.MOTORS = " + json.dumps(out, ensure_ascii=False) + ";\n")
    found = sum(1 for v in out.values() if v)
    print(f"[done] motors.js 更新: {len(out)}件(会場×モーター) / うち前回使用者が判明{found}件")


if __name__ == "__main__":
    # build_featured.pyと同じ考え方：想定外のエラーでdata.js更新のコミットまで
    # 止めたくないので、ここで受け止めて正常終了する(motors.jsは前日分が残るだけ)。
    try:
        main()
    except Exception as e:
        print(f"[warn] モーター前回使用者の算出に失敗、motors.jsは更新しない: {e}")
