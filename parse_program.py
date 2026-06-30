# -*- coding: utf-8 -*-
"""
番組表(B)パーサー  ステップ1
公式の固定長テキスト(.lzh解凍後, cp932)を、ラベル付きの構造化データ(JSON/CSV)に変換する。

使い方:
    python3 parse_program.py B260629.TXT
"""
import re
import sys
import json
import csv

# 会場コード(01〜24) → 会場名
JCD = {
    "01": "桐生", "02": "戸田", "03": "江戸川", "04": "平和島", "05": "多摩川",
    "06": "浜名湖", "07": "蒲郡", "08": "常滑", "09": "津", "10": "三国",
    "11": "びわこ", "12": "住之江", "13": "尼崎", "14": "鳴門", "15": "丸亀",
    "16": "児島", "17": "宮島", "18": "徳山", "19": "下関", "20": "若松",
    "21": "芦屋", "22": "福岡", "23": "唐津", "24": "大村",
}

ZEN2HAN = str.maketrans("０１２３４５６７８９：", "0123456789:")

# 1選手ぶんの行(例: "1 4164岩永節也44長崎52B1 3.86 17.20 ...")
ROW = re.compile(
    r'^\s*([1-6])\s+'      # 艇番
    r'(\d{4})'             # 登番
    r'(.+?)'               # 選手名(全角スペース含む可)
    r'(\d{2})'             # 年齢
    r'(\D+?)'              # 支部
    r'(\d{2})'             # 体重
    r'(A[12]|B[12])\s+'    # 級別
    r'(.*)$'               # 勝率以降
)

RATE_LABELS = ["全国勝率", "全国2連率", "当地勝率", "当地2連率",
               "モーター番号", "モーター2連率", "ボート番号", "ボート2連率"]

VENUE = re.compile(r'^(\d{2})BBGN')
RACE  = re.compile(r'^[\s\u3000]*([０-９]+)Ｒ')   # 全角レース番号


def parse_boat(line):
    m = ROW.match(line)
    if not m:
        return None
    teiban, touban, name, age, branch, weight, klass, rest = m.groups()
    # 念のため 率(x.xx)と番号 がくっついていたら剥がす(古い形式対策)
    rest = re.sub(r'(\d\.\d{2})(\d)', r'\1 \2', rest)
    toks = rest.split()
    rec = {
        "艇番": int(teiban),
        "登番": touban,
        "選手名": name.replace("\u3000", "").strip(),
        "年齢": int(age),
        "支部": branch.replace("\u3000", "").strip(),
        "体重": int(weight),
        "級別": klass,
    }
    for i, lab in enumerate(RATE_LABELS):
        if i < len(toks):
            v = toks[i]
            rec[lab] = float(v) if "." in v else int(v)
    # 残り(今節成績など)は生のまま保持
    rec["今節成績_raw"] = " ".join(toks[len(RATE_LABELS):]).strip()
    return rec


def parse_program(path):
    lines = open(path, encoding="cp932").read().splitlines()
    races = []
    jcd, jname = None, None
    cur = None
    for line in lines:
        mv = VENUE.match(line)
        if mv:
            jcd = mv.group(1)
            jname = JCD.get(jcd, jcd)
            continue
        mr = RACE.match(line)
        if mr:
            rno = int(mr.group(1).translate(ZEN2HAN))
            meta = re.sub(r'[\s\u3000]+', ' ', line).strip()
            締切 = re.search(r'締切予定([０-９：]+)', line)
            cur = {
                "会場コード": jcd, "会場": jname, "レース番号": rno,
                "締切予定": 締切.group(1).translate(ZEN2HAN) if 締切 else None,
                "レース条件": meta, "艇": [],
            }
            races.append(cur)
            continue
        boat = parse_boat(line)
        if boat and cur is not None:
            cur["艇"].append(boat)
    return races


if __name__ == "__main__":
    path = sys.argv[1] if len(sys.argv) > 1 else "B260629.TXT"
    races = parse_program(path)

    venues = sorted({r["会場"] for r in races})
    boats = sum(len(r["艇"]) for r in races)
    full = sum(1 for r in races if len(r["艇"]) == 6)

    print(f"会場数        : {len(venues)}  ({'、'.join(venues)})")
    print(f"レース数      : {len(races)}")
    print(f"選手行(艇)    : {boats}")
    print(f"6艇そろった数 : {full}/{len(races)}")

    base = re.sub(r'\.[Tt][Xx][Tt]$', '', path.split('/')[-1])
    # JSON出力
    with open(f"{base}.json", "w", encoding="utf-8") as f:
        json.dump(races, f, ensure_ascii=False, indent=2)
    # CSV出力(1行=1艇)
    cols = ["会場", "レース番号", "締切予定", "艇番", "登番", "選手名", "年齢",
            "支部", "体重", "級別", "全国勝率", "全国2連率", "当地勝率",
            "当地2連率", "モーター番号", "モーター2連率", "ボート番号", "ボート2連率"]
    with open(f"{base}.csv", "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(cols)
        for r in races:
            for b in r["艇"]:
                w.writerow([r["会場"], r["レース番号"], r["締切予定"]] +
                           [b.get(c, "") for c in cols[3:]])
    print(f"\n→ {base}.json と {base}.csv を出力しました")
