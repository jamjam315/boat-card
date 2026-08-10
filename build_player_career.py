#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
選手(登番)ごとのキャリア推移を players/career/{登番}.json に書き出す。

【第1弾で入れるもの】
- 年ごとの出走数・1着数・2連対数・勝率・2連対率(results/ の実レース結果から)
- 級別の変遷(fan/ の期別ファイルから)
- generated_at(生成日時)

【第2弾で入れるもの(2026-07-30)…「勝ち方」の内訳】
- kimarite   1着したときの決まり手6種の件数
- courses    進入コース1〜6別の出走・1着・2連対と、そのコースでの決まり手内訳
- venues     会場別の出走・1着・2連対
- conditions 雨・強風(8m以上)・波高(15cm以上)の条件別
- finals     優勝戦・準優勝戦
- maezuke    前づけ(艇番と進入コースが違う)の出走・1着・2連対
- flying     年別のF(フライング)・L(出遅れ)の件数

【全国の基準値は共通ファイルに置く】
同じ集計を全選手ぶん合計したものを players/career/_national.json に書き出す。
選手JSONには埋めない。理由:
  - frames.js と同じ作法(基準値は共通ファイル、表示側は読むだけ。数値の直書きをしない)
  - 2,114選手に同じ値を複製すると無駄で、片方だけ古くなる事故が起きる
  - stats.js は直近1年の集計なので、全期間のキャリアと並べると期間が食い違う
  - 選手別と全国を同じループで作るので、定義のズレが構造的に起きない

【集計の定義(results再生成時の定義と完全に一致させる)】
- 出走数 = 全出走。完走しなくても(失格・転覆・フライング)出走は出走
- 1着・2連対 = 記録どおり(着==1 / 着<=2)。非完走(着=None)は数えない
- 決まり手 = その選手が1着で、かつレースに決まり手がある場合のみ数える
- 同着は除外しない(公式の結果どおり。同着1着は両者を1着として数える)

【入れないもの(意図的)】
順位・偏差値・スコア・「絶好調」等の評価語は一切入れない。ここは事実の数値だけを
出す層で、どう見せるか・どう注記するかは表示側の仕事。出走数が少ない年も
母数をそのまま出す(隠さない)。

【勝率について】
公式の「勝率」は着順に応じた得点の平均(1着10点…等)で、ここで出しているのは
「1着数 ÷ 出走数」。名前が同じでも中身が違うので、キー名を win_rate とし、
公式の勝率(fan由来)は別に class 側で持つ。表示側で取り違えないよう、
JSONにも rate_note を入れて意味を書いておく。

【級別の適用期間(実データで確認済み)】
fanYYMM は「審査期間」で算出され、適用はその約2か月後から6か月間:
  fanYY04(審査 前年11/01〜当年04/30) → 適用 当年07/01〜12/31
  fanYY10(審査 当年05/01〜10/31)     → 適用 翌年01/01〜06/30
確認方法: fan2604 の級別が2026-07-28のB票と864/864一致。さらに各fanの
「前期級」が1つ前の期の「級別」と100%一致することを21期で確認した。

入力:
  results/{年}.jsonl  … data ブランチ(data_paths が場所を決める)
  fan/{YYMM}.json     … 同上。collect_fan_history.py が作る
出力:
  players/career/{登番}.json … main側(将来ブラウザから読む前提の公開ファイル)
"""
import json, os, glob, datetime, collections
import results_store
import data_paths

OUT_DIR = os.path.join("players", "career")
FAN_DIR = os.path.join(data_paths.DATA_ROOT, "fan")
NATIONAL_PATH = os.path.join(OUT_DIR, "_national.json")
TITLES_PATH = os.path.join(OUT_DIR, "titles.json")

KIMARITE = ["逃げ", "差し", "まくり", "まくり差し", "抜き", "恵まれ"]

# 条件の線引き。いずれも「その条件のレースが十分あるか」を実データで見て決めている:
#   雨      … 全体の9.7%(49,984レース)。単独で成立する
#   強風8m〜… 8m以上は全体の約1.5%。7m以下は日常的すぎて「強風」と呼べない
#   波高15cm〜… 15cm以上は約0.6%。なお公式データは15cm以上が5cm刻みでしか出てこない
STRONG_WIND = 8      # m
HIGH_WAVE = 15       # cm
FINAL_KINDS = ["優勝戦", "準優勝戦"]

# 二つ名(条件別の称号)用に2026-08-10追加した条件軸。既存3軸と同じ入れ物・同じ定義。
#   night/day   … ナイター場かどうか(会場の静的属性。レース単位の発走時刻はデータに無い)。
#                 判定は条件アラートと同じ backtest-data/meta.json の venues[].night。
#   final_all   … 優勝戦+準優勝戦 / non_final … それ以外(母数が大きい方の基準)
#   winter/summer … 12〜2月 / 6〜8月(月はdateから)
EXTRA_CONDS = ("night", "day", "final_all", "non_final", "winter", "summer")
WINTER_MONTHS = ("12", "01", "02")
SUMMER_MONTHS = ("06", "07", "08")
META_PATH = os.path.join("backtest-data", "meta.json")


def night_venues():
    """ナイター場の会場名の集合。meta.jsonが無い環境(初回等)では空集合になり、
    night/day軸だけ母数0で出る(他の集計は普通に動く)。"""
    try:
        meta = json.load(open(META_PATH, encoding="utf-8"))
        return {v["name"] for v in meta.get("venues", []) if v.get("night")}
    except Exception:
        return set()


def new_wlt():
    """出走・1着・2連対の入れ物。"""
    return [0, 0, 0]


def wlt_doc(row):
    """[出走, 1着, 2連対] を、率つきのJSONの形にする。母数0でも構造は出す。"""
    starts, wins, top2 = row
    return {
        "starts": starts, "wins": wins, "top2": top2,
        "win_rate": round(wins / starts, 4) if starts else None,
        "top2_rate": round(top2 / starts, 4) if starts else None,
    }


class Tally:
    """1人ぶん(または全国ぶん)の「勝ち方」の集計。選手別と全国で同じものを使う。"""

    # ナイター場の集合はクラスで1回だけ読む(選手数ぶんインスタンスを作るため)。
    NIGHT = None

    def __init__(self):
        if Tally.NIGHT is None:
            Tally.NIGHT = night_venues()
        self.kimarite = collections.Counter()               # 1着したときの決まり手
        self.courses = {c: new_wlt() for c in range(1, 7)}  # 進入コース別
        self.courses_kimarite = {c: collections.Counter() for c in range(1, 7)}
        self.venues = collections.defaultdict(new_wlt)
        self.conditions = {k: new_wlt()
                           for k in ("rain", "strong_wind", "high_wave") + EXTRA_CONDS}
        self.finals = {k: new_wlt() for k in FINAL_KINDS}
        self.maezuke = new_wlt()
        # 枠と進入がずれた出走の内訳。「前づけ」の一語でまとめると、自分で内を取りに
        # 行った走り(進<艇)と、他艇に押し出されて外になった走り(進>艇)が混ざる。
        # 意味が正反対なので分けて持つ。合計は maezuke と一致する。
        self.maezuke_uchi = new_wlt()   # 進 < 艇 = 枠より内のコースに入った
        self.maezuke_soto = new_wlt()   # 進 > 艇 = 枠より外のコースになった
        self.starts = 0
        self.wins = 0
        self.flying = collections.defaultdict(lambda: [0, 0])   # 年 -> [F, L]
        # 平均ST用。Fは「早すぎた」、Lは「出られなかった」で普通のSTと意味が違うため、
        # 平均には STt が空の値だけを入れる(F・Lの回数は flying が別に持っている)。
        self.st_sum = 0.0
        self.st_n = 0
        # 条件・大舞台の「コース別」内訳。全国の基準値でのみ書き出す(理由は doc_national)。
        self.cond_by_course = {k: {c: new_wlt() for c in range(1, 7)}
                               for k in ("rain", "strong_wind", "high_wave") + EXTRA_CONDS}
        self.final_by_course = {k: {c: new_wlt() for c in range(1, 7)} for k in FINAL_KINDS}

    def add(self, r, b):
        """1出走ぶんを足す。r=レース, b=その選手の艇。"""
        chaku = b["着"]                      # 非完走は None
        won = (chaku == 1)
        top2 = (chaku is not None and chaku <= 2)
        kim = r.get("決まり手") if won else None

        self.starts += 1
        if won:
            self.wins += 1
            if kim:
                self.kimarite[kim] += 1

        def bump(row):
            row[0] += 1
            if won:
                row[1] += 1
            if top2:
                row[2] += 1

        course = b.get("進")
        if course in self.courses:
            bump(self.courses[course])
            if kim:
                self.courses_kimarite[course][kim] += 1

        bump(self.venues[r["会場"]])

        def bump_cond(key):
            bump(self.conditions[key])
            if course in self.cond_by_course[key]:
                bump(self.cond_by_course[key][course])

        if r.get("天候") == "雨":
            bump_cond("rain")
        wind = r.get("風速")
        if isinstance(wind, (int, float)) and wind >= STRONG_WIND:
            bump_cond("strong_wind")
        wave = r.get("波高")
        if isinstance(wave, (int, float)) and wave >= HIGH_WAVE:
            bump_cond("high_wave")

        kind = r.get("種別")
        if kind in self.finals:
            bump(self.finals[kind])
            if course in self.final_by_course[kind]:
                bump(self.final_by_course[kind][course])
        # 優勝戦+準優勝戦をまとめた軸と、その補集合。合計は総出走と一致する。
        bump_cond("final_all" if kind in FINAL_KINDS else "non_final")

        bump_cond("night" if r["会場"] in Tally.NIGHT else "day")

        month = r["date"][5:7]
        if month in WINTER_MONTHS:
            bump_cond("winter")
        elif month in SUMMER_MONTHS:
            bump_cond("summer")

        st = b.get("ST")
        if isinstance(st, (int, float)) and not (b.get("STt") or ""):
            self.st_sum += st
            self.st_n += 1

        # 枠番(艇)と進入コース(進)が違う出走。内に入ったのか外になったのかを分ける。
        frame = b.get("艇")
        if course is not None and frame is not None and frame != course:
            bump(self.maezuke)
            bump(self.maezuke_uchi if course < frame else self.maezuke_soto)

        stt = b.get("STt") or ""
        if stt in ("F", "L"):
            year = r["date"][:4]
            self.flying[year][0 if stt == "F" else 1] += 1

    def doc(self):
        """JSONに書き出す形。母数0のセクションも構造は残す(表示側が「データなし」を出せるように)。"""
        return {
            "kimarite": {
                "total_wins": self.wins,
                "counts": {k: self.kimarite.get(k, 0) for k in KIMARITE},
            },
            "courses": {
                str(c): dict(wlt_doc(self.courses[c]),
                             kimarite={k: self.courses_kimarite[c].get(k, 0)
                                       for k in KIMARITE if self.courses_kimarite[c].get(k)})
                for c in range(1, 7)
            },
            # 会場は走ったことがある場所だけ入れる(24場ぶん0を並べても情報が無いため)。
            # venues というセクション自体は必ず出すので、表示側は空でも扱える。
            "venues": {v: wlt_doc(row) for v, row in sorted(self.venues.items())},
            "conditions": {k: wlt_doc(row) for k, row in self.conditions.items()},
            "finals": {k: wlt_doc(self.finals[k]) for k in FINAL_KINDS},
            "maezuke": dict(
                wlt_doc(self.maezuke),
                rate=round(self.maezuke[0] / self.starts, 4) if self.starts else None,
                # 内訳(uchi+soto=合計)。意味が正反対なので表示側でも分けて出す。
                uchi=dict(wlt_doc(self.maezuke_uchi),
                          rate=round(self.maezuke_uchi[0] / self.starts, 4) if self.starts else None),
                soto=dict(wlt_doc(self.maezuke_soto),
                          rate=round(self.maezuke_soto[0] / self.starts, 4) if self.starts else None),
                # 枠なり = 枠と進入が同じ出走。uchi+soto+wakunari=総出走。
                wakunari_starts=self.starts - self.maezuke[0],
                wakunari_rate=round((self.starts - self.maezuke[0]) / self.starts, 4) if self.starts else None,
            ),
            "flying": [{"year": int(y), "F": v[0], "L": v[1]}
                       for y, v in sorted(self.flying.items())],
            # 「勝ち型」。courses / courses_kimarite から合成できる値だが、
            # 二つ名の判定・表示が毎回同じ合成をしなくて済むよう名前を付けて出す。
            #   starts=その型が成立しうる母数(進入コースで絞る)、wins=その決まり手での1着数。
            #   win_rate=wins/starts(「その進入で走ったうち、その決まり手で勝てた割合」)。
            "styles": {
                "outer_makuri": self._style_doc((4, 5, 6), "まくり"),
                "sashi": self._style_doc((2, 3, 4), "差し"),
                "nige": self._style_doc((1,), "逃げ"),
                "makuri_sashi": self._style_doc(range(1, 7), "まくり差し"),
                "nuki": self._style_doc(range(1, 7), "抜き"),
            },
            # 平均ST。F・L・計時なしを除いた平均(定義はコメント参照)。
            "st": {
                "n": self.st_n,
                "mean": round(self.st_sum / self.st_n, 4) if self.st_n else None,
                "F": sum(v[0] for v in self.flying.values()),
                "L": sum(v[1] for v in self.flying.values()),
            },
        }

    def _style_doc(self, courses, kimarite):
        starts = sum(self.courses[c][0] for c in courses)
        wins = sum(self.courses_kimarite[c].get(kimarite, 0) for c in courses)
        return {
            "starts": starts, "wins": wins,
            "win_rate": round(wins / starts, 4) if starts else None,
        }

    def doc_national(self):
        """全国の基準値。選手別の doc() に「コース別の内訳」を足したもの。

        【なぜコース別の内訳が要るのか(実測で判明)】
        全選手を合計すると、どの条件でも1着は6艇に1人なので、全国の
        「雨の1着率」も「優勝戦の1着率」も「会場ごとの1着率」も必ず
        16.7%(=1/6)になる。表示側がこれを「(平均17%)」として出すと、
        何の情報も無い数字を見せることになる。
        意味のある基準は、同じ条件を「コース別」に割ったもの:
          全体の1コース1着率 54.5% に対して、雨のときの1コース1着率はどうか。
        会場別も同じ理由で全国平均は1/6にしかならないため、比較に使うなら
        courses(コース別1着率)か、選手自身の通年成績を基準にすること。
        """
        d = self.doc()
        d["conditions_by_course"] = {
            k: {str(c): wlt_doc(self.cond_by_course[k][c]) for c in range(1, 7)}
            for k in self.cond_by_course
        }
        d["finals_by_course"] = {
            k: {str(c): wlt_doc(self.final_by_course[k][c]) for c in range(1, 7)}
            for k in FINAL_KINDS
        }
        return d


# ============================== 昇級ボーダーウォッチ ==============================
# 現行の級別審査期間(5〜10月/11〜4月)の勝率を、公式定義で日次に積み上げて
# kyusoku.json に書き出す(2026-08-11、タスク⑧-1)。
#
# 【公式定義の再現(タスク⑦調査で実証済みのモデル)】
# - 勝率 = 着順点合計 ÷ 出走回数(小数3位を四捨五入)
# - 着順点はG3・一般競走の表(優勝戦とそれ以外で別表)。6隻立て固定
#   (欠場艇が結果に行として現れないため、結果の行数で隻立てを判定すると悪化する)
# - 選手責任外の欠場・失格(状=S0/L0/00)は出走回数に数えない(規程どおり)
# - 2連対率・3連対率は小数1位切り捨て(公式表記と同じ。97.6%一致を実証)
#
# 【対象はB級のみ】A級はSG/G1/G2の着順点(全出走が+1〜+2点)が再現できない
# (グレードがデータに無い)ため対象外。B級の完全一致は約95%で「参考値」として出す。
# 事故率(0.70以下)は不良航法等の2点が結果データに現れないため判定不能。要件から除外する。

KYUSOKU_PATH = "kyusoku.json"
KYUSOKU_TOP_N = 200
# G3・一般競走の着順点(6隻立て)。優勝戦以外(=基礎)と優勝戦。
KYU_PTS = {1: 10, 2: 8, 3: 6, 4: 4, 5: 2, 6: 1}
KYU_PTS_FINAL = {1: 11, 2: 9, 3: 7, 4: 6, 5: 4, 6: 3}
# 選手責任外の欠場・失格(出走回数に数えない)。状コードの対応はタスク⑦で実証
# (この除外で出走回数の一致が64%→95%になった)。
KYU_NO_FAULT = ("S0", "L0", "00")
# 昇級要件(事故率は判定不能のため含めない)。率は%。
KYU_REQ = {
    "B1": {"starts": 70, "top2": 30.0, "top3": 40.0},   # B1→A2圏
    "B2": {"starts": 50, "top2": 10.0, "top3": 20.0},   # B2→B1圏
}


def kyusoku_window(today_iso):
    """今日(JST)が属する審査期間 (開始日, 終了日, 期ラベル, 適用ラベル)。"""
    y, m = int(today_iso[:4]), int(today_iso[5:7])
    if 5 <= m <= 10:
        return (f"{y}-05-01", f"{y}-10-31",
                f"{y}年前期審査（5/1〜10/31）", f"{y + 1}年1月〜6月に適用")
    start_y = y if m >= 11 else y - 1
    return (f"{start_y}-11-01", f"{start_y + 1}-04-30",
            f"{start_y}年後期審査（11/1〜4/30）", f"{start_y + 1}年7月〜12月に適用")


def kyusoku_round2(x):
    """小数3位を四捨五入(規程どおり)。Pythonのroundは偶数丸めなので使わない。"""
    return int(x * 100 + 0.5) / 100


def kyusoku_trunc1(pct):
    """%の小数1位切り捨て(公式の連対率表記と同じ)。"""
    return int(pct * 10) / 10


class KyusokuTally:
    """審査期間内の1人ぶん: 出走(責任外を除く)・着順点・2連対・3連対。"""

    __slots__ = ("starts", "pts", "top2", "top3")

    def __init__(self):
        self.starts = self.pts = self.top2 = self.top3 = 0

    def add(self, r, b):
        if (b.get("状") or "") in KYU_NO_FAULT:
            return
        self.starts += 1
        tbl = KYU_PTS_FINAL if r.get("種別") == "優勝戦" else KYU_PTS
        self.pts += tbl.get(b["着"], 0)
        chaku = b["着"]
        if chaku is not None and chaku <= 2:
            self.top2 += 1
        if chaku is not None and chaku <= 3:
            self.top3 += 1

    def doc(self):
        s = self.starts
        rate = kyusoku_round2(self.pts / s) if s else None
        p2 = kyusoku_trunc1(self.top2 / s * 100) if s else None
        p3 = kyusoku_trunc1(self.top3 / s * 100) if s else None
        return {"starts": s, "rate": rate, "top2_rate": p2, "top3_rate": p3}


# ============================== 二つ名(称号) ==============================
# 条件別成績から称号を自動付与する(2026-08-10、仕様はJAM決定)。
# - 定員制: 各称号、順位づけ指標の上位10名のみ。1位だけ「・頂」付き。
# - 足切りを満たさない者は定員が空いていても付与しない。
# - 1選手は最大3称号(下のstrengthが大きい順に3つ)。守護神だけ枠外で+1。
# - 同値のタイブレークはN(該当出走数)が多い方。
#
# 【仕様の解釈(実装時に決めた点・報告済み)】
# - 守護神には「・頂」を付けない(各場1人で、全員に付くと頂の意味が無いため)。
# - 守護神は1人1場まで(「枠外で+1可」の単数解釈)。複数場で1位になった選手は
#   upliftが最大の場を持ち、他の場は次点が繰り上がる。
# - 3称号の上限で外れた枠には次点が繰り上がる(全員が3以内に収まるまで反復)。
# - 称号横断の強さ(strength)は指標の向きを揃えるため:
#   条件軸=uplift、勝ち型=対全国、音速=全国平均ST−本人平均ST(速いほど大)。

TITLE_CAPACITY = 10       # 各称号の定員
MAX_TITLES = 3            # 守護神を除く1人あたりの上限
MIN_N = 50                # 共通の足切り母数
NUKI_MIN_WINS = 30        # 最終章(抜き)だけの追加足切り
GUARDIAN_MIN_UPLIFT = 0.05

# 条件軸: (conditionsのキー, 称号名)。指標=uplift(条件下1着率−本人通算1着率)。
COND_TITLES = [
    ("high_wave", "荒海の覇者"),
    ("strong_wind", "風神の右腕"),
    ("rain", "雨を統べる者"),
    ("night", "月下の覇王"),
    ("final_all", "栄冠を狩る者"),
    ("winter", "氷海の王"),
    ("summer", "炎海の王"),
]
# 勝ち型軸: (stylesのキー, 称号名, 追加勝数条件)。指標=対全国(勝率−全国勝率)。
STYLE_TITLES = [
    ("outer_makuri", "カド一閃", 0),
    ("sashi", "差しの匠", 0),
    ("makuri_sashi", "隙間を縫う者", 0),
    ("nige", "絶対王政", 0),
    ("nuki", "最終章の支配者", NUKI_MIN_WINS),
]
ST_TITLE = "音速の申し子"


def compute_titles(ways, national):
    """全称号の保持者を決める。
    返り値: (titles_doc, guardians_doc, player_titles)
      titles_doc    … 称号ごとの保持者リスト(titles.json用)
      guardians_doc … 会場ごとの守護神(空位はholder=None)
      player_titles … 登番 -> 選手JSONに入れる称号リスト
    """
    def style(t, key):
        courses = {"outer_makuri": (4, 5, 6), "sashi": (2, 3, 4), "nige": (1,),
                   "makuri_sashi": range(1, 7), "nuki": range(1, 7)}[key]
        kim = {"outer_makuri": "まくり", "sashi": "差し", "nige": "逃げ",
               "makuri_sashi": "まくり差し", "nuki": "抜き"}[key]
        starts = sum(t.courses[c][0] for c in courses)
        wins = sum(t.courses_kimarite[c].get(kim, 0) for c in courses)
        return starts, wins

    nat_st_mean = national.st_sum / national.st_n if national.st_n else None
    nat_f_rate = (sum(v[0] for v in national.flying.values()) / national.starts
                  if national.starts else 0)

    # ---- 各称号の候補(足切り通過者)を強い順に並べる ----
    # candidates[称号名] = [{"toban","metric","n","strength"}...] (順位順)
    candidates = {}

    for key, name in COND_TITLES:
        natrate = national.conditions[key][1] / national.conditions[key][0]
        lst = []
        for toban, t in ways.items():
            s, w = t.conditions[key][0], t.conditions[key][1]
            if s < MIN_N or not t.starts:
                continue
            rate = w / s
            uplift = rate - t.wins / t.starts
            if uplift <= 0 or rate <= natrate:
                continue
            lst.append({"toban": toban, "metric": uplift, "n": s, "strength": uplift})
        lst.sort(key=lambda x: (-x["metric"], -x["n"]))
        candidates[name] = lst

    for key, name, min_wins in STYLE_TITLES:
        ns, nw = style(national, key)
        natrate = nw / ns if ns else 0
        lst = []
        for toban, t in ways.items():
            s, w = style(t, key)
            if s < MIN_N or w < min_wins:
                continue
            vs = w / s - natrate
            if vs <= 0:
                continue
            lst.append({"toban": toban, "metric": vs, "n": s, "strength": vs})
        lst.sort(key=lambda x: (-x["metric"], -x["n"]))
        candidates[name] = lst

    # 進入の革命家: uchi前づけ(自分から内のコースを取りにいった出走)での1着率の対全国。
    # 押し出されて外になった走り(soto)は意味が正反対なので対象にしない。
    # 全国基準は _national の maezuke.uchi と同じ値(maezuke_uchi の合計)。
    nat_uchi = national.maezuke_uchi
    uchi_natrate = nat_uchi[1] / nat_uchi[0] if nat_uchi[0] else 0
    lst = []
    for toban, t in ways.items():
        s, w = t.maezuke_uchi[0], t.maezuke_uchi[1]
        if s < MIN_N:
            continue
        vs = w / s - uchi_natrate
        if vs <= 0:
            continue
        lst.append({"toban": toban, "metric": vs, "n": s, "strength": vs})
    lst.sort(key=lambda x: (-x["metric"], -x["n"]))
    candidates["進入の革命家"] = lst

    # 音速の申し子: 平均STの速い順。F率が全国平均を超える者は除外。
    lst = []
    for toban, t in ways.items():
        if t.st_n < MIN_N or not t.starts:
            continue
        f_rate = sum(v[0] for v in t.flying.values()) / t.starts
        if f_rate > nat_f_rate:
            continue
        mean = t.st_sum / t.st_n
        lst.append({"toban": toban, "metric": mean, "n": t.st_n,
                    "strength": (nat_st_mean - mean) if nat_st_mean else 0})
    lst.sort(key=lambda x: (x["metric"], -x["n"]))   # STは小さいほど上位
    candidates[ST_TITLE] = lst

    # ---- 定員10で仮に採り、3称号の上限を超えた選手の弱い称号を外して繰り上げる。
    # 外す一方(banは増える一方)なので必ず止まる。
    banned = collections.defaultdict(set)   # toban -> 外された称号名
    while True:
        rosters = {}
        held = collections.defaultdict(list)   # toban -> [(strength, 称号名)]
        for name, lst in candidates.items():
            roster = [c for c in lst if name not in banned[c["toban"]]][:TITLE_CAPACITY]
            rosters[name] = roster
            for c in roster:
                held[c["toban"]].append((c["strength"], name))
        over = False
        for toban, titles in held.items():
            if len(titles) <= MAX_TITLES:
                continue
            over = True
            titles.sort(key=lambda x: -x[0])
            for _, name in titles[MAX_TITLES:]:
                banned[toban].add(name)
        if not over:
            break

    # ---- 守護神(会場別・各場1人・1人1場まで・枠外) ----
    guardian_cands = {}   # 会場 -> [{"toban","metric","n"}...]
    for venue in sorted(national.venues.keys()):
        lst = []
        for toban, t in ways.items():
            row = t.venues.get(venue)
            if not row or row[0] < MIN_N or not t.starts:
                continue
            uplift = row[1] / row[0] - t.wins / t.starts
            if uplift < GUARDIAN_MIN_UPLIFT:
                continue
            lst.append({"toban": toban, "metric": uplift, "n": row[0]})
        lst.sort(key=lambda x: (-x["metric"], -x["n"]))
        guardian_cands[venue] = lst

    guardian_ban = collections.defaultdict(set)   # toban -> 外された会場
    while True:
        holders = {}
        by_toban = collections.defaultdict(list)
        for venue, lst in guardian_cands.items():
            top = next((c for c in lst if venue not in guardian_ban[c["toban"]]), None)
            holders[venue] = top
            if top:
                by_toban[top["toban"]].append((top["metric"], venue))
        over = False
        for toban, vs in by_toban.items():
            if len(vs) <= 1:
                continue
            over = True
            vs.sort(key=lambda x: -x[0])
            for _, venue in vs[1:]:
                guardian_ban[toban].add(venue)
        if not over:
            break

    return rosters, holders, candidates


def class_periods():
    """fan/*.json から「適用開始日 → {登番: 級別}」の一覧を、古い順に作る。"""
    out = []
    for path in sorted(glob.glob(os.path.join(FAN_DIR, "[0-9][0-9][0-9][0-9].json"))):
        period = os.path.basename(path)[:4]
        yy, mm = int(period[:2]), period[2:]
        year = 2000 + yy
        if mm == "04":
            start, end = f"{year}-07-01", f"{year}-12-31"
        else:
            start, end = f"{year + 1}-01-01", f"{year + 1}-06-30"
        data = json.load(open(path, encoding="utf-8"))
        out.append({
            "period": period, "from": start, "to": end,
            "審査期間": data.get("算出期間"),
            "by_toban": {p["登番"]: p for p in data["players"]},
        })
    out.sort(key=lambda x: x["from"])
    return out


def main():
    if not results_store.exists():
        print("[skip] results/ が無いので players/career/ は作りません")
        return
    periods = class_periods()
    if not periods:
        print(f"[skip] {FAN_DIR} に期別ファイルが無いので作りません "
              f"(先に collect_fan_history.py を実行してください)")
        return

    # ---- 年別成績(results から) ----
    # 登番 -> 年 -> [出走, 1着, 2連対(=2着以内)]
    tally = collections.defaultdict(lambda: collections.defaultdict(lambda: [0, 0, 0]))
    names = {}
    ways = collections.defaultdict(Tally)   # 登番 -> 勝ち方の集計
    national = Tally()                      # 全国の基準値(同じ定義・同じ期間)
    races = 0
    date_min = date_max = None
    # 昇級ボーダーウォッチ: 現行の審査期間(JST基準)ぶんだけ別のタリーに積む。
    jst_today = (datetime.datetime.utcnow() + datetime.timedelta(hours=9)).strftime("%Y-%m-%d")
    kyu_from, kyu_to, kyu_label, kyu_apply = kyusoku_window(jst_today)
    kyu = collections.defaultdict(KyusokuTally)
    kyu_last = None   # 期間内で実際にデータがある最終日
    for r in results_store.iter_records():
        year = r["date"][:4]
        races += 1
        if date_min is None or r["date"] < date_min:
            date_min = r["date"]
        if date_max is None or r["date"] > date_max:
            date_max = r["date"]
        in_kyu = kyu_from <= r["date"] <= kyu_to
        if in_kyu and (kyu_last is None or r["date"] > kyu_last):
            kyu_last = r["date"]
        for b in r["結果"]:
            ways[b["登番"]].add(r, b)
            national.add(r, b)
            if in_kyu:
                kyu[b["登番"]].add(r, b)
            row = tally[b["登番"]][year]
            # 出走数は「完走しなくても1走」。失格・転覆・フライングも出走に数える
            # (2026-07-30までは、そういうレースがresultsに存在しなかった)。
            row[0] += 1
            chaku = b["着"]        # 非完走艇は None
            if chaku == 1:
                row[1] += 1
            if chaku is not None and chaku <= 2:
                row[2] += 1
            if b.get("名"):
                names[b["登番"]] = b["名"]

    os.makedirs(OUT_DIR, exist_ok=True)
    generated_at = datetime.datetime.now().isoformat(timespec="seconds")
    written = total_bytes = 0

    # ---- 二つ名(称号)の判定 ----
    # 級別は最新の期のもの(名簿の表示用。判定には使わない)。
    latest_class = {}
    for p in periods:
        for toban, rec in p["by_toban"].items():
            latest_class[toban] = rec["級別"]

    rosters, guardians, _ = compute_titles(ways, national)

    def holder_doc(c, rank, title_base, top_allowed=True):
        is_top = top_allowed and rank == 1
        return {
            "rank": rank,
            "toban": c["toban"],
            "name": names.get(c["toban"]),
            "class": latest_class.get(c["toban"]),
            "metric": round(c["metric"], 4),
            "n": c["n"],
            "is_top": is_top,
            "title": title_base + ("・頂" if is_top else ""),
        }

    player_titles = collections.defaultdict(list)
    titles_out = []
    for name_base, roster in rosters.items():
        holders = [holder_doc(c, i + 1, name_base) for i, c in enumerate(roster)]
        titles_out.append({"name": name_base, "holders": holders})
        for h in holders:
            player_titles[h["toban"]].append(
                {"title": h["title"], "rank": h["rank"], "metric": h["metric"],
                 "n": h["n"], "is_top": h["is_top"]})
    guardians_out = []
    for venue, c in guardians.items():
        if c is None:
            guardians_out.append({"venue": venue, "holder": None})
            continue
        # 守護神は各場1人なので「・頂」は付けない(全員に付くと頂の意味が無い)。
        h = holder_doc(c, 1, f"{venue}の守護神", top_allowed=False)
        guardians_out.append({"venue": venue, "holder": h})
        player_titles[c["toban"]].append(
            {"title": h["title"], "rank": 1, "metric": h["metric"],
             "n": h["n"], "is_top": False, "venue": venue})

    titles_doc = {
        "generated_at": generated_at,
        "note": "条件別成績からの自動付与。各称号は指標の上位10名(守護神は各場1人)。"
                "1位のみ「・頂」。1選手は最大3称号(守護神は枠外で+1)。"
                "指標(metric): 条件系=条件下1着率−本人通算1着率 / "
                "勝ち型=その進入での決まり手勝率−全国 / 音速=平均ST(小さいほど上位) / "
                "守護神=当地1着率−本人通算1着率。",
        "capacity": TITLE_CAPACITY, "max_titles": MAX_TITLES, "min_n": MIN_N,
        "titles": titles_out,
        "guardians": guardians_out,
    }
    with open(TITLES_PATH, "w", encoding="utf-8") as f:
        json.dump(titles_doc, f, ensure_ascii=False, separators=(",", ":"))

    for toban, by_year in tally.items():
        years = []
        for year in sorted(by_year):
            starts, wins, top2 = by_year[year]
            years.append({
                "year": int(year),
                "starts": starts, "wins": wins, "top2": top2,
                "win_rate": round(wins / starts, 4) if starts else None,
                "top2_rate": round(top2 / starts, 4) if starts else None,
            })

        classes = []
        for p in periods:
            rec = p["by_toban"].get(toban)
            if not rec:
                continue   # その期に在籍していない(引退・未デビュー)
            classes.append({
                "period": p["period"], "from": p["from"], "to": p["to"],
                "class": rec["級別"],
                "official_win_rate": rec.get("勝率"),      # 公式の勝率(着順点の平均)
                "official_top2_rate": rec.get("複勝率"),
                "starts": rec.get("出走回数"),
            })

        # 名前は results 由来(2025-07-05〜2026-05-05の期間だけ結果側に名前が無いので、
        # 見つからない場合は fan 側の氏名で補う)。
        name = names.get(toban)
        if not name:
            for p in reversed(periods):
                rec = p["by_toban"].get(toban)
                if rec:
                    name = rec.get("氏名")
                    break

        doc = {
            "toban": toban,
            "name": name,
            "generated_at": generated_at,
            "source": {
                "results_from": years[0]["year"] if years else None,
                "results_to": years[-1]["year"] if years else None,
                "class_periods": len(classes),
            },
            "rate_note": "win_rate=1着数÷出走数, top2_rate=2着以内÷出走数。"
                         "official_win_rate は公式の勝率(着順点の平均)で計算方法が異なる。",
            "years": years,
            "classes": classes,
        }
        # 「勝ち方」の各セクションを足す(既存キーは触らない)。
        doc.update(ways[toban].doc())
        # 二つ名(保持者だけ入る。持っていない選手は空リスト)。
        doc["titles"] = player_titles.get(toban, [])
        path = os.path.join(OUT_DIR, f"{toban}.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
        written += 1
        total_bytes += os.path.getsize(path)

    # ---- 全国の基準値(表示側が「(平均◯%)」を組み立てるための共通ファイル) ----
    nat = {
        "generated_at": generated_at,
        "from": date_min, "to": date_max, "races": races,
        "starts": national.starts,
        "note": "選手JSONとまったく同じ定義・同じ期間で集計した全国の水準。"
                "出走数=全出走(非完走を含む)、1着・2連対は記録どおり、"
                "決まり手は1着かつレースに決まり手がある場合のみ。"
                "stats.js は直近1年の集計なので、こことは期間が違う。",
        "compare_note": "conditions/finals/venues の win_rate は、全選手を合計すると"
                        "どの条件でも必ず1/6(16.7%)になる(1レースの1着は6艇に1人のため)。"
                        "基準値として使えないので表示に出さないこと。"
                        "比較に使うなら conditions_by_course / finals_by_course "
                        "(同じ条件をコース別に割ったもの)か、courses(全体のコース別1着率)、"
                        "あるいは選手自身の通年成績を基準にする。",
        "thresholds": {"strong_wind_m": STRONG_WIND, "high_wave_cm": HIGH_WAVE},
    }
    nat.update(national.doc_national())
    with open(NATIONAL_PATH, "w", encoding="utf-8") as f:
        json.dump(nat, f, ensure_ascii=False, separators=(",", ":"))

    # ---- 昇級ボーダーウォッチ(kyusoku.json) ----
    import math
    total_players = len(periods[-1]["by_toban"]) if periods else 0
    a1_seats = math.ceil(total_players * 0.2)
    a2_seats = math.ceil(total_players * 0.2)

    def kyu_row(toban, t):
        d = t.doc()
        cls = latest_class.get(toban)
        req = KYU_REQ.get(cls, KYU_REQ["B1"])
        ok_starts = d["starts"] >= req["starts"]
        ok_top2 = d["top2_rate"] is not None and d["top2_rate"] >= req["top2"]
        ok_top3 = d["top3_rate"] is not None and d["top3_rate"] >= req["top3"]
        return {
            "toban": toban, "name": names.get(toban), "class": cls,
            "rate": d["rate"], "starts": d["starts"],
            "top2_rate": d["top2_rate"], "top3_rate": d["top3_rate"],
            "ok_starts": ok_starts, "ok_top2": ok_top2, "ok_top3": ok_top3,
            "ok": ok_starts and ok_top2 and ok_top3,
        }

    def kyu_list(cls):
        rows = [kyu_row(t, k) for t, k in kyu.items()
                if latest_class.get(t) == cls and k.starts > 0]
        rows.sort(key=lambda x: (-(x["rate"] or 0), -x["starts"]))
        for i, r in enumerate(rows[:KYUSOKU_TOP_N]):
            r["rank"] = i + 1
        return rows[:KYUSOKU_TOP_N]

    # 全級を通した勝率順で(a1+a2)番目に入る勝率 = A級圏ボーダーの推定。
    # A級選手の勝率はSG/G1の加点ぶんが乗らず過小に出るため、実際のボーダーは
    # これよりやや高い(=甘めの推定)。B1の要件(70走・2連対30%・3連対40%)を満たす者だけで数える。
    all_rates = []
    for t, k in kyu.items():
        d = k.doc()
        if d["starts"] >= KYU_REQ["B1"]["starts"] and d["top2_rate"] is not None            and d["top2_rate"] >= KYU_REQ["B1"]["top2"] and d["top3_rate"] >= KYU_REQ["B1"]["top3"]:
            all_rates.append(d["rate"])
    all_rates.sort(reverse=True)
    seat = a1_seats + a2_seats
    # 期の序盤は「70走以上」を満たす選手が定員より少なく、境界はまだ決まらない。
    # その間は None にして、埋まり具合(qualified_count)を添える。
    border_rate = all_rates[seat - 1] if len(all_rates) >= seat else None

    kyusoku_doc = {
        "generated_at": generated_at,
        "period": {"from": kyu_from, "to": kyu_to, "label": kyu_label, "applies": kyu_apply},
        "data_to": kyu_last,
        "note": "勝率はG3・一般競走の着順点表から自前で再現した参考値です。"
                "B級の完全一致は約95%（SG・G1等の加点は再現できないためA級は対象外）。"
                "公式の発表と食い違う場合は公式が正です。",
        "jiko_note": "事故率（0.70以下）は判定材料がデータに無いため、要件の表示から除外しています。",
        "border": {
            "total_players": total_players,
            "a1_seats": a1_seats, "a2_seats": a2_seats,
            "a_seats_total": a1_seats + a2_seats,
            "border_rate_estimate": border_rate,
            "qualified_count": len(all_rates),
            "note": "定員はA1・A2とも登録選手総数の20%（最新期の人数"
                    f"{total_players}人で近似）。border_rate_estimateは全選手を自前勝率で"
                    "並べたときにA級圏(上位40%)へ入る最低勝率の推定。A級選手の勝率が"
                    "過小に出るぶん、実際のボーダーはこれよりやや高い。"
                    "期の序盤は出走70回以上の選手が定員より少ないため、境界が"
                    "決まるまではnull(qualified_countが埋まり具合)。",
        },
        "b1": kyu_list("B1"),
        "b2": kyu_list("B2"),
    }
    with open(KYUSOKU_PATH, "w", encoding="utf-8") as f:
        json.dump(kyusoku_doc, f, ensure_ascii=False, separators=(",", ":"))

    print(f"[done] {OUT_DIR}/ 生成: {written:,}選手 / 合計 {total_bytes:,} bytes "
          f"/ 平均 {total_bytes // written if written else 0:,} bytes/人 "
          f"/ 級別 {len(periods)}期分({periods[0]['from']}〜{periods[-1]['to']})")
    print(f"       全国の基準値: {NATIONAL_PATH} ({os.path.getsize(NATIONAL_PATH):,} bytes) "
          f"/ {races:,}レース {national.starts:,}出走 ({date_min}〜{date_max})")
    print(f"       昇級ウォッチ: {KYUSOKU_PATH} ({os.path.getsize(KYUSOKU_PATH):,} bytes) "
          f"/ {kyu_label} データ〜{kyu_last} / B1 {len(kyusoku_doc['b1'])}人 B2 {len(kyusoku_doc['b2'])}人")
    n_holders = len(player_titles)
    n_guard = sum(1 for g in guardians_out if g["holder"])
    print(f"       二つ名: {TITLES_PATH} ({os.path.getsize(TITLES_PATH):,} bytes) "
          f"/ 保持者 {n_holders}人 / 守護神 {n_guard}場(空位 {len(guardians_out)-n_guard}場)")


if __name__ == "__main__":
    main()
