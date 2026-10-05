# -*- coding: utf-8 -*-
"""
殿堂(titles.html)の称号の変化を見つけて、1実行に1件だけXへ投稿する。

  python scripts/x_title_watch.py [--dry-run]

【見るもの】players/career/titles.json(results.yml が毎日2回作る)
  ランキング型14本 … 首位の交代 / 新しくトップ10に入った選手
  会場称号48枠     … 守護神・申し子の交代(各場1人)

【以前の版(AI-8)との違い】
以前は build_profiles_v5 の catch(選手ページの一言。「宮島のイン粘り差し屋」等)を
二つ名として監視していた。これは殿堂の称号とは別物だった。catch は週188人が動く
値で、投稿の対象にしない。

【優先順位】1実行1投稿。
  A  ランキング型の首位交代   … 複数あれば走数nが多い称号を1本
  A' 会場称号の交代           … 複数あれば当地走数nが多い枠を1本
  B  新しいトップ10入り        … 最大3人。fit() に収まる人数まで減らす
  どれも無い週は投稿しない(昇級ウォッチの日曜まとめと二重にしないため)

【応援アカウントとしての掟】
落ちた側の名前は書かない。首位を明け渡した選手・10位から外れた選手の名前は
出さない。名前を出すのは、新しく付いた人だけ。
会場称号の「空位→着任」「着任→空位」は交代として扱わない。前者は誰かを
押しのけた話ではなく、後者は落ちた側の話にしかならないため。

【揺れを投稿しない】
集計は全期間の累積なので、同じ条件を走っていなくても、本人の通算1着率が他の
レースで動くだけで指標が揺れる。実測で唐津の申し子は、当地57走どうしの2人が
uplift 0.04〜0.07pt 差で毎週入れ替わっていた(表示はどちらも +18.9pt・57走)。
そのまま出すと、同じ2人の間で毎週「交代しました」になる。そこで:
  - 交代は、新しい首位の表示値が、前の首位の(前回の)表示値と違うときだけ数える。
    読む人に違いが見えない入れ替わりは交代と呼ばない
  - トップ10入りは、直近 SEEN_DAYS 日にその称号の10人に居なかった人だけ数える。
    10位の境界を出入りしている人を、毎回「新しく名を連ねた」と書かないため

【数字】表示は殿堂ページ(titles.html の metricStr / venueCard)と揃える。
定義文は titles_desc.json から読む(殿堂ページと同じファイル)。

【事故を構造で防ぐ】
  - 状態ファイルが無い初回は、判定せず保存だけする
  - 同じ日に2回は投稿しない(last_posted_date)
  - 投稿は x_post.post() 経由。本文1件だけ・リトライ無し
  - 本文の投稿に失敗したら状態を更新しない。翌週、同じ変化がもう一度拾われる

【リンクを入れない】(2026-10-05)
以前は返信で殿堂のURLを付けていた。URL入りの投稿は1件$0.20(通常$0.015)で、返信は
ほとんど見られていなかった(今日の一問の実測で本文の約1.3%)。返信をやめ、本文の末尾で
「プロフィールのリンク→「二つ名殿堂」から。」と案内する(トップの入口の名前と同じ)。
この1行のぶん長くなるので、重み280を超える回は定義の行(——〜)を文の切れ目で後ろから
短くし、それでも入らなければ外す(compose())。会場の申し子は定義文が長く、末尾の
「各場1人だけの称号」を落として収まる(2026-10-05 の titles.json で全48枠を測った)。
"""
import argparse
import datetime
import json
import os
import sys
import zoneinfo

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import x_post

JST = zoneinfo.ZoneInfo("Asia/Tokyo")
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TITLES_PATH = os.path.join(REPO, "players", "career", "titles.json")
DESC_PATH = os.path.join(REPO, "titles_desc.json")
STATE_PATH = os.path.join(REPO, "x_state", "hall_state.json")

TAGS = "#ボートレース #競艇"
GUIDE = "プロフィールのリンク→「二つ名殿堂」から。"
MAX_ENTRIES = 3          # B で並べる人数の上限
SEEN_DAYS = 28           # トップ10入りの「新しく」を判定する記憶の長さ(4週)
VENUE_SUFFIXES = ("の守護神", "の申し子")


def load_json(path, default=None):
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def md(date_iso):
    """"2026-09-14" -> "9/14"。ゼロ埋めしない。"""
    d = datetime.date.fromisoformat(date_iso)
    return f"{d.month}/{d.day}"


# ---------------------------------------------------------------- スナップショット

def holder(h):
    return {"toban": str(h["toban"]), "name": h.get("name") or str(h["toban"]),
            "class": h.get("class"), "metric": h["metric"], "n": h["n"],
            "rank": h.get("rank")}


def snapshot(doc):
    """titles.json を比較しやすい形にする。

    ranked … {称号: [holder, ...]}(順位順)
    venue  … {"大村の守護神": holder or None, ...}
    過去の週を再現するスクリプト(x_title_replay.py)も同じ形を作って decide() に渡す。"""
    ranked = {t["name"]: [holder(h) for h in t["holders"]] for t in doc.get("titles", [])}
    venue = {}
    for key, suffix in (("guardians", "の守護神"), ("children", "の申し子")):
        for g in doc.get(key, []):
            h = g.get("holder")
            venue[g["venue"] + suffix] = holder(h) if h else None
    return {"ranked": ranked, "venue": venue}


def state_of(snap, prev=None, date_iso=None):
    """状態ファイルに残す形。

    ranked / venue      … 今の並び(登番だけ)
    ranked_top / venue_value … 首位(各場の保持者)の表示値。次回、交代が「見て分かる
                          違い」かを比べるのに使う。数字そのものではなく表示の文字列で
                          持つのは、読む人に見える単位で比べたいため
    seen                … 称号ごとの「直近で10人に入っていた日」。トップ10入りの判定用
    名前などは持たない(次回のtitles.jsonから引く。二重に持つと片方だけ古くなるため)。"""
    out = {
        "ranked": {t: [h["toban"] for h in hs] for t, hs in snap["ranked"].items()},
        "ranked_top": {t: (metric_str(t, hs[0]["metric"]) if hs else None)
                       for t, hs in snap["ranked"].items()},
        "venue": {k: (h["toban"] if h else None) for k, h in snap["venue"].items()},
        "venue_value": {k: (venue_metric_str(k, h["metric"]) if h else None)
                        for k, h in snap["venue"].items()},
    }
    seen = {t: dict(v) for t, v in ((prev or {}).get("seen") or {}).items()}
    if date_iso:
        cut = (datetime.date.fromisoformat(date_iso)
               - datetime.timedelta(days=SEEN_DAYS)).isoformat()
        for t, hs in snap["ranked"].items():
            m = seen.setdefault(t, {})
            for h in hs:
                m[h["toban"]] = date_iso
            for tb in [tb for tb, d in m.items() if d < cut]:
                del m[tb]
    out["seen"] = seen
    return out


# ---------------------------------------------------------------- 表示

def metric_str(title, m):
    """殿堂ページと同じ表記。音速の申し子だけSTそのもの、他は差分のpt。"""
    if title == "音速の申し子":
        return f"ST {m:.3f}"
    return f"+{m * 100:.1f}pt"


def venue_metric_str(key, m):
    """守護神は当地1着率そのもの(絶対値)、申し子は本人通算からの伸び(pt)。"""
    if key.endswith("の守護神"):
        return f"1着率{m * 100:.1f}%"
    return f"+{m * 100:.1f}pt"


def who(h):
    """「峰竜太選手（A1）」。級別が取れない選手は括弧ごと落とす。"""
    return f"{h['name']}選手" + (f"（{h['class']}）" if h.get("class") else "")


def desc_for(desc, key):
    """会場称号は「〇〇の守護神」の定義を使う。
    称号そのものの定義があればそれを先に使う。ランキング型の「音速の申し子」は名前の末尾が
    「の申し子」なので、先に末尾で見ると会場の申し子の定義(「その水面に来ると…」)を引いてしまう
    (2026-10-05 に見つけた。それまで音速の申し子の首位交代は投稿されていない)。"""
    if key in desc:
        return desc[key]
    for suffix in VENUE_SUFFIXES:
        if key.endswith(suffix):
            return desc.get("〇〇" + suffix, "")
    return desc.get(key, "")


def note_choices(note):
    """定義の行の候補。全文 → 文の切れ目(「。」)で後ろから短くしたもの → 無し、の順。
    途中で切った文は出さない(読めない定義を出すより、出さないほうがよい)。"""
    if not note:
        return [None]
    parts = [p for p in note.split("。") if p]
    return [note] + ["。".join(parts[:k]) + "。" for k in range(len(parts) - 1, 0, -1)] + [None]


def compose(lines, note):
    """本文を組む。定義の行(note)は入るところまで短くし、入らなければ外す。
    それでも入らなければ None。"""
    for n in note_choices(note):
        t = "\n".join(lines + ([f"——{n}"] if n else []) + [GUIDE, TAGS])
        if fits(t):
            return t
    return None


def text_lead(date_iso, title, h, desc):
    return compose([f"二つ名ウォッチ🚤 {md(date_iso)}",
                    f"「{title}」の首位が交代しました。",
                    f"新しい王は{who(h)}。{metric_str(title, h['metric'])}・{h['n']:,}走。"],
                   desc_for(desc, title))


def text_venue(date_iso, key, h, desc):
    role = "守護神" if key.endswith("の守護神") else "申し子"
    return compose([f"二つ名ウォッチ🚤 {md(date_iso)}",
                    f"「{key}」が交代しました。",
                    f"新しい{role}は{who(h)}。{venue_metric_str(key, h['metric'])}・{h['n']:,}走。"],
                   desc_for(desc, key))


def text_entries(date_iso, rows):
    return compose([f"二つ名ウォッチ🚤 {md(date_iso)}",
                    "今週、殿堂に新しく名を連ねた選手："]
                   + [f"「{title}」{h['rank']}位 {h['name']}選手（{metric_str(title, h['metric'])}・{h['n']:,}走）"
                      for title, h in rows],
                   "条件別の1着率から、毎日機械的に付け直している二つ名です。")


def fits(text):
    return x_post.weighted_len(text) <= x_post.MAX_WEIGHTED


# ---------------------------------------------------------------- 判定

def decide(prev, cur, date_iso, desc):
    """投稿する1件を決める。(種別, 本文) か (None, 理由)。

    prev は state_of() の形(登番だけ)、cur は snapshot() の形。"""
    # A: ランキング型の首位交代。走数nの多い称号を採る(同数なら称号名で固定)。
    leads = []
    for title, hs in cur["ranked"].items():
        before = prev["ranked"].get(title)
        if not before or not hs:
            continue
        if before[0] == hs[0]["toban"]:
            continue
        # 表示値が前の首位と同じなら、読む人には違いが見えない。交代と呼ばない。
        was = (prev.get("ranked_top") or {}).get(title)
        if was is not None and was == metric_str(title, hs[0]["metric"]):
            print(f"[title] 「{title}」は入れ替わりましたが表示値が同じ({was})のため、交代として扱いません。")
            continue
        leads.append((hs[0]["n"], title))
    for n, title in sorted(leads, key=lambda x: (-x[0], x[1])):
        t = text_lead(date_iso, title, cur["ranked"][title][0], desc)
        if t:
            return "lead", t
        print(f"[title] 「{title}」の首位交代が長すぎて収まりませんでした。次の候補を見ます。")

    # A': 会場称号の交代。空位がからむ変化は交代として扱わない(先頭の説明を参照)。
    changes = []
    for key, h in cur["venue"].items():
        if key not in prev["venue"]:
            continue
        before = prev["venue"][key]
        if before is None or h is None:
            continue
        if before == h["toban"]:
            continue
        was = (prev.get("venue_value") or {}).get(key)
        if was is not None and was == venue_metric_str(key, h["metric"]):
            print(f"[title] 「{key}」は入れ替わりましたが表示値が同じ({was})のため、交代として扱いません。")
            continue
        changes.append((h["n"], key))
    for n, key in sorted(changes, key=lambda x: (-x[0], x[1])):
        t = text_venue(date_iso, key, cur["venue"][key], desc)
        if t:
            return "venue", t
        print(f"[title] 「{key}」の交代が長すぎて収まりませんでした。次の候補を見ます。")

    # B: 新しいトップ10入り。前回その称号が無かった(新設)なら全員新規になるので数えない。
    rows = []
    memory = prev.get("seen") or {}
    for title, hs in cur["ranked"].items():
        before = prev["ranked"].get(title)
        if before is None:
            continue
        # 前回の10人に加えて、直近 SEEN_DAYS 日に10人に居た人も「新しく」ではない。
        known = set(before) | set((memory.get(title) or {}).keys())
        for h in hs:
            if h["toban"] not in known:
                rows.append((title, h))
    # 上位の順位から。同順位なら走数の多い順、それも同じなら称号名で固定。
    rows.sort(key=lambda r: (r[1]["rank"], -r[1]["n"], r[0]))
    for k in range(min(MAX_ENTRIES, len(rows)), 0, -1):
        t = text_entries(date_iso, rows[:k])
        if t:
            return "entries", t
    if rows:
        print(f"[title] トップ10入り {len(rows)}人ぶん、1人でも収まりませんでした。")

    return None, "首位交代もトップ10入りもありません(この週は投稿しません)"


# ---------------------------------------------------------------- 本体

def save_state(cur, last_posted, path, prev=None, date_iso=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    out = state_of(cur, prev, date_iso)
    out["last_posted_date"] = last_posted
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    print(f"[title] 状態を保存しました 称号{len(out['ranked'])}本 / 会場枠{len(out['venue'])} "
          f"/ last_posted_date={last_posted}")


def main():
    p = argparse.ArgumentParser(description="殿堂の称号の変化をXへ投稿する")
    p.add_argument("--dry-run", action="store_true", help="投稿せず、本文だけ出す")
    p.add_argument("--titles", default=TITLES_PATH)
    p.add_argument("--state", default=STATE_PATH)
    p.add_argument("--today", help="テスト用。今日(JST)を YYYY-MM-DD で上書きする")
    a = p.parse_args()

    today = (datetime.date.fromisoformat(a.today) if a.today
             else datetime.datetime.now(JST).date())
    cur = snapshot(load_json(a.titles))
    desc = (load_json(DESC_PATH, {}) or {}).get("desc", {})
    print(f"[title] titles.json 称号{len(cur['ranked'])}本 / 会場枠{len(cur['venue'])} / 今日(JST)={today}")

    state = load_json(a.state)
    if state is None:
        # 初回。比べる相手が無いので保存だけ(--dry-run でも保存する。しないと次も初回になる)。
        print("[title] 状態ファイルがありません。初回として、判定せずに保存だけします。")
        save_state(cur, None, a.state, None, today.isoformat())
        return

    last_posted = state.get("last_posted_date")
    if last_posted == today.isoformat():
        print(f"[title] 今日({today})はすでに投稿済みのため投稿しません。状態だけ更新します。")
        save_state(cur, last_posted, a.state, state, today.isoformat())
        return

    kind, text = decide(state, cur, today.isoformat(), desc)
    if kind is None:
        print(f"[title] {text}")
        save_state(cur, last_posted, a.state, state, today.isoformat())
        return

    print(f"[title] 投稿する種別: {kind}")
    # 本文の送信に失敗すると post() の中で非0終了し、状態は更新されない。
    x_post.post(text, dry_run=a.dry_run)
    if not a.dry_run:
        last_posted = today.isoformat()
    save_state(cur, last_posted, a.state, state, today.isoformat())


if __name__ == "__main__":
    main()
