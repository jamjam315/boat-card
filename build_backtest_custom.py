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

【中間データの1レコード(1レース)の形】(変更なし)
  {"d": "2026-06-30",
   "t":  [["1", 130]],                 単勝  (組, 金額)
   "f":  [["1", 100], ["2", 210]],     複勝
   "2t": [["1-2", 180]],               2連単
   "2f": [["1-2", 200]],               2連複
   "3t": [["1-2-4", 740]],             3連単
   "3f": [["1-2-4", 540]]}             3連複
選手名・天候・展示タイム等、回収率計算に使わない項目は持たない。人気も持たない。
拡連複は自由条件指定の対象外(仕様により今回含めない)なので持たない。

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


def compact(r):
    """1レースぶんを軽量な形に変換する。"""
    payout = r.get("払戻") or {}
    rec = {"d": r["date"]}
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
        venue_list.append({"name": v, "romaji": romaji})

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
