/**
 * プレビューと確定結果の一致（実装書 §12.4 / `docs/m3-plan.md` §4 W1-2 の追補）。
 *
 * このゲームには「**プレビューでは置けるのに建設できない**」を作らないという規約があり、
 * `applyOp` のコメントにも明記されている。矩形ドラッグの導入で最大1024タイルを
 * 一度に扱うようになったため、プレビュー・事前判定・実適用の3者がズレると
 * すぐに目に見える不整合になる。
 *
 * ここで守るのは次の2点:
 *  1. 払える操作は対象全体が緑になり、実際に全体へ適用される
 *  2. 払えない操作は対象全体が赤になり、1タイルも変更されない（D8）
 */

import { describe, expect, it } from 'vitest';
import { ECONOMY, ROAD } from './balance';
import {
  hasRoad,
  roadRankAt,
  setRoad,
  setRoadRank,
  setZone,
  zoneAt,
  buildingIdAt,
  terrainAt,
  setTerrain,
} from './grid';
import { tileKey, type Building } from './types';
import {
  applyOp,
  canApplyOp,
  createWorld,
  previewBuildRoad,
  previewDemolishArea,
  previewDowngradeRoad,
  previewPaintZone,
  previewUpgradeRoad,
} from './world';

const SEED = 20260729;

/** 開始チャンク内の、平地で道路も区画も無い横一列を探す */
function plainRow(world: ReturnType<typeof createWorld>, len: number): { x: number; y: number }[] {
  for (let y = 1; y < 30; y++) {
    const row: { x: number; y: number }[] = [];
    for (let x = 1; x < 1 + len; x++) {
      if (terrainAt(world.state.grid, x, y) !== 'plain') break;
      row.push({ x, y });
    }
    if (row.length === len) return row;
  }
  throw new Error('平地の列が見つからない（テストの前提が崩れている）');
}

function addBuilding(world: ReturnType<typeof createWorld>, x: number, y: number): Building {
  const b: Building = {
    id: world.state.nextId++,
    pos: { x, y },
    zone: 'residential',
    level: 1,
    occupied: true,
    satisfaction: 50,
    lowSatisfactionDays: 0,
    tripsOkToday: 0,
    tripsFailToday: 0,
  };
  world.state.buildings.push(b);
  world.state.grid.buildingIndex[tileKey(x, y)] = b.id;
  return b;
}

describe('プレビューと確定結果の一致', () => {
  it('道路: 合計予算が足りなければプレビューも実適用も全滅する', () => {
    const world = createWorld(SEED);
    const tiles = plainRow(world, 5);
    // ちょうど2タイルぶんだけ払える
    world.state.money = ECONOMY.COST_ROAD * 2;

    const preview = previewBuildRoad(world, tiles);
    const result = applyOp(world, { kind: 'buildRoad', tiles });

    const built = tiles.map((t) => hasRoad(world.state.grid, t.x, t.y));
    expect(preview).toEqual(built);
    expect(built).toEqual([false, false, false, false, false]);
    expect(result.ok).toBe(false);
    expect(world.state.money).toBe(ECONOMY.COST_ROAD * 2);
  });

  it('道路: タイルごとに費用が違っても（橋を含む）プレビューが実結果と一致する', () => {
    const world = createWorld(SEED);
    const tiles = plainRow(world, 4);
    // 2枚目を水にして橋（COST_BRIDGE）にする。1タイルぶんの残高で判定していると
    // 「全部緑なのに橋の手前で止まる」が起きる
    setTerrain(world.state.grid, tiles[1]!.x, tiles[1]!.y, 'water');
    world.state.money = ECONOMY.COST_ROAD + ECONOMY.COST_BRIDGE - 1;

    const preview = previewBuildRoad(world, tiles);
    const before = world.state.money;
    const result = applyOp(world, { kind: 'buildRoad', tiles });
    const built = tiles.map((t) => hasRoad(world.state.grid, t.x, t.y));

    expect(preview).toEqual(built);
    expect(built).toEqual([false, false, false, false]);
    expect(result.ok).toBe(false);
    expect(world.state.money).toBe(before);
  });

  it('区画: 合計予算が足りなければプレビューも実適用も全滅する', () => {
    const world = createWorld(SEED);
    const tiles = plainRow(world, 6);
    world.state.money = ECONOMY.COST_ZONE * 3;

    const preview = previewPaintZone(world, 'residential', tiles);
    const before = world.state.money;
    const result = applyOp(world, { kind: 'paintZone', zone: 'residential', tiles });
    const painted = tiles.map((t) => zoneAt(world.state.grid, t.x, t.y) === 'residential');

    expect(preview).toEqual(painted);
    expect(painted).toEqual([false, false, false, false, false, false]);
    expect(result.ok).toBe(false);
    expect(world.state.money).toBe(before);
  });
});

describe('撤去範囲も資金不足なら全か無か', () => {
  it('道路撤去費が足りなければ無料部分も含めて変更しない', () => {
    const world = createWorld(SEED);
    const [a, b] = plainRow(world, 2);
    // a = 道路（有料の撤去）、b = 区画+建物（無料の撤去）
    setRoad(world.state.grid, a!.x, a!.y, true);
    setZone(world.state.grid, b!.x, b!.y, 'residential');
    const building = addBuilding(world, b!.x, b!.y);
    world.state.money = 0;

    const tiles = [a!, b!];
    const preview = previewDemolishArea(world, tiles);
    expect(preview).toEqual([false, false]);
    expect(canApplyOp(world, { kind: 'demolishArea', tiles }).ok).toBe(false);

    const result = applyOp(world, { kind: 'demolishArea', tiles });
    expect(result.ok).toBe(false);
    expect(hasRoad(world.state.grid, a!.x, a!.y)).toBe(true);
    expect(zoneAt(world.state.grid, b!.x, b!.y)).toBe('residential');
    expect(buildingIdAt(world.state.grid, b!.x, b!.y)).toBe(building.id);
    expect(world.state.buildings.find((x) => x.id === building.id)).toBeDefined();
    expect(world.state.money).toBe(0);
  });

  it('消せるものが1つも無いときは理由付きで却下する', () => {
    const world = createWorld(SEED);
    const tiles = plainRow(world, 2);
    world.state.money = 0;
    const res = canApplyOp(world, { kind: 'demolishArea', tiles });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('撤去するもの');
  });

  it('道路しか無く資金も無いときは資金不足として却下する', () => {
    const world = createWorld(SEED);
    const [a] = plainRow(world, 1);
    setRoad(world.state.grid, a!.x, a!.y, true);
    world.state.money = 0;
    const res = canApplyOp(world, { kind: 'demolishArea', tiles: [a!] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('資金');
  });
});

/**
 * T7: 幹線道路の操作（`docs/m4-trace-design.md` T7）。
 *
 * 「幹線」は `commitDrag`（`src/game/loop.ts`）が同じタイル列へ `buildRoad` →
 * `upgradeRoad` の順で2opを続けて出す合成操作なので、ここでもその2op適用を
 * そのまま再現して `previewUpgradeRoad` と突き合わせる（`world.preview.test.ts`
 * 冒頭の規約どおり「プレビューが緑にしたタイルは実際に適用される」を守る）。
 */
describe('T7: 幹線道路プレビューと確定結果の一致', () => {
  /** 更地に道路を新設して幹線化する場合の1タイルぶんの実費 */
  const ARTERIAL_FROM_PLAIN = ECONOMY.COST_ROAD + ECONOMY.COST_UPGRADE_ROAD;

  it('更地の列をなぞると、資金が足りれば全部ランク2になりプレビューと一致する', () => {
    const world = createWorld(SEED);
    const tiles = plainRow(world, 3);
    world.state.money = ARTERIAL_FROM_PLAIN * 3;

    const preview = previewUpgradeRoad(world, tiles);
    applyOp(world, { kind: 'buildRoad', tiles });
    applyOp(world, { kind: 'upgradeRoad', tiles });

    const arterial = tiles.map((t) => roadRankAt(world.state.grid, t.x, t.y) === 2);
    expect(preview).toEqual([true, true, true]);
    expect(arterial).toEqual(preview);
    expect(world.state.money).toBe(0);
  });

  it('合成費用が足りなければプレビューは全体が赤で、upgradeRoadは全か無かで失敗する', () => {
    const world = createWorld(SEED);
    const tiles = plainRow(world, 3);
    // 3タイル分の新設（COST_ROAD×3）はまかなえるが、幹線化（COST_UPGRADE_ROAD）は
    // 2タイル分しか残らない額にする
    world.state.money = ECONOMY.COST_ROAD * 3 + ECONOMY.COST_UPGRADE_ROAD * 2;

    const preview = previewUpgradeRoad(world, tiles);
    applyOp(world, { kind: 'buildRoad', tiles });
    applyOp(world, { kind: 'upgradeRoad', tiles });

    const ranks = tiles.map((t) => roadRankAt(world.state.grid, t.x, t.y));
    expect(preview).toEqual([false, false, false]);
    // UIの幹線操作はbuildRoadとupgradeRoadの2opなので、新設だけは全体へ適用される。
    // upgradeRoad自身は全か無かで拒否され、部分的な幹線は作られない。
    expect(ranks).toEqual([1, 1, 1]);
    expect(world.state.money).toBe(ECONOMY.COST_UPGRADE_ROAD * 2);
  });

  it('既存の通常道路の列をなぞると、build 費用ゼロで幹線化分だけプレビューと一致する', () => {
    const world = createWorld(SEED);
    const tiles = plainRow(world, 2);
    for (const t of tiles) setRoad(world.state.grid, t.x, t.y, true);
    world.state.money = ECONOMY.COST_UPGRADE_ROAD; // 1枚分しか払えない

    const preview = previewUpgradeRoad(world, tiles);
    applyOp(world, { kind: 'buildRoad', tiles }); // 既存道路のみ＝無料の素通り
    applyOp(world, { kind: 'upgradeRoad', tiles });

    const ranks = tiles.map((t) => roadRankAt(world.state.grid, t.x, t.y));
    expect(preview).toEqual([false, false]);
    expect(ranks).toEqual([1, 1]);
    expect(world.state.money).toBe(ECONOMY.COST_UPGRADE_ROAD);
  });

  it('既に幹線のタイルは追加費用なしで常にプレビューが有効になる', () => {
    const world = createWorld(SEED);
    const tiles = plainRow(world, 1);
    setRoadRank(world.state.grid, tiles[0]!.x, tiles[0]!.y, 2);
    world.state.money = 0;

    expect(previewUpgradeRoad(world, tiles)).toEqual([true]);
  });
});

/**
 * T7 §3/§4: 「縮小」（`downgradeRoad`）のプレビュー。
 *
 * `downgradeRoad` は `applyOp` 本体が予算チェックをせず、`canApplyOp` が対象タイル
 * 全体ぶんの費用を一括で見て入口で全か無かを決める。D8 により他の有料編集も
 * 同じ方針へ揃ったため、プレビューは「途中から赤」にせず対象全体を同じ色にする。
 */
describe('T7: 幹線道路の縮小プレビューと確定結果の一致', () => {
  it('全部払えるときは幹線タイルが全部プレビューで有効になり、実際に全部ランク1へ戻る', () => {
    const world = createWorld(SEED);
    const tiles = plainRow(world, 3);
    for (const t of tiles) setRoadRank(world.state.grid, t.x, t.y, 2);
    world.state.money = ECONOMY.COST_DOWNGRADE_ROAD * 3;

    const preview = previewDowngradeRoad(world, tiles);
    const result = applyOp(world, { kind: 'downgradeRoad', tiles });

    expect(preview).toEqual([true, true, true]);
    expect(result.ok).toBe(true);
    expect(tiles.map((t) => roadRankAt(world.state.grid, t.x, t.y))).toEqual([1, 1, 1]);
    expect(world.state.money).toBe(0);
  });

  it('1枚分でも足りないと全か無かで却下され、プレビューも全部無効になる（矛盾しない）', () => {
    const world = createWorld(SEED);
    const tiles = plainRow(world, 3);
    for (const t of tiles) setRoadRank(world.state.grid, t.x, t.y, 2);
    world.state.money = ECONOMY.COST_DOWNGRADE_ROAD * 3 - 1; // 1タイル分だけ足りない

    const preview = previewDowngradeRoad(world, tiles);
    const result = applyOp(world, { kind: 'downgradeRoad', tiles });

    expect(preview).toEqual([false, false, false]);
    expect(result.ok).toBe(false);
    // 却下されているので1枚もランクは変わっていない（部分適用も、想定外の減額も無い）
    expect(tiles.map((t) => roadRankAt(world.state.grid, t.x, t.y))).toEqual([2, 2, 2]);
    expect(world.state.money).toBe(ECONOMY.COST_DOWNGRADE_ROAD * 3 - 1);
  });

  it('通常道路・更地は対象にならない（幹線タイルだけがハイライトされる＝T7 §4）', () => {
    const world = createWorld(SEED);
    const [plain, normal, arterial] = plainRow(world, 3);
    setRoad(world.state.grid, normal!.x, normal!.y, true);
    setRoadRank(world.state.grid, arterial!.x, arterial!.y, 2);
    world.state.money = 1_000_000; // 資金は潤沢。対象外であることだけを見る

    void plain;
    const preview = previewDowngradeRoad(world, [plain!, normal!, arterial!]);
    expect(preview).toEqual([false, false, true]);
  });
});

// ROAD は未使用だが、道路アクセス距離を変えたときにこのテストの前提
// （平地の一列を使う）が壊れないことを示すために参照だけしておく
void ROAD.ROAD_ACCESS_DISTANCE;
