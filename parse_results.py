# -*- coding: utf-8 -*-
"""
競走成績(K)パーサー
公式の結果ファイル（固定長テキスト, cp932）から、1着〜6着の
着順・艇番・選手・進入コース・スタートタイミング・レースタイムを取り出す。

使い方:
    from parse_results import parse_results
    races = parse_results("K260629.TXT")
"""
import re

JCD = {
    "01": "桐生", "02": "戸田", "03": "江戸川", "04": "平和島", "05": "多摩川",
    "06": "浜名湖", "07": "蒲郡", "08": "常滑", "09": "津", "10": "三国",
    "11": "びわこ", "12": "住之江", "13": "尼崎", "14": "鳴門", "15": "丸亀",
    "16": "児島", "17": "宮島", "18": "徳山", "19": "下関", "20": "若松",
    "21": "芦屋", "22": "福岡", "23": "唐津", "24": "大村",
}
ZEN = str.maketrans("０１２３４５６７８９：", "0123456789:")

VENUE = re.compile(r'^(\d{2})KBGN')
# レース見出し: "1R 予選 ... H1800m 晴 風 ..." （結果ファイルは半角R）
RACE  = re.compile(r'^\s*(\d{1,2})R\s+(\S+)')
# 結果行: 着 艇 登番 選手名 ﾓｰﾀｰ ﾎﾞｰﾄ 展示 進入 ST ﾚｰｽﾀｲﾑ
RESULT = re.compile(
    r'^\s*(\d{2})\s+'      # 着順
    r'([1-6])\s+'          # 艇番
    r'(\d{4})\s+'          # 登番
    r'(.+?)\s+'            # 選手名
    r'(\d+)\s+'            # モーター番号
    r'(\d+)\s+'            # ボート番号
    r'([\d.]+)\s+'         # 展示タイム
    r'([1-6])\s+'          # 進入コース
    r'(\S+)'               # スタートタイミング（0.12 / F.01 / L など）
    r'(?:\s+(\S+))?'       # レースタイム（落水等は無い場合あり）
)

def parse_st(tok):
    """STを (種別, 値) に。'F.05'→('F',0.05) / '0.12'→('',0.12) / それ以外→(種別,None)"""
    t = tok.strip()
    if t.startswith("F"):
        m = re.search(r'(\d?\.\d+)', t)
        return ("F", float(m.group(1)) if m else None)
    if t.startswith("L"):
        return ("L", None)
    m = re.match(r'^0?(\.\d+)$', t)
    if m:
        return ("", float("0" + m.group(1)))
    return ("?", None)

def parse_results(path):
    lines = open(path, encoding="cp932").read().splitlines()
    races, jcd, jname, cur = [], None, None, None
    for line in lines:
        mv = VENUE.match(line)
        if mv:
            jcd = mv.group(1); jname = JCD.get(jcd, jcd); continue
        mr = RACE.match(line)
        # レース見出しは結果ヘッダの前。締切や電話の行は除外
        if mr and "電話" not in line and "締切" not in line and ("m" in line):
            cur = {"会場コード": jcd, "会場": jname,
                   "レース番号": int(mr.group(1)), "結果": []}
            races.append(cur); continue
        mres = RESULT.match(line)
        if mres and cur is not None:
            chaku, tei, touban, name, mo, bo, tenji, course, st, rt = mres.groups()
            stype, sval = parse_st(st)
            cur["結果"].append({
                "着順": int(chaku), "艇番": int(tei), "登番": touban,
                "選手名": name.replace("\u3000", "").strip(),
                "進入コース": int(course),
                "ST種別": stype, "ST": sval,
                "レースタイム": rt,
            })
    # 6艇そろったレースだけ返す（中止・特殊レースを除外）
    return [r for r in races if len(r["結果"]) == 6]

if __name__ == "__main__":
    import sys
    races = parse_results(sys.argv[1] if len(sys.argv) > 1 else "K260629.TXT")
    print("有効レース数:", len(races))
    if races:
        r = races[0]
        print(f"\n{r['会場']} {r['レース番号']}R の結果:")
        for x in r["結果"]:
            st = f"{x['ST種別']}{x['ST']}" if x["ST"] is not None else x["ST種別"]
            print(f"  {x['着順']}着 {x['艇番']}号艇 {x['選手名']}  進入{x['進入コース']}  ST {st}")
