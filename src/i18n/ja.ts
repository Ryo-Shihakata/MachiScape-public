/**
 * 文字列テーブル（実装書 §15）。
 * ユーザー向け文字列はすべてここを経由する。コンポーネントに日本語を直書きしない。
 * v2 で en.ts を追加するだけで切り替えられる構造を保つ。
 */

export const ja = {
  app: {
    title: 'MachiScape',
    tagline: '道をつないで、まちを育てる',
  },
  tool: {
    pan: '移動',
    road: '道路',
    zone: '区画',
    facility: '施設',
    demolish: '撤去',
    overlay: '表示',
    undo: '元に戻す',
    traffic: '交通',
    analysis: '分析',
  },
  zone: {
    residential: '住宅',
    commercial: '商業',
    industrial: '工業',
  },
  hud: {
    money: '資金',
    population: '人口',
    day: '日目',
    speedPause: '停止',
    speed1x: '1x',
    speed2x: '2x',
    speed3x: '3x',
    taxR: '住宅税収',
    taxC: '商業税収',
    taxI: '工業税収',
    upkeepRoad: '道路維持費',
    upkeepFacility: '施設維持費',
    netTotal: '収支',
    notStartedYet: 'まだ1日目',
    /** 需要バーの表示・非表示トグル（§3-3） */
    demandToggle: '需要',
  },
  status: {
    hint: '道路を引いて区画を塗ると、街が育ちます。',
    loading: '読み込み中…',
  },
  /**
   * 情報オーバーレイ（実装書 §12.3、`docs/m5-plan.md` §3-2）。
   * 分析ツールのサブ選択として出す。'off' は「なし」——他のモードと同列の選択肢の1つ
   * （旧デザインでは右端の別ボタンだったため 'オフ' だったが、選択肢の一員になったので
   * 名詞の並びに揃える）。
   */
  overlay: {
    title: '表示',
    off: 'なし',
    congestion: '渋滞',
    satisfaction: '満足度',
    roadAccess: '道路アクセス',
    zone: '区画',
    /** 新規（§4-3・§4-4）。描画自体は別担当。ラベルとヒントだけ先に用意する */
    flow: '流量',
    routes: '経路',
    /** 選択中のモードだけ1行で意味を出す。色の意味が分からないと絵が読めないため */
    hint: {
      congestion: '赤い道は詰まっています。空いている道は緑。',
      satisfaction: '緑なら順調。赤い建物は不満で、まもなく出ていきます。',
      roadAccess: '赤い区画は道路が遠すぎて建物が建ちません。',
      zone: '住宅・商業・工業の塗り分けを濃く表示しています。',
      flow: 'よく使われている道ほど明るく太く光ります。幹線道路の目安に。',
      routes: 'いま走っている車の経路を重ねて表示します。同じ道が多いほど濃くなります。',
    },
  },

  // ---------------------------------------------------------------------------
  // W3b: インスペクタ（`docs/m3-plan.md` §4 の 3-2）
  //
  // **方針**: どの行も「数字」だけで終わらせない。必ず `*Link` の一文を添えて
  // 「その数字がどこに繋がっているか」を書く。オーナーの指摘は
  // 「パラメーターが分かりづらい。具体的になんの数字か、どこに連動しているか見たい」だった。
  // 数字の値そのものは balance.ts から取って JSX 側で描くので、ここには入れない。
  // ---------------------------------------------------------------------------
  inspector: {
    close: '閉じる',
    occupied: '入居中',
    vacant: '空き家（退去済み）',
    road: '道路',
    emptyLand: '空き地',
    unzoned: '区画なし',
    notBuiltYet: 'まだ建っていない',
    outside: '未開放のエリア',
    terrain: '地形',

    // ---- 満足度 ----
    satisfaction: '満足度',
    satisfactionScale: '0〜100。{start} がふつう。この値だけが建物の生き死にを決める',
    abandonLine: '退去ライン',
    abandonLineValue: '{threshold} 未満が {days} 日続くと退去',
    abandonLink: '退去すると人口・税収・働き口から外れ、車も来なくなる',
    abandonWarning: 'このままだと退去する（低満足度 {n}/{days} 日目）',

    reasonsTitle: 'いま満足度を動かしているもの',
    reasonNone: '今日はまだ何も起きていない（増減なし）',
    todayNote: '「今日」の数は1日ごとにリセットされる',

    reasonTripOk: '車が着いた',
    reasonTripOkLink: '1台着くごとに +{step}。車が通えるほど住み心地が良くなる',
    reasonTripFail: '車が着けなかった',
    reasonTripFailLink:
      '1台につき {step}。道がつながっていない、または渋滞で時間切れ。街全体の失敗率にも入り、住宅の需要を押し下げる',
    reasonOutOfStock: '売る商品が切れている',
    reasonOutOfStockLink: '工業からトラックが届けば、この減点は止まる',
    reasonRegress: 'ふつうに戻る力',
    reasonRegressLink: '満足度は毎日 {start} へ {step} だけ近づく。放っておくと良くも悪くもならない',

    // ---- 在庫 ----
    stock: '商品の在庫',
    stockLink: '毎日 {consume} 売れる。0 の日は満足度が {penalty}',
    restockLine: 'トラックを呼ぶ在庫',
    restockLink: 'これを下回ると、いちばん近い工業へ配送を頼む',
    output: '出荷待ちの在庫',
    outputLink: '毎日 +{prod} 増える。上限は {max}',
    shipPerTruck: 'トラック1台の積載',
    shipLink: '在庫が {min} 以上ないと出荷できない。店の在庫はここから来る',

    // ---- 街への効き方 ----
    effectsTitle: 'この建物が街に効いているところ',
    effectPopulation: '住民',
    effectPopulationLink: '人口に足される。人口がそのまま商業の需要になる',
    effectWorkers: '働き手',
    effectWorkersLink: '働き手が働き口より多いと、住宅の需要が下がる',
    effectJobs: '働き口',
    effectJobsLink: '働き口が働き手より多いと、住宅の需要が上がる',
    effectTax: '税収',
    effectTaxLink: '入居している間だけ入る。退去すると止まる',
    effectDemandC: '商業の需要',
    effectDemandCLink: '人口 {pop} 人につき商業1軒が求められる',
    effectDemandI: '工業の需要',
    effectDemandILink: '商業1軒につき工業 {ratio} 軒が求められる',
    effectVacant: '退去中なので、人口・税収・働き口のどれにも数えられていない',

    // ---- 道路・土地 ----
    congestion: '混雑度',
    congestionLink: '混んだ道は車が自分で迂回する。ひどくなると時間切れ＝トリップ失敗になる',
    upkeep: '維持費',
    upkeepLink: '道路1タイルあたり毎日かかる。使わない道は畳んだ方が得',
    // 交差点の優先道路（M4）。設定・変更は「交通」ツールに一本化しているので、
    // ここは読むだけ（`docs/m4-ui-design.md` §1.6）
    intersection: '交差点',
    roadAccess: '道路アクセス',
    roadAccessOk: 'あり',
    roadAccessNone: 'なし',
    roadAccessLink: '道路から {dist} マス以内でないと建物が建たない',
    outsideLink: 'このエリアはまだ買っていない',

    unitCars: '台',
    unitPerDay: '/日',
    unitPeople: '人',
    unitBuildings: '軒',
  },

  terrain: {
    plain: '平地',
    forest: '森',
    water: '水面',
    mountain: '山',
  },

  // ---------------------------------------------------------------------------
  // W3b: 需要バーの説明（`docs/m3-plan.md` §4 の 3-3）
  //
  // 内訳の値は `explainDemand`（sim）から来る。ここには**式ではなく言葉**を置く。
  // 係数を書き写さないこと（balance.ts を調整したときに説明だけが古くなる）。
  // ---------------------------------------------------------------------------
  demand: {
    hint: 'バーをタップすると内訳が出ます',
    close: '閉じる',
    range: '−100〜100',
    moveInLink: '需要 {per} につき1軒、毎日この区画に入居する。0 以下だと誰も来ない',
    clamped: '振り切っていて、これ以上は効かない',
    total: '合計',

    factsTitle: 'いまの街の数字',
    jobs: '働き口',
    workers: '働き手（住民）',
    population: '人口',
    failRate: '目的地に着けなかった車',
    factsLink: 'この3つが需要のほぼすべてを決めている',

    contribution: {
      rBase: 'そもそも住みたい人がいる',
      rBaseLink: '街が空でも住宅が建ち始めるための下駄',
      rJobBalance: '働き口と住民のつり合い',
      rJobBalanceUp: '働き口が余っている → 人が入ってくる',
      rJobBalanceDown: '住民が余りぎみ → 商業か工業を建てるまで伸びない',
      rTripFail: '目的地に着けない車が多い',
      rTripFailLink: '道をつなぐ・渋滞を解くと、この押し下げが消える',
      cPopulation: '買い物する人がいる',
      cPopulationLink: '人口が増えるほど店の需要が上がる',
      cShops: 'すでに店が足りている',
      cShopsLink: '営業中の店の数だけ需要から引かれる（空き家は引かれない）',
      iShops: '店が商品を欲しがっている',
      iShopsLink: '店が増えるほど工場の需要が上がる',
      iFactories: 'すでに工場が足りている',
      iFactoriesLink: '稼働中の工場の数だけ需要から引かれる',
    },
  },

  // ---------------------------------------------------------------------------
  // M4: 交通整理（優先道路）のUI（`docs/m4-ui-design.md` §1）
  // ---------------------------------------------------------------------------
  traffic: {
    hint: '交差点をタップすると、優先する向きが切り替わります',
    summary: '交差点 {total} / 優先を設定 {controlled}',
    axisHorizontal: '東西を優先',
    axisVertical: '南北を優先',
    axisNone: '指定なし',
    notIntersection: 'ここは交差点ではありません',
    toast: '{axis}にしました',
  },

  trace: {
    vehicleTitle: '{icon} {status}',
    kind: {
      car: '🚗',
      truck: '🚚',
    },
    status: {
      driving: '走行中',
      waiting: '待機中',
      access: '建物へ出入り中',
      dwelling: '滞在中',
    },
    leg: {
      outbound: '往路',
      return: '復路',
    },
    place: '地点',
    route: '{from} ({fromX}, {fromY}) → {to} ({toX}, {toY})',
    timing: '経過 {seconds}秒 / 残り {tiles}タイル',
    vehicles: 'トリップ',
    buildingCounts: '出発中 {departing}台 / 向かっている {arriving}台',
    /** 相手先ごとの内訳（`docs/m5-plan.md` §3-4）。出発中・向かっているをそれぞれ列挙する */
    counterpartTo: '{place}({x}, {y})へ {count}台',
    counterpartFrom: '{place}({x}, {y})から {count}台',
  },
  // ---------------------------------------------------------------------------
  // T7: 幹線道路の操作（`docs/m4-trace-design.md` T7 §1）。
  // 区画ツールの「住/商/工」と同じ形のサブ選択で出す3つのボタン。
  // ---------------------------------------------------------------------------
  road: {
    normal: '通常',
    arterial: '幹線',
    shrink: '縮小',
  },

  // ---------------------------------------------------------------------------
  // M7: セーブ / ロードと効果音（実装書 §13・§14）
  // ---------------------------------------------------------------------------
  save: {
    button: '保存',
    save: '保存',
    load: '読込',
    autoName: '自動保存',
    slotName: 'スロット {slot}',
    exportName: 'エクスポート',
    export: '書き出す',
    import: '読み込む',
    saved: '保存しました',
    loaded: '読み込みました',
    imported: 'セーブデータを読み込みました',
    exported: 'セーブデータを書き出しました',
    emptySlot: 'このスロットにはセーブがありません',
    loadFailed:
      'セーブデータを読み込めませんでした。新しく始めるか、別のデータを読み込んでください',
    unsupportedVersion: 'このバージョンのセーブデータは読み込めませんでした',
    storageFailed: 'セーブデータを保存できませんでした',
    exportFailed: 'セーブデータを書き出せませんでした',
  },
  audio: {
    button: '音',
    mutedButton: '消音',
    volume: '音量',
    volumeValue: '{volume}%',
    mute: '完全にミュート',
    unmute: 'ミュートを解除',
  },

  // ---------------------------------------------------------------------------
  // M6 W4: 施設ツール（`docs/m6-plan.md` §2 W4）
  //
  // v1は公園・学校の2種だけ（`src/sim/facility/defs.ts`）。**この2つの説明文が
  // この計画の対比そのもの**——公園は「負荷を生まない」、学校は「恩恵と引き換えに
  // 通学の車が増える」ことを、数字ではなく文章ではっきり書く。
  // ---------------------------------------------------------------------------
  facility: {
    title: '施設',
    hint: '置く場所によって効果の範囲と、増える交通の量が変わります',
    cost: '建設費',
    upkeep: '維持費/日',
    radius: '効果範囲',
    radiusUnit: 'マス四方',
    noExtraTrip: '交通は増えません',
    extraTrip: '周りの住宅から通学の車が増えます',
    locked: 'ロック中',
    unlockRequirement: '人口 {pop} 人で解放',
    insufficientFunds: '資金が足りません',
    park: {
      name: '公園',
      description: '周りの住宅の満足度の下限を上げます。交通は増えません。',
    },
    school: {
      name: '学校',
      description:
        '周りの住宅の発展を促しますが、その住宅から通学の車が増えます。中央に置けば広く効きますが、その分だけ道路への負荷も大きくなります。',
    },
  },

  // ---------------------------------------------------------------------------
  // M6 W1: エリア購入（`docs/m6-plan.md` §2 W1）
  //
  // 「解放済みに隣接する未購入チャンク」をタップすると開くパネル。ここが無いと
  // 32×32のチャンクに永久に閉じ込められる（このM6の最優先事項）。
  // ---------------------------------------------------------------------------
  district: {
    title: 'エリアの購入',
    close: '閉じる',
    price: '価格',
    buy: '購入する',
    locked: '人口300人で解放されます。それまではこのエリアは買えません。',
    insufficientFunds: '資金が足りないため、まだ購入できません。',
    boughtToast: '新しいエリアを購入しました',
  },

  // ---------------------------------------------------------------------------
  // M6 W3: マイルストーン進捗（`docs/m6-plan.md` §2 W3）
  //
  // 「あと何人で次の解放か」を必ず言葉で出す。数値だけ出して放置しないこと。
  // 達成条件は人口のみ（品質ゲートは実測で取り下げ済み。`src/sim/progress/milestones.ts`）。
  // ---------------------------------------------------------------------------
  milestone: {
    title: 'マイルストーン',
    remaining: '次の目標まであと {n} 人',
    allDone: 'すべての目標を達成しました',
    achievedBanner: '達成！{name}が解放されました',
    achieved: '達成済み',
    notYetAchieved: '未達成',
    unlocksLabel: '解放されるもの',
    badgeOnly: '（称号のみ。エンドレスの目印）',
    popLabel: '人口 {pop} 人',
    reward: '報奨金 {money}',
    unlock: {
      school: '学校',
      district: 'エリア購入',
      arterial: '幹線道路',
      speed3x: '3倍速',
    },
  },
} as const;

export type Strings = typeof ja;

let active: Strings = ja;

/** ドット区切りのキーで文字列を引く（例: t('tool.road')） */
export function t(key: string): string {
  const parts = key.split('.');
  let cur: unknown = active;
  for (const p of parts) {
    if (typeof cur !== 'object' || cur === null || !(p in cur)) return key;
    cur = (cur as Record<string, unknown>)[p];
  }
  return typeof cur === 'string' ? cur : key;
}

export function setStrings(s: Strings): void {
  active = s;
}

/**
 * `{名前}` のプレースホルダに値を埋めて引く（例: `tp('inspector.abandonLink', { days: 3 })`）。
 *
 * バランス数値（`balance.ts`）を文章の中に入れたいときに使う。数値を i18n 側に
 * 書き写すと balance.ts の一元管理が崩れ、調整したときに説明文だけが古くなる。
 * かといって文章を前後2つのキーに割ると日本語として読めなくなるので、
 * **文章はテーブルに、数値は呼び出し側に**という形にする。
 *
 * `t()` 自体は変えない（既存の呼び出しに影響を出さないため）。
 */
export function tp(key: string, params: Record<string, string | number>): string {
  return t(key).replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}

export function formatMoney(n: number): string {
  return `¥${Math.floor(n).toLocaleString('ja-JP')}`;
}
