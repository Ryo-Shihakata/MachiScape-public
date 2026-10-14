import { describe, expect, it } from 'vitest';
import { ECONOMY, FACILITY, GROWTH } from '../balance';
import { facilityIdAt, setRoad, setTerrain, setZone, terrainAt, zoneAt } from '../grid';
import { applyTripFailure } from '../traffic/trips';
import { tileKey, type Building } from '../types';
import { advance, applyOp, canApplyOp, createWorld, previewPlaceFacility } from '../world';
import { facilityTiles, satisfactionFloorAt } from '.';

const SEED = 20260802;

function plainWorld() {
  const world = createWorld(SEED);
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) setTerrain(world.state.grid, x, y, 'plain');
  }
  for (let x = 0; x < 32; x++) setRoad(world.state.grid, x, 10, true);
  world.state.money = 10_000;
  return world;
}

function addHome(world: ReturnType<typeof createWorld>, x: number, y: number, satisfaction = 50) {
  const building: Building = {
    id: world.state.nextId++,
    pos: { x, y },
    zone: 'residential',
    level: 1,
    occupied: true,
    satisfaction,
    lowSatisfactionDays: 0,
    tripsOkToday: 0,
    tripsFailToday: 0,
  };
  world.state.buildings.push(building);
  world.state.grid.buildingIndex[tileKey(x, y)] = building.id;
  return building;
}

describe('施設の配置と撤去', () => {
  it('footprint=4 は左上から2x2の4タイルを固定順で返す', () => {
    expect(facilityTiles({ x: 3, y: 7 }, 4)).toEqual([
      { x: 3, y: 7 },
      { x: 4, y: 7 },
      { x: 3, y: 8 },
      { x: 4, y: 8 },
    ]);
  });

  it('森の伐採費を含めて全か無かで配置し、占有索引と区画を更新する', () => {
    const world = plainWorld();
    const pos = { x: 5, y: 11 };
    setTerrain(world.state.grid, pos.x, pos.y, 'forest');
    setZone(world.state.grid, pos.x, pos.y, 'residential');
    world.state.money = FACILITY.PARK_COST + ECONOMY.COST_CLEAR_FOREST;

    expect(previewPlaceFacility(world, 'park', pos)).toEqual([true]);
    expect(applyOp(world, { kind: 'placeFacility', defId: 'park', pos })).toEqual({ ok: true });

    const placed = world.state.facilities[0];
    expect(placed).toBeDefined();
    expect(facilityIdAt(world.state.grid, pos.x, pos.y)).toBe(placed?.id);
    expect(terrainAt(world.state.grid, pos.x, pos.y)).toBe('plain');
    expect(zoneAt(world.state.grid, pos.x, pos.y)).toBeNull();
    expect(world.state.money).toBe(0);
  });

  it('資金が1不足するだけでも施設・森・区画を一切変更しない', () => {
    const world = plainWorld();
    const pos = { x: 5, y: 11 };
    setTerrain(world.state.grid, pos.x, pos.y, 'forest');
    setZone(world.state.grid, pos.x, pos.y, 'residential');
    world.state.money = FACILITY.PARK_COST + ECONOMY.COST_CLEAR_FOREST - 1;

    expect(previewPlaceFacility(world, 'park', pos)).toEqual([false]);
    expect(applyOp(world, { kind: 'placeFacility', defId: 'park', pos }).ok).toBe(false);
    expect(world.state.facilities).toHaveLength(0);
    expect(facilityIdAt(world.state.grid, pos.x, pos.y)).toBeUndefined();
    expect(terrainAt(world.state.grid, pos.x, pos.y)).toBe('forest');
    expect(zoneAt(world.state.grid, pos.x, pos.y)).toBe('residential');
  });

  it('未解放・道路アクセスなし・道路や建物や施設との重複を拒否する', () => {
    const world = plainWorld();
    expect(
      canApplyOp(world, { kind: 'placeFacility', defId: 'school', pos: { x: 5, y: 11 } }).ok,
    ).toBe(false);

    world.state.progress.achievedMilestones.push('pop100');
    expect(
      canApplyOp(world, { kind: 'placeFacility', defId: 'school', pos: { x: 20, y: 20 } }).ok,
    ).toBe(false);
    expect(
      canApplyOp(world, { kind: 'placeFacility', defId: 'school', pos: { x: 5, y: 10 } }).ok,
    ).toBe(false);

    addHome(world, 5, 11);
    expect(
      canApplyOp(world, { kind: 'placeFacility', defId: 'school', pos: { x: 5, y: 11 } }).ok,
    ).toBe(false);

    expect(applyOp(world, { kind: 'placeFacility', defId: 'park', pos: { x: 6, y: 11 } }).ok).toBe(
      true,
    );
    expect(
      canApplyOp(world, { kind: 'placeFacility', defId: 'school', pos: { x: 6, y: 11 } }).ok,
    ).toBe(false);
  });

  it('撤去で全占有索引を消し、建設費の25%を返金して施設行きの車を消す', () => {
    const world = plainWorld();
    const pos = { x: 8, y: 11 };
    applyOp(world, { kind: 'placeFacility', defId: 'park', pos });
    const facility = world.state.facilities[0]!;
    const home = addHome(world, 2, 9);
    world.state.vehicles.push({
      id: world.state.nextId++,
      kind: 'car',
      mode: 'road',
      leg: 'outbound',
      legStartedTick: 0,
      dwellUntilTick: null,
      phase: 'road',
      accessProgress: 0,
      path: [
        { x: 2, y: 10 },
        { x: 8, y: 10 },
      ],
      edgeIndex: 0,
      edgeProgress: 0,
      purpose: { fromBuildingId: home.id, from: home.pos, to: pos, startedTick: 0 },
    });
    const before = world.state.money;

    expect(applyOp(world, { kind: 'removeFacility', id: facility.id })).toEqual({ ok: true });
    expect(world.state.facilities).toHaveLength(0);
    expect(facilityIdAt(world.state.grid, pos.x, pos.y)).toBeUndefined();
    expect(world.state.vehicles).toHaveLength(0);
    expect(world.state.money - before).toBe(Math.floor(FACILITY.PARK_COST * FACILITY.REFUND_RATIO));
  });
});

describe('公園の満足度下限', () => {
  it('配置直後から範囲内住宅を下限まで上げ、その後の失敗でも下回らせない', () => {
    const world = plainWorld();
    const home = addHome(world, 5, 12, 10);
    expect(applyOp(world, { kind: 'placeFacility', defId: 'park', pos: { x: 6, y: 11 } }).ok).toBe(
      true,
    );

    expect(satisfactionFloorAt(world.state, home.pos)).toBe(FACILITY.PARK_SATISFACTION_FLOOR);
    expect(home.satisfaction).toBe(FACILITY.PARK_SATISFACTION_FLOOR);
    for (let i = 0; i < 20; i++) applyTripFailure(world.state, home);
    expect(home.satisfaction).toBe(FACILITY.PARK_SATISFACTION_FLOOR);
  });

  it('同じ公園を重ねても下限は累積せず、範囲外には効かない', () => {
    const world = plainWorld();
    applyOp(world, { kind: 'placeFacility', defId: 'park', pos: { x: 5, y: 11 } });
    applyOp(world, { kind: 'placeFacility', defId: 'park', pos: { x: 7, y: 11 } });

    expect(satisfactionFloorAt(world.state, { x: 6, y: 12 })).toBe(
      FACILITY.PARK_SATISFACTION_FLOOR,
    );
    expect(satisfactionFloorAt(world.state, { x: 20, y: 20 })).toBe(0);
    expect(GROWTH.SATISFACTION_MIN).toBe(0);
  });
});

describe('施設を含む決定論', () => {
  it('同じseedと学校配置を含む操作列なら10,000tick後のWorldが一致する', () => {
    const run = () => {
      const world = plainWorld();
      world.state.progress.achievedMilestones.push('pop100');
      addHome(world, 1, 9);
      const shop: Building = {
        id: world.state.nextId++,
        pos: { x: 15, y: 9 },
        zone: 'commercial',
        level: 1,
        occupied: true,
        satisfaction: 50,
        stock: 100,
        lowSatisfactionDays: 0,
        tripsOkToday: 0,
        tripsFailToday: 0,
      };
      world.state.buildings.push(shop);
      world.state.grid.buildingIndex[tileKey(shop.pos.x, shop.pos.y)] = shop.id;
      expect(
        applyOp(world, { kind: 'placeFacility', defId: 'school', pos: { x: 8, y: 9 } }).ok,
      ).toBe(true);
      advance(world, 10_000);
      return world;
    };

    expect(run()).toEqual(run());
  });
});
