# -*- coding: utf-8 -*-
"""
競走成績(K)パーサー  ―― 拡張版
公式の結果ファイル（固定長テキスト, cp932）から取り出す。

【従来からの項目（そのまま維持）】
  着順・艇番・進入コース・スタートタイミング・レースタイム・登番・選手名

【今回あらたに拾う項目】
  レース単位: 天候・風向・風速(m)・波高(cm)・決まり手
  艇単位   : 展示タイム（掴んでいたのに捨てていた分を復活）
  払戻     : 単勝・複勝・2連単・2連複・拡連複・3連単・3連複（人気も分かるものは付記）
             ※ 各会場ブロック冒頭の[払戻金]早見表(3連単/3連複/2連単/2連複のみの一覧)は
               レース単位の払戻と二重取りになるため使わず、各レースの着順表の直後に
               続く払戻行だけを正として読む。

※ 既存の呼び出し側（collect_results.py / build_stats.py）を壊さないよう、
   これまでのキー名は一切変えず、新しいキーを「追加」しただけ。

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
# レース見出し: "1R 予選 ... H1800m 晴 風 南西 2m 波 1cm" （結果ファイルは半角R）
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

# 結果ヘッダ行（この行の末尾に決まり手が入っている）
#   例) "  着 艇 登番 ...ﾚｰｽﾀｲﾑ 逃げ　　　"
HEADER = re.compile(r'着\s*艇\s*登番')

# 決まり手として認めるもの（長いものから順に照合する）
KIMARITE = ["まくり差し", "抜き", "逃げ", "差し", "まくり", "恵まれ"]

# 払戻ラベル(Kファイル上の全角表記) → results.jsonlに書き出すキー(半角数字)
PAYOUT_LABELS = {
    "単勝": "単勝",
    "複勝": "複勝",
    "２連単": "2連単",
    "２連複": "2連複",
    "拡連複": "拡連複",
    "３連単": "3連単",
    "３連複": "3連複",
}
_PAYOUT_LABEL_KEYS = sorted(PAYOUT_LABELS.keys(), key=len, reverse=True)

# 払戻1件分: 組番(例 "2" / "2-4" / "2-4-1")  金額  (人気があれば付く)
PAYOUT_ENTRY = re.compile(r'([0-9]+(?:-[0-9]+)*)\s+([0-9]+)(?:\s+人気\s*(\d+))?')


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


def parse_weather(line):
    """レース見出し行から 天候・風向・風速・波高 を取り出す。
    取れなかった項目は None。書式が違う年でも落ちないよう緩めに拾う。
    """
    # 全角スペースを半角に均して扱いやすくする
    s = line.replace("\u3000", " ")
    out = {"天候": None, "風向": None, "風速": None, "波高": None}

    # 天候：晴 / 曇り / 雨 / 雪 / 霧。"風"の手前にある。
    # 「曇り」のように送り仮名が付く年もあるので許容し、"曇" に正規化する。
    mw = re.search(r'(晴|曇り|曇|雨|雪|霧)\s*風', s)
    if not mw:
        # 保険：距離(...m)と"風"の間にある語を天候とみなす（未知の書式対策）
        mw = re.search(r'\dm\s+(\S+?)\s*風', s)
    if mw:
        t = mw.group(1)
        out["天候"] = "曇" if t.startswith("曇") else t

    # 風向 + 風速：  "風  南西  2m"  /  "風  無風 0m" など
    md = re.search(r'風\s*([東西南北]+|無風|無)\s*(\d+)\s*m', s)
    if md:
        kaze = md.group(1)
        out["風向"] = "無風" if kaze in ("無", "無風") else kaze
        out["風速"] = int(md.group(2))
    else:
        # 風向が空でも風速だけ拾えるように保険
        ms = re.search(r'風\D*?(\d+)\s*m', s)
        if ms:
            out["風速"] = int(ms.group(1))

    # 波高： "波  1cm"
    mh = re.search(r'波\s*(\d+)\s*cm', s)
    if mh:
        out["波高"] = int(mh.group(1))

    return out


def parse_kimarite(header_line):
    """結果ヘッダ行の末尾から決まり手を取り出す。無ければ None。"""
    s = header_line.replace("\u3000", " ")
    # "ﾚｰｽﾀｲﾑ" より後ろに決まり手がある
    tail = s.split("ﾚｰｽﾀｲﾑ")[-1].strip()
    for k in KIMARITE:
        if k in tail:
            return k
    return None


def match_payout_label(line):
    # 行頭の払戻ラベル(単勝/複勝/２連単等)を判定する。
    # 見つかれば (results.jsonl用キー, ラベルより後ろの文字列) を返す。
    # 無ければ (None, line) を返す(前の行から続く継続行の可能性がある)。
    s = line.lstrip("　 ")
    for label in _PAYOUT_LABEL_KEYS:
        if s.startswith(label):
            return PAYOUT_LABELS[label], s[len(label):]
    return None, line


def parse_results(path):
    lines = open(path, encoding="cp932").read().splitlines()
    races, jcd, jname, cur = [], None, None, None
    active_payout = None  # 払戻の継続行(ラベル省略の行)がどの券種に属するか
    for line in lines:
        mv = VENUE.match(line)
        if mv:
            jcd = mv.group(1); jname = JCD.get(jcd, jcd)
            active_payout = None
            continue

        mr = RACE.match(line)
        # レース見出しは結果ヘッダの前。締切や電話の行は除外
        if mr and "電話" not in line and "締切" not in line and ("m" in line):
            weather = parse_weather(line)
            cur = {"会場コード": jcd, "会場": jname,
                   "レース番号": int(mr.group(1)),
                   "天候": weather["天候"], "風向": weather["風向"],
                   "風速": weather["風速"], "波高": weather["波高"],
                   "決まり手": None,          # 直後のヘッダ行で埋める
                   "結果": [],
                   "払戻": {v: [] for v in PAYOUT_LABELS.values()}}
            races.append(cur)
            active_payout = None
            continue

        # 結果ヘッダ行なら、決まり手を今のレースに入れる
        if cur is not None and HEADER.search(line):
            k = parse_kimarite(line)
            if k:
                cur["決まり手"] = k
            continue

        mres = RESULT.match(line)
        if mres and cur is not None:
            chaku, tei, touban, name, mo, bo, tenji, course, st, rt = mres.groups()
            stype, sval = parse_st(st)
            # 展示タイムは "6.92" のような文字列。数値化できないときは None。
            try:
                tenji_v = float(tenji)
            except (TypeError, ValueError):
                tenji_v = None
            cur["結果"].append({
                "着順": int(chaku), "艇番": int(tei), "登番": touban,
                "選手名": name.replace("\u3000", "").strip(),
                "進入コース": int(course),
                "ST種別": stype, "ST": sval,
                "展示": tenji_v,          # ← 復活させた項目
                "モーター番号": int(mo),  # ← 今回復活させた項目(前回使用者の割り出しに使う)
                "レースタイム": rt,
            })
            continue

        # 払戻行(着順6艇がそろった直後だけを対象にする。会場冒頭の払戻早見表は
        # まだ6艇そろっていない時点に出てくるためここには入らず、二重取りを避けられる)
        if cur is not None and len(cur["結果"]) == 6:
            if not line.strip():
                active_payout = None
                continue
            label, rest = match_payout_label(line)
            if label is not None:
                active_payout = label
            elif active_payout is not None:
                rest = line
            else:
                continue
            for m in PAYOUT_ENTRY.finditer(rest):
                kumi, kingaku, ninki = m.groups()
                entry = {"組": kumi, "金額": int(kingaku)}
                if ninki is not None:
                    entry["人気"] = int(ninki)
                cur["払戻"][active_payout].append(entry)
    # 6艇そろったレースだけ返す（中止・特殊レースを除外）
    return [r for r in races if len(r["結果"]) == 6]


if __name__ == "__main__":
    import sys
    races = parse_results(sys.argv[1] if len(sys.argv) > 1 else "K260629.TXT")
    print("有効レース数:", len(races))
    if races:
        r = races[0]
        print(f"\n{r['会場']} {r['レース番号']}R"
              f"  天候:{r['天候']} 風:{r['風向']}{r['風速']}m 波:{r['波高']}cm"
              f"  決まり手:{r['決まり手']}")
        for x in r["結果"]:
            st = f"{x['ST種別']}{x['ST']}" if x["ST"] is not None else x["ST種別"]
            print(f"  {x['着順']}着 {x['艇番']}号艇 {x['選手名']}"
                  f"  進入{x['進入コース']}  ST {st}  展示 {x['展示']}")
