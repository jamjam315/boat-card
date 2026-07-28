# -*- coding: utf-8 -*-
"""
バックテスト「自由条件指定」(5b)用の軽量中間データを作る。

results/{年}.jsonl(2026-07-19に年別分割・過去2年分バックフィル済み、156,022件・
2023-07-05〜)をそのままブラウザに読ませると重いため、ビルド時に「回収率・的中率の
計算に必要な最小限」だけを取り出した軽量JSONに前処理する。ブラウザ側
(backtest-custom.html)はこの軽量JSONを読み、ユーザーが選んだ会場・期間・券種・
買い目でその場集計する。

【会場×年でファイルを分割する理由(2026-07-19、複数年対応)】
これまでは「会場ごと(全期間1ファイル)」の分割のみだったが、データが3年分に
増えたことで、会場を1つ選ぶだけの検証でも毎回その会場の全期間(3年分)を
ダウンロードすることになり無駄が大きい。そこで
  backtest-data/zenkoku-{年}.json   … 全国(その年の全レース)
  backtest-data/{romaji}-{年}.json  … 会場ごと(その年ぶんだけ、zenkokuの部分集合)
  backtest-data/meta.json           … earliest/latest/実在する年一覧(years)/会場一覧
に分割する。ブラウザは「選ばれた会場」×「選ばれた期間が重なる年」の組み合わせ
だけを読み込む(例: 過去1年なら直近2年分のファイルだけ、のように読み込み量が
期間の長さにほぼ比例する)。将来10年分に増えても、この粒度のまま年ファイルが
増えていくだけで構造は破綻しない。

【年の切れ目をまたぐ分の無駄について(正直な設計メモ)】
「過去N年」は暦年単位ではなく日付そのものでの厳密なローリング窓(下記参照)なので、
窓の始点が年の途中に来ることがほとんどになる。その場合、窓の始点が属する年の
ファイルは丸ごとダウンロードした上でブラウザ側の日付比較で範囲外ぶんを捨てる
(=その年の「窓に入らない月」ぶんは無駄なダウンロードになる)。年単位より
細かく(月単位等)分割すれば無駄は減らせるが、ファイル数が増えて管理が煩雑になる
割に効果が限定的なので、今回は年単位の粒度で割り切る(過度な最適化はしない)。

【中間データの1レコード(1レース)の形】
  {"d": "2026-06-30",
   "m": 41234,                         しぼり込み用のメタ情報(下記のビット詰め)
   "t":  [["1", 130]],                 単勝  (組, 金額)
   "f":  [["1", 100], ["2", 210]],     複勝
   "2t": [["1-2", 180]],               2連単
   "2f": [["1-2", 200]],               2連複
   "3t": [["1-2-4", 740]],             3連単
   "3f": [["1-2-4", 540]]}             3連複
選手名・展示タイム等、しぼり込みにも回収率計算にも使わない項目は持たない。
人気も持たない。拡連複は自由条件指定の対象外なので持たない。

【"m"(メタ情報)のビット詰め】(2026-07-26 しぼり込み条件の追加で新設)
しぼり込み用に5項目を1つの整数へ詰める。名前付きキーを5つ並べると1レース
あたり約32バイト増え、10年分をまとめて読むと配信量が20MB以上増えてしまう
(5bは会場×年のJSONをブラウザが直接ダウンロードするため、そのまま通信量に
効く)。ビット詰めなら約11バイトで済み、JS側もビット演算だけで取り出せる。
  bit  0-3 : レース番号 1〜12
  bit  4-6 : 天候      0=晴 1=曇 2=雨 3=雪 4=霧 (7=不明)
  bit  7-11: 風速(m)   0〜30 (31=不明)  ※実データの最大は16m
  bit 12-14: 決まり手  0=逃げ 1=差し 2=まくり 3=まくり差し 4=抜き 5=恵まれ (7=不明)
  bit 15   : 枠なり    1=6艇すべて 艇番==進入コース / 0=進入変化あり
  bit 16-20: 会場      meta.jsonのvenues[]の並び順(=公式の会場コード-1)。31=不明
  bit 21-23: 種別      0=優勝戦 1=準優勝戦 2=予選 3=一般 4=その他 (7=不明)
  bit 24-25: 距離      0=1800m 1=1200m 2=それ以外 (3=不明)
  bit 26   : 進入固定  1=進入固定レース
ここまでで27ビット。JavaScriptのビット演算は32ビット符号付きなので、bit 30 まで
なら同じやり方で足せる(距離を1ビットではなく2ビットにしたのは、実データが
1800m/1200mの2種類しか無い今のうちに、他が現れても壊れない形にしておくため)。
月は "d" から取れるので持たない。会場をレコードに入れているのは、全国ファイル
1本のままナイター/デイのしぼり込みをするため(会場別ファイルを17本並行して
読ませると、過去10年で187リクエストになってしまう)。追加コストは約2MB。

【ナイター場の判定】(meta.jsonのvenues[].nightで配る)
公式B票の「締切予定」を2025-08〜2026-07の40日ぶんサンプリングし、最終レースの
締切が18時以降だった割合で判定した結果を、下のNIGHT_VENUESに固定値として持つ。
7場(桐生・蒲郡・住之江・丸亀・下関・若松・大村)はいずれも締切20:45以降で
100%(住之江のみ95%)、他は0%と明確に分かれた。福岡は48%だが最遅18:00ちょうどの
薄暮開催なのでデイ側に入れている。
これは「現在ナイター開催をしている会場」のグループであって、過去の各開催が
実際にナイターだったかまでは区別していない(会場の固定属性として扱っている)。
program/(番組表の日次履歴)に締切予定が貯まれば、将来はレース単位で厳密に
判定できるようになる。そのときはこの定数を差し替えるだけで済むよう、判定は
ここ1か所に閉じてある。

【「艇が出走しているか」の前提】(変更なし)
collect_results.py は6艇そろったレースしか results/ に入れないため、この中間
データの艇番1〜6は常に全艇出走している前提で計算してよい(欠場等で6艇そろわ
なかったレースはそもそも results/ に存在しない)。そのため中間データ側で艇の
出走有無を別途持つ必要はない。

【払戻が空のレースの扱い】(変更なし)
返還・特払い等でその券種の払戻が読み取れなかったレースは、元データでも払戻が
空配列になっている(build_backtest.py と同じ仕様)。この中間データでもそのまま
空配列で持ち、ブラウザ側では「賭けたが払戻0円、的中もしていない」として扱う
(対象レース数には含め、的中はしない)。

【期間の窓の定義(ブラウザ側backtest-custom.htmlのコメントにも明記)】
「過去N年」は、meta.jsonのlatest(データの最終日)ではなく「今日(JST)」を
基準にした厳密なローリング窓(今日からN*365日前まで)。日次更新が多少遅れても
「過去N年」の意味がデータの更新タイミングに引っ張られないようにするため。
"""
import json, os, glob, re, gzip, datetime
from build_race_pages import VENUE_ROMAJI
from parse_results import JCD
import results_store

OUT_DIR = "backtest-data"

# 中間データに残す券種だけ(拡連複は自由条件指定の対象外)
KEEP_BETS = {"単勝": "t", "複勝": "f", "2連単": "2t", "2連複": "2f", "3連単": "3t", "3連複": "3f"}

# "m"(メタ情報)のコード表。ブラウザ側(backtest-custom.html)と必ず一致させること。
WEATHER_CODE = {"晴": 0, "曇": 1, "雨": 2, "雪": 3, "霧": 4}
KIMARITE_CODE = {"逃げ": 0, "差し": 1, "まくり": 2, "まくり差し": 3, "抜き": 4, "恵まれ": 5}
KIND_CODE = {"優勝戦": 0, "準優勝戦": 1, "予選": 2, "一般": 3, "その他": 4}
DIST_CODE = {1800: 0, 1200: 1}
UNKNOWN_3BIT = 7
UNKNOWN_WIND = 31
MAX_WIND = 30
UNKNOWN_VENUE = 31
OTHER_DIST = 2      # 1800m/1200m以外(現在の実データには存在しない)
UNKNOWN_DIST = 3

# 会場名 → メタ情報に入れる会場インデックス(公式の会場コード順、桐生=0 … 大村=23)。
# meta.jsonのvenues[]にも同じ値をcodeとして入れ、並び順のズレで取り違えないようにする。
VENUE_INDEX = {name: i for i, name in enumerate(JCD.values())}

# ナイター開催をしている会場(公式B票の締切予定40日ぶんから判定。詳細は上のdocstring)
NIGHT_VENUES = {"桐生", "蒲郡", "住之江", "丸亀", "下関", "若松", "大村"}


def load_races():
    """build_backtest.py と同じ重複排除の作法(再取り込み対策)。results/ の
    全年ファイルを跨いで読み、date:会場:レース番号で重複を除く。"""
    races, seen = [], set()
    for r in results_store.iter_records():
        key = f'{r["date"]}:{r["会場"]}:{r["レース番号"]}'
        if key in seen:
            continue
        seen.add(key)
        races.append(r)
    return races


def pack_meta(r):
    """しぼり込み用の5項目を1つの整数へ詰める(ビット割り当てはdocstring参照)。"""
    rno = r.get("レース番号") or 0
    weather = WEATHER_CODE.get(r.get("天候"), UNKNOWN_3BIT)
    wind = r.get("風速")
    wind = UNKNOWN_WIND if wind is None else min(int(wind), MAX_WIND)
    kimarite = KIMARITE_CODE.get(r.get("決まり手"), UNKNOWN_3BIT)
    res = r.get("結果") or []
    # 枠なり = 6艇すべてが自分の枠番どおりのコースに入った(進入変化なし)
    wakunari = 1 if len(res) == 6 and all(x.get("艇") == x.get("進") for x in res) else 0
    venue = VENUE_INDEX.get(r.get("会場"), UNKNOWN_VENUE)
    kind = KIND_CODE.get(r.get("種別"), UNKNOWN_3BIT)
    dist = r.get("距離")
    dist = UNKNOWN_DIST if dist is None else DIST_CODE.get(int(dist), OTHER_DIST)
    fixed = 1 if r.get("進入固定") else 0
    return ((rno & 0xF) | (weather << 4) | (wind << 7) | (kimarite << 12)
            | (wakunari << 15) | (venue << 16) | (kind << 21) | (dist << 24)
            | (fixed << 26))


def compact(r):
    """1レースぶんを軽量な形に変換する。"""
    payout = r.get("払戻") or {}
    rec = {"d": r["date"], "m": pack_meta(r)}
    for label, key in KEEP_BETS.items():
        entries = payout.get(label) or []
        # 人気は自由条件指定の計算に不要なので落とす。組・金額だけ残す。
        rec[key] = [[e.get("組", ""), e.get("金額", 0)] for e in entries]
    return rec


def write_json(path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    return os.path.getsize(path)


def gzip_size(path):
    """実際の配信はGitHub Pages(Fastly)側のgzip/brotli圧縮に任せるが、報告用に
    ローカルでgzip後サイズを見積もる(圧縮率の目安。ブラウザの実ダウンロード量に近い)。"""
    with open(path, "rb") as f:
        raw = f.read()
    return len(gzip.compress(raw, compresslevel=9))


def clean_old_format_files():
    """会場×年に分割する前の旧形式ファイル(zenkoku.json / {romaji}.json、年サフィックス
    無し・全期間1ファイル)が残っていると、更新漏れで古いデータが配信され続ける事故に
    なりうるので明示的に削除する。新形式は必ず「-年」で終わるファイル名にする。"""
    removed = []
    for path in glob.glob(os.path.join(OUT_DIR, "*.json")):
        base = os.path.basename(path)
        if base == "meta.json":
            continue
        stem = base[:-5]
        if not re.search(r"-\d{4}$", stem):
            os.remove(path)
            removed.append(base)
    return removed


def main():
    races = load_races()
    if not races:
        print("[stop] results/ が無い/空です。")
        return

    os.makedirs(OUT_DIR, exist_ok=True)
    removed = clean_old_format_files()

    dates = sorted(r["date"] for r in races)
    earliest, latest = dates[0], dates[-1]
    years = sorted({d[:4] for d in dates})

    by_year = {y: [] for y in years}
    for r in races:
        by_year[r["date"][:4]].append(r)

    venue_names = list(JCD.values())
    sizes = {}
    for y in years:
        recs = by_year[y]
        zenkoku_y = [compact(r) for r in recs]
        fname = f"zenkoku-{y}.json"
        sizes[fname] = write_json(os.path.join(OUT_DIR, fname), zenkoku_y)

        by_venue_y = {v: [] for v in venue_names}
        for r in recs:
            if r["会場"] in by_venue_y:
                by_venue_y[r["会場"]].append(compact(r))
            # 未知の会場名(表記ゆれ等)は会場別からは漏れるが、全国には含まれる(従来どおり)

        for v in venue_names:
            romaji = VENUE_ROMAJI.get(v)
            if not romaji:
                continue
            fname = f"{romaji}-{y}.json"
            sizes[fname] = write_json(os.path.join(OUT_DIR, fname), by_venue_y[v])

    venue_list = []
    for v in venue_names:
        romaji = VENUE_ROMAJI.get(v)
        if not romaji:
            continue
        # night=true はナイター開催をしている会場。ブラウザ側の「開催区分」の
        # しぼり込みは、この印を見て読み込む会場ファイルを選ぶ。
        venue_list.append({"name": v, "romaji": romaji,
                           "code": VENUE_INDEX[v], "night": v in NIGHT_VENUES})

    meta = {
        "generated_at": datetime.datetime.now().isoformat(timespec="seconds"),
        "earliest": earliest,
        "latest": latest,
        "years": years,
        "venues": venue_list,
    }
    write_json(os.path.join(OUT_DIR, "meta.json"), meta)

    total = sum(sizes.values())
    print(f"[done] {OUT_DIR}/ 生成(年別): {len(races):,}レース / 期間{earliest}〜{latest} / 年{years}")
    if removed:
        print(f"  旧形式ファイル削除: {len(removed)}件 {removed}")
    for y in years:
        path = os.path.join(OUT_DIR, f"zenkoku-{y}.json")
        gz = gzip_size(path)
        print(f"  zenkoku-{y}.json: {sizes[f'zenkoku-{y}.json']:,} bytes (gzip概算 {gz:,} bytes)")
    venue_year_total = sum(v for k, v in sizes.items() if not k.startswith("zenkoku-"))
    print(f"  会場別ファイル合計(全年): {venue_year_total:,} bytes")
    print(f"  全体合計: {total:,} bytes")


if __name__ == "__main__":
    main()
