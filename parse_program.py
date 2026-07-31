# -*- coding: utf-8 -*-
"""
番組表(B)パーサー  ステップ1
公式の固定長テキスト(.lzh解凍後, cp932)を、ラベル付きの構造化データ(JSON/CSV)に変換する。

【今節成績について】
勝率など8項目のあとに続く欄には、選手の「今節、これまでに走った各日の着順」が
1文字ずつ(古い日→新しい日の順)で入っている。数字(1-6)=着順、S=妨害、F=フライング、
K=欠場、空白(詰め物)は無視してよい。実データと公式サイトの表示を突き合わせて確認済み。
末尾の1文字は「今節成績」とは別の「早見」欄(意味は本パーサーでは未使用)。

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
# 級別より後ろ(勝率〜今節成績)は丸ごと rest として受け取り、parse_boat 側で分解する。
ROW = re.compile(
    r'^\s*([1-6])\s+'      # 艇番
    r'(\d{4})'             # 登番
    r'(.+?)'               # 選手名(全角スペース含む可)
    r'(\d{2})'             # 年齢
    r'(\D+?)'              # 支部
    r'(\d{2})'             # 体重
    r'(A[12]|B[12])\s+'    # 級別
    r'(.*)$'               # 勝率〜今節成績(生のまま)
)
# 全国勝率〜ボート2連率(8項目)を厳密に消費し、その後ろ(今節成績+早見)は生のまま残す。
TAIL = re.compile(r'^\s*(\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+)(.*)$')

RATE_LABELS = ["全国勝率", "全国2連率", "当地勝率", "当地2連率",
               "モーター番号", "モーター2連率", "ボート番号", "ボート2連率"]

VENUE = re.compile(r'^(\d{2})BBGN')
RACE  = re.compile(r'^[\s　]*([０-９]+)Ｒ')   # 全角レース番号

# レース見出し行(「レース条件」)から 種別・距離・進入固定 を取り出すための形。
#   例) "４Ｒ サンライズＹ 進入固定 Ｈ１８００ｍ 電話投票締切予定０９：５０"
#        ↑番号  ↑レース名   ↑中間部   ↑距離
# 「進入固定」はレース名そのものに含まれることがある(例「進入固定戦隊」)ため、
# レース名の直後〜距離の手前(中間部)にあるかどうかで判定する。名前に入っている
# だけのレースを進入固定戦と誤判定しないための線引き。
RACE_COND = re.compile(r'^[\s　]*[0-9０-９]+[RＲ][\s　]+(\S+)(.*?)[HＨ][\s　]*([0-9０-９]+)[\s　]*[mｍ]')
DAY   = re.compile(r'第[\s　]*([０-９]+)日')   # 開催の何日目か

KIMARITE_CODES = set("123456SFK")   # 今節成績で使われる文字(着順・妨害・フライング・欠場)
HAYAMI_WIDTH = 2   # 「早見」欄は右詰め・最大2桁の固定幅(実データで確認済み)


def parse_kon_shosei(tail):
    """今節成績+早見の生文字列(パディング込み)から、今節の着順推移(古い日→新しい日)を取り出す。
    早見欄はtailの右端2文字に右詰めで入っているので、それを除いた左側だけを今節成績として読む。
    """
    if not tail:
        return []
    body = tail[:-HAYAMI_WIDTH] if len(tail) > HAYAMI_WIDTH else ""
    return [c for c in body if c in KIMARITE_CODES]


def parse_boat(line):
    m = ROW.match(line)
    if not m:
        return None
    teiban, touban, name, age, branch, weight, klass, rest = m.groups()
    # 「xx.xx」の直後に番号が続き、間のスペースが無いケースがある(例:"11.63148"=モーター2連率11.63+ボート番号148)。
    # 8項目の区切りを壊さないよう、先にスペースを補う。
    rest = re.sub(r'(\d\.\d{2})(\d)', r'\1 \2', rest)
    mt = TAIL.match(rest)
    if not mt:
        return None
    rates, tail = mt.groups()
    rec = {
        "艇番": int(teiban),
        "登番": touban,
        "選手名": name.replace("　", "").strip(),
        "年齢": int(age),
        "支部": branch.replace("　", "").strip(),
        "体重": int(weight),
        "級別": klass,
    }
    for lab, v in zip(RATE_LABELS, rates.split()):
        rec[lab] = float(v) if "." in v else int(v)
    rec["今節着順"] = parse_kon_shosei(tail)   # 例: ["5","5","1","5","6"]
    return rec


def race_conditions(meta):
    """レース条件の文字列から (種別, 距離, 進入固定) を取り出す。

    朝の時点で分かるレースの属性はB票にしか無い(結果のK票は夜まで出ない)。
    条件アラート(保存した絞り込みと今日の出走表の照合)で、5bと同じ軸を
    朝に判定できるようにするために使う。

    種別の分類は parse_results.classify_race をそのまま使う。5bのしぼり込みと
    同じ分類でないと、「検証した条件」と「通知の条件」がずれてしまうため。

    読み取れない書式のときは、その項目だけ None を返す(推測で埋めない)。
    """
    from parse_results import classify_race
    m = RACE_COND.match(meta or "")
    if not m:
        return None, None, None
    name, middle, dist = m.group(1), m.group(2), m.group(3)
    try:
        distance = int(dist.translate(ZEN2HAN))
    except ValueError:
        distance = None
    return classify_race(name), distance, ("進入固定" in middle)


def parse_program(path):
    lines = open(path, encoding="cp932").read().splitlines()
    races = []
    jcd, jname, day = None, None, None
    cur = None
    for line in lines:
        mv = VENUE.match(line)
        if mv:
            jcd = mv.group(1)
            jname = JCD.get(jcd, jcd)
            day = None   # 新しい会場に入ったら、次に出てくる「第◯日」を拾い直す
            continue
        if day is None:
            md = DAY.search(line)
            if md:
                day = int(md.group(1).translate(ZEN2HAN))
        mr = RACE.match(line)
        if mr:
            rno = int(mr.group(1).translate(ZEN2HAN))
            meta = re.sub(r'[\s　]+', ' ', line).strip()
            締切 = re.search(r'締切予定([０-９：]+)', line)
            cur = {
                "会場コード": jcd, "会場": jname, "レース番号": rno,
                "開催日目": day,
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
    cols = ["会場", "レース番号", "開催日目", "締切予定", "艇番", "登番", "選手名", "年齢",
            "支部", "体重", "級別", "全国勝率", "全国2連率", "当地勝率",
            "当地2連率", "モーター番号", "モーター2連率", "ボート番号", "ボート2連率", "今節着順"]
    with open(f"{base}.csv", "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(cols)
        for r in races:
            for b in r["艇"]:
                row = {**r, **b}
                w.writerow([row.get(c, "") if c != "今節着順" else "".join(row.get(c, []))
                            for c in cols])
    print(f"\n→ {base}.json と {base}.csv を出力しました")
