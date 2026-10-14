import { describe, expect, it } from 'vitest';
import { breakdownByCounterpart } from './Inspector';
import type { TripTrace } from '../../sim/traffic/trace';
import type { TilePos, ZoneType } from '../../sim/types';

/**
 * `breakdownByCounterpart`（§3-4: 建物のインスペクタに相手先の内訳を出す）を、
 * `GameState` を組み立てずに純粋関数として検証する。`reasonsFor`
 * （`Inspector.tsx` 内、`BuildingSnapshot` を受け取る既存のテスト無しロジック）と
 * 同じ考え方で、World を持ち回らず値だけで完結させてある。
 */

function trace(overrides: Partial<TripTrace>): TripTrace {
  return {
    vehicleId: 0,
    kind: 'car',
    leg: 'outbound',
    homeBuildingId: 0,
    homePos: { x: 0, y: 0 },
    destPos: { x: 0, y: 0 },
    path: [],
    edgeIndex: 0,
    edgeProgress: 0,
    elapsedTicks: 0,
    remainingTiles: 0,
    status: 'driving',
    ...overrides,
  };
}

const HOME: TilePos = { x: 5, y: 5 }; // b 自身の位置
const COMMERCIAL: TilePos = { x: 18, y: 3 };
const INDUSTRIAL: TilePos = { x: 4, y: 20 };
const OTHER_HOME_A: TilePos = { x: 2, y: 2 };
const OTHER_HOME_B: TilePos = { x: 9, y: 9 };

const B = { id: 1, pos: HOME };

function zoneOf(pos: TilePos): ZoneType | null {
  if (pos.x === COMMERCIAL.x && pos.y === COMMERCIAL.y) return 'commercial';
  if (pos.x === INDUSTRIAL.x && pos.y === INDUSTRIAL.y) return 'industrial';
  if (pos.x === OTHER_HOME_A.x && pos.y === OTHER_HOME_A.y) return 'residential';
  return null; // OTHER_HOME_B は空き地/退去済みという想定
}

describe('breakdownByCounterpart（§3-4）', () => {
  it('往路: b が home なら出発中、相手は dest', () => {
    const traces = [
      trace({ leg: 'outbound', homeBuildingId: B.id, homePos: HOME, destPos: COMMERCIAL }),
      trace({ leg: 'outbound', homeBuildingId: B.id, homePos: HOME, destPos: COMMERCIAL }),
      trace({ leg: 'outbound', homeBuildingId: B.id, homePos: HOME, destPos: INDUSTRIAL }),
    ];
    const { departing, arriving } = breakdownByCounterpart(traces, B, zoneOf);
    expect(arriving).toEqual([]);
    expect(departing).toEqual([
      { pos: COMMERCIAL, zone: 'commercial', count: 2 },
      { pos: INDUSTRIAL, zone: 'industrial', count: 1 },
    ]);
  });

  it('往路: b が dest なら向かっている、相手は home', () => {
    const traces = [
      trace({ leg: 'outbound', homeBuildingId: 99, homePos: OTHER_HOME_A, destPos: HOME }),
    ];
    const { departing, arriving } = breakdownByCounterpart(traces, B, zoneOf);
    expect(departing).toEqual([]);
    expect(arriving).toEqual([{ pos: OTHER_HOME_A, zone: 'residential', count: 1 }]);
  });

  it('復路: b が home（destPos側ではない）なら向かっている、相手は元の dest', () => {
    const traces = [
      trace({ leg: 'return', homeBuildingId: B.id, homePos: HOME, destPos: COMMERCIAL }),
    ];
    const { departing, arriving } = breakdownByCounterpart(traces, B, zoneOf);
    expect(departing).toEqual([]);
    expect(arriving).toEqual([{ pos: COMMERCIAL, zone: 'commercial', count: 1 }]);
  });

  it('復路: b が元の dest（＝復路の出発地）なら出発中、相手は home', () => {
    const traces = [
      trace({ leg: 'return', homeBuildingId: 42, homePos: OTHER_HOME_B, destPos: HOME }),
    ];
    const { departing, arriving } = breakdownByCounterpart(traces, B, zoneOf);
    expect(arriving).toEqual([]);
    // OTHER_HOME_B は zoneOf が null を返す想定（空き地/退去済みでも壊れないこと）
    expect(departing).toEqual([{ pos: OTHER_HOME_B, zone: null, count: 1 }]);
  });

  it('件数の多い相手が先頭。同数はタイル座標で安定した順になる', () => {
    const traces = [
      trace({ leg: 'outbound', homeBuildingId: B.id, homePos: HOME, destPos: COMMERCIAL }),
      trace({ leg: 'outbound', homeBuildingId: B.id, homePos: HOME, destPos: COMMERCIAL }),
      trace({ leg: 'outbound', homeBuildingId: B.id, homePos: HOME, destPos: INDUSTRIAL }),
      trace({ leg: 'return', homeBuildingId: 42, homePos: OTHER_HOME_B, destPos: HOME }),
    ];
    const { departing } = breakdownByCounterpart(traces, B, zoneOf);
    expect(departing.map((d) => `${d.pos.x},${d.pos.y}`)).toEqual(['18,3', '4,20', '9,9']);
  });

  it('b と無関係なトリップ（home でも dest でもない）は無視する', () => {
    const traces = [trace({ leg: 'outbound', homeBuildingId: 999, homePos: { x: 0, y: 0 }, destPos: { x: 1, y: 1 } })];
    const { departing, arriving } = breakdownByCounterpart(traces, B, zoneOf);
    expect(departing).toEqual([]);
    expect(arriving).toEqual([]);
  });
});
