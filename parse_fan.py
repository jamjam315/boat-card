# -*- coding: utf-8 -*-
"""
「モーターボートファン手帳」(fan)パーサー。
公式の固定長テキスト(.lzh解凍後, cp932, 1行=1選手・403バイト)を構造化データに変換する。

レイアウトは公式仕様(boatrace.jp/owpc/pc/extra/data/layout.html)を実データと
1文字ずつ突き合わせて検証済み(生年月日→年齢の逆算、コース別進入回数の合計→出走回数、
の2点が完全一致することで確認)。全角項目は「バイト数/2」の文字数で切り出す。

fanは年2回(前期=10月分算出/後期=4月分算出)しか更新されないため、毎朝バッチとは
別枠で、期の切り替わりのタイミングだけ実行すればよい軽い処理。

ダウンロードURL: https://boatrace.jp/static_extra/pc_static/download/data/kibetsu/fan{YYMM}.lzh
  例: fan2604.lzh = 2026年後期用(2026年4月末までの実績を集計)

使い方:
    python parse_fan.py fan2604.txt
"""
import re
import sys
import json

JCD = {
    "01": "桐生", "02": "戸田", "03": "江戸川", "04": "平和島", "05": "多摩川",
    "06": "浜名湖", "07": "蒲郡", "08": "常滑", "09": "津", "10": "三国",
    "11": "びわこ", "12": "住之江", "13": "尼崎", "14": "鳴門", "15": "丸亀",
    "16": "児島", "17": "宮島", "18": "徳山", "19": "下関", "20": "若松",
    "21": "芦屋", "22": "福岡", "23": "唐津", "24": "大村",
}

WAREKI = {"M": 1868, "T": 1912, "S": 1926, "H": 1989, "R": 2019}   # 元号→西暦換算の基準年-1

ACCIDENT_CODES = ["F", "L0", "L1", "K0", "K1", "S0", "S1", "S2"]


def to_int(s, default=None):
    s = s.strip()
    if not s or not s.lstrip("-").isdigit():
        return default
    return int(s)


def to_rate(s, digits, default=None):
    """右詰め数字文字列を小数に変換。例: "0466"(digits=2)→4.66"""
    n = to_int(s)
    if n is None:
        return default
    return round(n / (10 ** digits), digits)


def parse_line(line):
    if len(line) < 403:
        return None
    pos = 0

    def take(n):
        nonlocal pos
        v = line[pos:pos + n]
        pos += n
        return v

    touban = take(4)
    name_kanji = take(8).replace("　", "").strip()
    name_kana = take(15).strip()
    branch = take(2).strip()
    klass = take(2).strip()
    era = take(1)
    birth_raw = take(6)
    sex = take(1)
    age = to_int(take(2))
    height = to_int(take(3))
    weight = to_int(take(2))
    blood = take(2).strip()
    win_rate = to_rate(take(4), 2)
    place_rate = to_rate(take(4), 1)
    win1_all = to_int(take(3))
    win2_all = to_int(take(3))
    starts_all = to_int(take(3))
    take(2)   # 優出回数
    take(2)   # 優勝回数
    avg_st_all = to_rate(take(3), 2)

    course = {}
    for c in range(1, 7):
        entries = to_int(take(3))
        c_place = to_rate(take(4), 1)
        c_st = to_rate(take(3), 2)
        c_st_rank = to_rate(take(3), 2)
        course[c] = {"n": entries, "p2": c_place, "st": c_st, "st_rank": c_st_rank}

    prev_klass = take(2).strip()
    prev2_klass = take(2).strip()
    take(2)   # 前々々期級
    prev_index = to_rate(take(4), 2)
    cur_index = to_rate(take(4), 2)
    year = take(4)
    term = take(1)
    period_from = take(8)
    period_to = take(8)
    take(3)   # 養成期

    for c in range(1, 7):
        chaku = [to_int(take(3)) for _ in range(6)]
        acc = {code: to_int(take(2)) for code in ACCIDENT_CODES}
        course[c]["chaku"] = chaku   # [1着,2着,3着,4着,5着,6着]回数
        course[c]["acc"] = acc

    take(2); take(2); take(2); take(2)   # コースなしL0,L1,K0,K1
    hometown = take(3).replace("　", "").strip()

    # 生年月日: 元号1文字+2桁年+2桁月+2桁日
    birth = None
    m = to_int(birth_raw[0:2]) if len(birth_raw) >= 6 else None
    if era in WAREKI and m is not None:
        y = WAREKI[era] + m
        mm, dd = birth_raw[2:4], birth_raw[4:6]
        birth = f"{y}-{mm}-{dd}"

    if not touban.strip().isdigit():
        return None

    return {
        "登番": touban, "氏名": name_kanji, "カナ": name_kana, "支部": branch,
        "級別": klass, "前期級": prev_klass, "前々期級": prev2_klass,
        "生年月日": birth, "年齢": age, "身長": height, "体重": weight, "血液型": blood,
        "勝率": win_rate, "複勝率": place_rate, "1着回数": win1_all, "2着回数": win2_all,
        "出走回数": starts_all, "平均ST": avg_st_all,
        "前期能力指数": prev_index, "今期能力指数": cur_index,
        "算出年": to_int(year), "算出期": to_int(term),
        "算出期間": {"自": period_from, "至": period_to},
        "コース別": course, "出身地": hometown,
    }


def parse_fan(path):
    lines = open(path, encoding="cp932", errors="replace").read().splitlines()
    players = []
    for line in lines:
        p = parse_line(line)
        if p:
            players.append(p)
    return players


if __name__ == "__main__":
    path = sys.argv[1] if len(sys.argv) > 1 else "fan2604.txt"
    players = parse_fan(path)
    print(f"パース完了: {len(players)}選手")
    if players:
        sample = players[0]
        print("サンプル(1人目):")
        print(json.dumps(sample, ensure_ascii=False, indent=2))

    base = re.sub(r'\.[Tt][Xx][Tt]$', '', path.split('/')[-1])
    with open(f"{base}.json", "w", encoding="utf-8") as f:
        json.dump(players, f, ensure_ascii=False)
    print(f"\n→ {base}.json を出力しました")
