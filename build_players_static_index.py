# -*- coding: utf-8 -*-
"""
選手一覧ページ(players/index.html)に、全選手ページへの静的リンク索引を追加する。

【目的(SEO)】
players/index.html は今まで、選手一覧を players_list.js を読み込んで
JavaScriptで描画するだけで、生HTMLには選手ページへの<a href>が1つも
無かった。JavaScriptを実行しないクローラーからは選手ページ(1600件超)への
経路が見えず、検索インデックス登録の妨げになっていた。
このスクリプトは、既存の動的な検索・絞り込み・ソート機能(players_list.js側の
ロジック)は一切変更せず、その下に「全選手一覧（索引）」として、五十音の
行ごとに折りたたんだ静的リンクの塊を追加する。<details>は閉じた状態でも
中身がDOMに存在するため(display:noneでの隠蔽ではない)、クローラーは
JavaScriptなしでも辿れる。

【データの一致】
players_list.js(build_all_player_pages.py が選手ページ生成と同じデータから
作る既存ファイル)をそのまま読み込むので、登番・選手名は選手ページ本体と
必ず一致する(リンク切れが起きない)。

【書き込み範囲】
players/index.html 内の以下2つのマーカーの間だけを書き換える。それ以外の
手書きHTML・既存の動的機能・CSSには一切触れない。マーカーが無い場合は
意図しないファイルを壊さないよう、何もせずエラーにする。

  <!-- STATIC_PLAYER_INDEX_START -->
  ...(このスクリプトが書き込む内容)...
  <!-- STATIC_PLAYER_INDEX_END -->

使い方:
    python build_players_static_index.py
    (players_list.js が更新されたら、索引を最新に保つため再実行する)
"""
import json

PLAYERS_LIST_JS = "players_list.js"
INDEX_HTML = "players/index.html"
START_MARK = "<!-- STATIC_PLAYER_INDEX_START -->"
END_MARK = "<!-- STATIC_PLAYER_INDEX_END -->"

# players_list.js の kana は半角カタカナ表記(例: "ﾀｶﾊｼ ｼﾞﾛｳ")。
# 先頭1文字だけを見て五十音の行に振り分ける(濁点・半濁点・小書き文字も
# 基本字と同じ行に含める)。
ROW_MAP = {}


def _add_row(label, chars):
    for c in chars:
        ROW_MAP[c] = label


_add_row("ア", "ｱｲｳｴｵｧｨｩｪｫ")
_add_row("カ", "ｶｷｸｹｺ")
_add_row("サ", "ｻｼｽｾｿ")
_add_row("タ", "ﾀﾁﾂﾃﾄｯ")
_add_row("ナ", "ﾅﾆﾇﾈﾉ")
_add_row("ハ", "ﾊﾋﾌﾍﾎ")
_add_row("マ", "ﾏﾐﾑﾒﾓ")
_add_row("ヤ", "ﾔﾕﾖｬｭｮ")
_add_row("ラ", "ﾗﾘﾙﾚﾛ")
_add_row("ワ", "ﾜｦﾝ")
ROW_ORDER = ["ア", "カ", "サ", "タ", "ナ", "ハ", "マ", "ヤ", "ラ", "ワ", "他"]


def load_player_list():
    content = open(PLAYERS_LIST_JS, encoding="utf-8").read()
    prefix = "window.PLAYER_LIST = "
    body = content[len(prefix):].strip()
    if body.endswith(";"):
        body = body[:-1]
    return json.loads(body)


def row_of(kana):
    if not kana:
        return "他"
    return ROW_MAP.get(kana[0], "他")


def escape_html(s):
    return (s.replace("&", "&amp;").replace("<", "&lt;")
             .replace(">", "&gt;").replace('"', "&quot;"))


def build_block(players):
    groups = {k: [] for k in ROW_ORDER}
    for p in players:
        groups[row_of(p.get("kana"))].append(p)
    for k in groups:
        groups[k].sort(key=lambda p: p.get("kana") or "")

    parts = []
    for row in ROW_ORDER:
        members = groups[row]
        if not members:
            continue
        links = " ".join(
            f'<a href="/players/{p["t"]}.html">{escape_html(p["name"])}</a>'
            for p in members
        )
        parts.append(
            f'<div class="pindex-group"><p class="pindex-group-ttl">{row}行（{len(members)}人）</p>'
            f'<p class="pindex-links">{links}</p></div>'
        )
    body = "\n      ".join(parts)
    total = len(players)
    return (
        '<!-- 以下はbuild_players_static_index.pyの自動生成。手編集しないこと。 -->\n'
        '  <section class="pindex">\n'
        '    <details class="pindex-details">\n'
        f'      <summary class="pindex-summary">全選手一覧（索引・{total}人、五十音行別）</summary>\n'
        '      <div class="pindex-body">\n'
        f'      {body}\n'
        '      </div>\n'
        '    </details>\n'
        '  </section>'
    )


def main():
    players = load_player_list()
    block = build_block(players)

    html = open(INDEX_HTML, encoding="utf-8").read()
    if START_MARK not in html or END_MARK not in html:
        raise RuntimeError(f"{INDEX_HTML} にマーカーが見つかりません。先にマーカーを設置してください。")
    pre, rest = html.split(START_MARK, 1)
    _, post = rest.split(END_MARK, 1)
    new_html = pre + START_MARK + "\n  " + block + "\n  " + END_MARK + post

    with open(INDEX_HTML, "w", encoding="utf-8") as f:
        f.write(new_html)

    print(f"[done] {INDEX_HTML} に全{len(players)}人ぶんの静的リンクを書き込みました。")


if __name__ == "__main__":
    main()
