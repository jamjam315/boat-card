// AI講評の「判断するところ」だけを集めたファイル。ネットワークもDBも触らない。
//
// index.ts から切り離してあるのは、出力フィルタと素材の組み立てを
// テストで固定しておきたいため。ここが緩むと、禁止事項が素通りする。

export const MAX_DAILY_PREMIUM = 3; // プレミアム: 1日3回
export const MAX_FREE_TOTAL = 5; // 無料: お試し累計5回
// 匿名アカウント全体の1日の上限の既定値(環境変数 YOMI_AI_ANON_DAILY_LIMIT で変える)。
// 無料お試しは匿名で開いた人全員向けだが、匿名は作り直せるので、合計にも上限を置く。
// メールでログインした利用者(匿名でない)は対象外。
export const ANON_DAILY_DEFAULT = 100;

/** 環境変数の値から、匿名全体の1日の上限を決める。0以上の整数でなければ既定値。 */
export function anonDailyLimit(raw: string | undefined): number {
  if (raw === undefined || !/^\d{1,7}$/.test(raw.trim())) return ANON_DAILY_DEFAULT;
  return Number(raw.trim());
}

/** 匿名全体の上限に当たっているか。匿名でなければ常に false。 */
export function anonLimitReached(isAnonymous: boolean, usedToday: number, limit: number): boolean {
  return isAnonymous && usedToday >= limit;
}

/** システムプロンプト。**この全文を変えない**(指示文AI-1で確定した文面)。 */
export const SYSTEM_PROMPT =
  `あなたは競艇の「答案」を添削する採点者です。ユーザーが締切前に記録した買い目を、確定した結果と実測データで振り返ります。
絶対の規則:
1. 与えられたデータに含まれる数値・事実だけを使う。データに無い数字・傾向・固有名詞を作らない。
2. 選手名を書かない。艇は「1号艇」のように艇番で呼ぶ。
3. 買い目の推奨をしない。「買うべきだった」「◯を買えば」「次は◯を狙う」など、過去・未来を問わず具体的な買い目や購入行動の提案を書かない。
4. 未来の断定をしない。「次は当たります」のような予測を書かない。
5. 金額や収支の話をしない。
6. データが無い・母数が足りない事柄は「例が少ないため言えません」と正直に書く。
7. 購入を促す表現・射幸心を煽る表現を使わない。

文体と構成:
・日本語、です・ます調。テストの答案に赤ペンで書き込む先生の声。敬意をもって率直に。
・7〜10行。1行は1〜2文。前置き・見出し・箇条書き記号は書かない。
・構成: ①総評を1行 ②展開の読み——このレースの決着(1着コースと決まり手)に対し、渡された展開データの「2着に多いコース」と買い目を突き合わせる。数値は必ず「38%(n=12,340)」のように母数を添えて、渡された値のまま書く ③材料の評価——読み点の内訳や前づけ情報から、読めていた点と拾えなかった点を1〜2行ずつ ④学びを1行——このレースの気づきを、特定の買い目を指定せずに一般化する。`;

// ---------------------------------------------------------------- 入力の検証

export interface Bet {
  ken: string;
  combo: string;
  hit: boolean;
}
export interface Boat {
  n: number;
  nw2: number | null;
  st: number | null;
  last: number[];
  mo: number | null;
  t?: string; // 登番。前づけの突き合わせに使い、AIへは渡さない
}
export interface YomiRow {
  cat: string;
  label: string;
  pt: number;
  max: number;
  value: string;
}
export interface Sheet {
  venue: string;
  wave: number | null;
  kimarite: string | null;
  order: (number | null)[]; // 艇番順の着
  in: (number | null)[] | null; // 艇番順の進入コース(古い払戻データには無い)
  bets: Bet[];
  axis: number;
  backs: number[];
  yomi: YomiRow[];
  boats: Boat[];
}

const KEN = [
  "単勝",
  "複勝",
  "2連単",
  "2連複",
  "3連単",
  "3連複",
  "拡連複",
];

// 会場・決まり手・読み点の項目名は、AIへの指示文にそのまま入る。長さだけで通すと、
// 手作りのデータで指示を紛れ込ませられるので、決まった表記の一覧に一致するものだけ通す。
// 会場は data.js / renren.json と同じ表記(24場)。
export const VENUES = [
  "桐生", "戸田", "江戸川", "平和島", "多摩川", "浜名湖", "蒲郡", "常滑", "津", "三国", "びわこ", "住之江",
  "尼崎", "鳴門", "丸亀", "児島", "宮島", "徳山", "下関", "若松", "芦屋", "福岡", "唐津", "大村",
];
// 決まり手は parse_results.py の KIMARITE と同じ6種(無ければ null)。
export const KIMARITE = ["逃げ", "差し", "まくり", "まくり差し", "抜き", "恵まれ"];
// 読み点の項目は yomi.js の YOMI_TABLE と同じ4つ(記号と名前の組)。
export const YOMI_LABELS: Record<string, string> = {
  A: "全国勝率",
  B: "平均ST",
  C: "直近3走の調子",
  D: "波高とコース",
};

function isLane(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 6;
}
function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * クライアントから来た答案を検証して、扱える形に直す。
 *
 * 落ちたら理由の文字列を返す(呼び出し側が400にする)。**足りないものを
 * 補って通さない。** 答案が壊れているまま講評を書かせると、AIは辻褄を
 * 合わせようとして、無い事実を作る。
 */
export function parseSheet(raw: unknown): { sheet: Sheet } | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "body is not an object" };
  const b = raw as Record<string, unknown>;

  if (typeof b.venue !== "string" || VENUES.indexOf(b.venue) === -1) {
    return { error: "venue" };
  }
  if (b.kimarite !== null && b.kimarite !== undefined &&
    (typeof b.kimarite !== "string" || KIMARITE.indexOf(b.kimarite) === -1)) {
    return { error: "kimarite" };
  }
  if (!isLane(b.axis)) return { error: "axis" };

  const order = Array.isArray(b.order) ? b.order : null;
  if (!order || order.length !== 6) return { error: "order" };
  const inn = Array.isArray(b.in) && b.in.length === 6 ? b.in : null;

  const boatsRaw = Array.isArray(b.boats) ? b.boats : [];
  if (boatsRaw.length !== 6) return { error: "boats" };
  const boats: Boat[] = [];
  for (const x of boatsRaw) {
    const o = (x ?? {}) as Record<string, unknown>;
    if (!isLane(o.n)) return { error: "boat.n" };
    // 直近の着順は古い→新しい。長ければ新しいほうの8走を残す(2026-09-18 まで先頭=古いほうを残していた)
    const last = Array.isArray(o.last)
      ? o.last.filter((v): v is number => typeof v === "number").slice(-8)
      : [];
    boats.push({
      n: o.n,
      nw2: numOrNull(o.nw2),
      st: numOrNull(o.st),
      last,
      mo: numOrNull(o.mo),
      t: typeof o.t === "string" && /^\d{3,5}$/.test(o.t) ? o.t : undefined,
    });
  }

  const betsRaw = Array.isArray(b.bets) ? b.bets : [];
  if (!betsRaw.length || betsRaw.length > 30) return { error: "bets" };
  const bets: Bet[] = [];
  for (const x of betsRaw) {
    const o = (x ?? {}) as Record<string, unknown>;
    if (typeof o.ken !== "string" || KEN.indexOf(o.ken) === -1) {
      return { error: "bet.ken" };
    }
    // 組は数字と区切りだけ。ここを緩めると、買い目欄が自由入力欄になる。
    if (typeof o.combo !== "string" || !/^\d([-=]\d){0,2}$/.test(o.combo)) {
      return { error: "bet.combo" };
    }
    bets.push({ ken: o.ken, combo: o.combo, hit: o.hit === true });
  }

  const yomiRaw = Array.isArray(b.yomi) ? b.yomi : [];
  const yomi: YomiRow[] = [];
  for (const x of yomiRaw.slice(0, 8)) {
    const o = (x ?? {}) as Record<string, unknown>;
    if (typeof o.cat !== "string" || !Object.hasOwn(YOMI_LABELS, o.cat) || o.label !== YOMI_LABELS[o.cat]) {
      return { error: "yomi.label" };
    }
    yomi.push({
      cat: o.cat,
      label: o.label,
      pt: typeof o.pt === "number" ? o.pt : 0,
      max: typeof o.max === "number" ? o.max : 0,
      // 実測値は表示用の短い文字列。ここが自由入力の抜け道にならないよう、
      // **読み点の4項目が実際に出す語だけ**に語彙を固定する。
      //   「1号艇の全国勝率 6.42」「今節の平均ST 0.13」
      //   「今節2走の平均 2.5着」「波高 3cm・1号艇」
      // これ以外の文字は1字ずつ落ちるので、指示文を紛れ込ませても意味を
      // なさない。許す語を足すときは、上の4つの実例を壊さないか確かめること。
      value: String(o.value ?? "")
        .replace(/[^0-9.+\-・ %cm号艇着走秒全国勝率平均今節波高のST]/g, "")
        .slice(0, 24),
    });
  }

  return {
    sheet: {
      venue: b.venue,
      wave: numOrNull(b.wave),
      kimarite: typeof b.kimarite === "string" ? b.kimarite : null,
      order: order.map((v) => (isLane(v) || v === null ? (v as number | null) : null)),
      in: inn ? inn.map((v) => (isLane(v) ? v : null)) : null,
      bets,
      axis: b.axis,
      backs: Array.isArray(b.backs) ? b.backs.filter(isLane).slice(0, 5) : [],
      yomi,
      boats,
    },
  };
}

// ---------------------------------------------------------------- 素材の差し込み

export interface RenrenCell {
  c: number;
  k: string;
  n: number;
  top: [number, number, number][];
}
export interface Renren {
  cells: RenrenCell[];
  venue_exceptions: (RenrenCell & { v: string; tvd: number })[];
}
export type Maezuke = Record<string, [number, number, number]>;

/** 艇番から進入コースを引く。in が無い(古い払戻データ)なら null。 */
export function courseOf(sheet: Sheet, lane: number): number | null {
  if (!sheet.in) return null;
  return sheet.in[lane - 1] ?? null;
}

/** このレースの1着艇の進入コース。 */
export function winnerCourse(sheet: Sheet): number | null {
  const lane = sheet.order.findIndex((x) => x === 1);
  if (lane < 0) return null;
  return courseOf(sheet, lane + 1);
}

/**
 * このレースに当てはまる展開連鎖のセルを選ぶ。
 *
 * 会場の例外表に載っているセルがあればそちらを優先する(全国と本当に違うと
 * 分かっているのだから、そちらが正しい)。無ければ全国のセル。
 * どちらも無ければ null で、AIには何も渡さない(＝書けない)。
 */
export function pickRenren(
  renren: Renren | null,
  venue: string,
  course: number | null,
  kimarite: string | null,
) {
  if (!renren || course == null || !kimarite) return null;
  const ex = (renren.venue_exceptions ?? []).find(
    (x) => x.v === venue && x.c === course && x.k === kimarite,
  );
  if (ex) {
    return { scope: `${venue}(全国と傾向が違う会場)`, n: ex.n, top: ex.top };
  }
  const cell = (renren.cells ?? []).find((x) => x.c === course && x.k === kimarite);
  if (cell) return { scope: "全国", n: cell.n, top: cell.top };
  return null;
}

/** 軸と押さえのうち、前づけ32人に入っている艇だけを拾う。 */
export function pickMaezuke(maezuke: Maezuke | null, sheet: Sheet) {
  if (!maezuke) return [];
  const lanes = [sheet.axis, ...sheet.backs];
  const out: { n: number; rate: number; runs: number }[] = [];
  for (const lane of lanes) {
    const boat = sheet.boats.find((x) => x.n === lane);
    if (!boat?.t) continue;
    const row = maezuke[boat.t];
    if (!row) continue;
    out.push({ n: lane, rate: row[0], runs: row[2] });
  }
  return out;
}

/**
 * AI事業者へ渡す本文を組み立てる。
 *
 * **ここに載っていないものは送られない。** 選手名・登番・金額・タグ・日付・
 * user_id は、この関数が組み立てる文字列のどこにも現れない(登番は
 * [pickMaezuke] の突き合わせに使うだけで、出力には艇番しか出さない)。
 */
/**
 * 買い目を、どの着に何号艇(何コース)を置いたかの文にする(2026-09-18 5b)。
 *
 * 組の数字(1-2-3)だけを渡していたら、推論量が既定でも「押さえを2着候補と読む」
 * 「2着に置いた艇を取り違える」読み違えが出た。着ごとに書き、順不同の券種はそう書く。
 * ボートレースの複勝は2着以内、拡連複は2艇とも3着以内(払戻の行数と同じ)。
 */
export function betPositions(sheet: Sheet, b: Bet): string {
  const lanes = b.combo.split(/[-=]/).map(Number);
  const boat = (n: number) => {
    const c = courseOf(sheet, n);
    return `${n}号艇` + (c ? `(${c}コース)` : "");
  };
  const all = lanes.map(boat).join("・");
  switch (b.ken) {
    case "単勝":
      return `1着予想: ${boat(lanes[0])}`;
    case "複勝":
      return `2着以内予想: ${boat(lanes[0])}`;
    case "2連単":
    case "3連単":
      return lanes.map((n, i) => `${i + 1}着予想: ${boat(n)}`).join(" / ");
    case "2連複":
      return `順不同(2艇で1着・2着)予想: ${all}`;
    case "3連複":
      return `順不同(3艇で1着〜3着)予想: ${all}`;
    case "拡連複":
      return `順不同(2艇とも3着以内)予想: ${all}`;
    default:
      return "";
  }
}

export function buildUserPrompt(
  sheet: Sheet,
  renren: ReturnType<typeof pickRenren>,
  maezuke: ReturnType<typeof pickMaezuke>,
): string {
  const L: string[] = [];
  L.push(`【レース】${sheet.venue}`);
  if (sheet.wave != null) L.push(`波高 ${sheet.wave}cm`);

  const finish = [1, 2, 3]
    .map((rank) => {
      const lane = sheet.order.findIndex((x) => x === rank);
      if (lane < 0) return null;
      const c = courseOf(sheet, lane + 1);
      return `${rank}着 ${lane + 1}号艇` + (c ? `(${c}コース)` : "");
    })
    .filter(Boolean)
    .join(" / ");
  L.push(`【結果】${finish}` + (sheet.kimarite ? ` 決まり手 ${sheet.kimarite}` : ""));

  // 買い目は着ごとに書く(betPositions)。コースは【結果】と同じく、実際の進入コース。
  L.push("【記録した買い目】(コースは実際の進入)");
  for (const b of sheet.bets) {
    L.push(`  ${b.ken} ${b.combo} … ${b.hit ? "的中" : "不的中"} … ${betPositions(sheet, b)}`);
  }

  // 押さえは「買い目に出てくる回数」から推定したもので、何着に置いたかではない(2着候補と読まれていた)
  L.push(`【軸】${sheet.axis}号艇` +
    (sheet.backs.length ? ` 【押さえ】${sheet.backs.map((n) => n + "号艇").join("・")}` : "") +
    "(どちらも買い目に出てくる回数からの推定。何着に置いたかは【記録した買い目】を見る)");

  if (sheet.yomi.length) {
    L.push("【読み点の内訳】");
    for (const r of sheet.yomi) {
      L.push(`  ${r.label} ${r.pt}/${r.max}点 (${r.value})`);
    }
  }

  L.push("【出走6艇の番組表の数字】");
  for (const b of sheet.boats) {
    const parts = [`${b.n}号艇`];
    if (b.nw2 != null) parts.push(`全国2連率${b.nw2}%`);
    if (b.st != null) parts.push(`平均ST${b.st}`);
    if (b.last.length) parts.push(`直近の着順(古い→新しい)${b.last.join("→")}着`);
    if (b.mo != null) parts.push(`モーター2率${b.mo}%`);
    L.push("  " + parts.join(" / "));
  }

  if (renren) {
    const rows = renren.top
      .map(([c, pct, n]) => `${c}コース ${pct}%(n=${n.toLocaleString("en-US")})`)
      .join(" / ");
    L.push(`【展開データ】この決着(${renren.scope}・母数 n=${
      renren.n.toLocaleString("en-US")
    })で2着に多いコース: ${rows}`);
  } else {
    L.push("【展開データ】この決着に当てはまる集計がありません(母数が足りないため収録していません)。");
  }

  if (maezuke.length) {
    L.push("【進入の癖】" + maezuke
      .map((m) => `${m.n}号艇は直近1年で枠より内から進入した割合 ${m.rate}%(${m.runs}走)`)
      .join(" / "));
  }

  return L.join("\n");
}

// ---------------------------------------------------------------- 出力フィルタ

/** 禁止語。ここに触れたら、どれだけ良い文でも出さない。 */
export const BANNED = [
  "買うべき",
  "買いましょう",
  "おすすめ",
  "購入し",
  "狙いましょう",
  "賭け",
];

const COMBO_RE = /\d[-=]\d(?:[-=]\d)?/g;

/** 「1-2-3」を、区切りをそろえた比較用の形に直す。 */
function normalizeCombo(s: string): string {
  return s.replace(/=/g, "-");
}

/**
 * 入力に出てくる組番(買い目と確定着順)を集める。
 *
 * 着順は「1-2-3」「1-2」「1」のどれで書かれても良いように、上位3艇から
 * 作れる並びを全部入れておく。ここが狭いと、AIが正しく着順を書いただけで
 * ブロックされる。
 */
export function allowedCombos(sheet: Sheet): Set<string> {
  const set = new Set<string>();
  for (const b of sheet.bets) set.add(normalizeCombo(b.combo));

  const top: number[] = [];
  for (const rank of [1, 2, 3]) {
    const lane = sheet.order.findIndex((x) => x === rank);
    if (lane >= 0) top.push(lane + 1);
  }
  if (top.length >= 2) set.add(`${top[0]}-${top[1]}`);
  if (top.length >= 3) {
    set.add(`${top[0]}-${top[1]}-${top[2]}`);
    set.add(`${top[1]}-${top[2]}`);
  }
  return set;
}

export type FilterResult = { ok: true; text: string } | { ok: false; reason: string };

/**
 * AIの出力を通してよいか決める。
 *
 * 通す条件は3つだけで、迷ったら通さない。**回数を消費するのは通ったときだけ**
 * なので、厳しすぎて損をするのは利用者ではなくこちら側になる。その非対称を
 * わざとこの向きにしてある。
 */
/**
 * AIを呼んだ1回の結果を、日別の記録(yomi_ai_outcomes_daily)の種類にする(2026-09-18 監視)。
 * 呼び出しそのものの失敗(timeout など)を先に見る。ai() は失敗すると null を返し、
 * 出力フィルタでは "empty" になるので、そこで種類が潰れないようにするため。
 */
export function outcomeOf(
  failure: string | null,
  checked: { ok: true } | { ok: false; reason: string },
): string {
  if (failure) return failure;
  return checked.ok ? "ok" : checked.reason.split(":")[0];
}

export function filterOutput(text: string | null, sheet: Sheet): FilterResult {
  if (text == null || !text.trim()) return { ok: false, reason: "empty" };
  const body = text.trim();

  for (const w of BANNED) {
    if (body.includes(w)) return { ok: false, reason: "banned:" + w };
  }

  // 入力に無い組番が出てきたら、AIが買い目を発明したということ。
  const allowed = allowedCombos(sheet);
  const found = body.match(COMBO_RE) ?? [];
  for (const raw of found) {
    if (!allowed.has(normalizeCombo(raw))) {
      return { ok: false, reason: "invented:" + raw };
    }
  }

  return { ok: true, text: body };
}

// ---------------------------------------------------------------- そのほか

/** JSTの今日(YYYY-MM-DD)。日本は1951年を最後に夏時間が無いので、UTC+9固定でよい。 */
export function jstDate(now: Date = new Date()): string {
  const t = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return t.toISOString().slice(0, 10);
}

/** ログに出すユーザーID。**全桁を残さない。** */
export function shortId(userId: string): string {
  return userId.slice(0, 8);
}
