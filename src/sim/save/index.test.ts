import { describe, expect, it } from 'vitest';
import { createCongestionMap } from '../road/congestion';
import { setRoad, setTerrain } from '../grid';
import type { Building, Vehicle } from '../types';
import { advance, createWorld, type World } from '../world';
import {
  base64ToBytes,
  bytesToBase64,
  createSaveGame,
  loadSaveGame,
  SAVE_SCHEMA_VERSION,
  stringifySaveGame,
  type SaveGame,
} from '.';

function building(id: number, x: number, zone: Building['zone']): Building {
  return {
    id,
    pos: { x, y: 1 },
    zone,
    level: 1,
    occupied: true,
    satisfaction: 70,
    lowSatisfactionDays: 0,
    tripsOkToday: 0,
    tripsFailToday: 0,
    ...(zone === 'commercial' ? { stock: 100 } : {}),
  };
}

function worldWithTrips(): World {
  const world = createWorld(20260802);
  for (let x = 1; x <= 5; x++) {
    setTerrain(world.state.grid, x, 1, 'plain');
    setTerrain(world.state.grid, x, 2, 'plain');
    setRoad(world.state.grid, x, 2, true);
  }
  const home = building(1, 1, 'residential');
  const shop = building(2, 5, 'commercial');
  world.state.buildings = [home, shop];
  world.state.grid.buildingIndex['1,1'] = home.id;
  world.state.grid.buildingIndex['5,1'] = shop.id;
  world.state.nextId = 3;
  return world;
}

function restoredWorld(save: SaveGame): World {
  const result = loadSaveGame(save);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  return {
    state: result.save.state,
    congestion: createCongestionMap(),
    rng: { state: result.save.state.rngState },
  };
}

describe('セーブ形式', () => {
  it('Uint8Array を base64 で往復できる', () => {
    const bytes = new Uint8Array([0, 1, 2, 127, 128, 254, 255]);
    const encoded = bytesToBase64(bytes);
    expect(encoded).toBe('AAECf4D+/w==');
    expect(base64ToBytes(encoded)).toEqual(bytes);
    expect(base64ToBytes('AA=A')).toBeNull();
  });

  it('grid は base64 になり、transient な vehicles は保存にも復元にも含まれない', () => {
    const world = worldWithTrips();
    const vehicle: Vehicle = {
      id: 99,
      kind: 'car',
      mode: 'road',
      leg: 'outbound',
      legStartedTick: 0,
      dwellUntilTick: null,
      phase: 'road',
      accessProgress: 0,
      path: [
        { x: 1, y: 2 },
        { x: 2, y: 2 },
      ],
      edgeIndex: 0,
      edgeProgress: 0,
      purpose: {
        fromBuildingId: 1,
        from: { x: 1, y: 1 },
        to: { x: 5, y: 1 },
        startedTick: 0,
      },
    };
    world.state.vehicles.push(vehicle);

    const save = createSaveGame(world.state, '2026-08-02T00:00:00.000Z', 'test');
    expect(save.schemaVersion).toBe(SAVE_SCHEMA_VERSION);
    expect(typeof save.state.grid.terrain['0,0']).toBe('string');
    expect(stringifySaveGame(save)).not.toContain('"vehicles"');

    const result = loadSaveGame(save);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.save.state.vehicles).toEqual([]);
    expect(result.save.state.grid.terrain['0,0']).toBeInstanceOf(Uint8Array);
    expect(result.save.state.grid.terrain['0,0']).toEqual(world.state.grid.terrain['0,0']);
  });

  it('保存→読み込み後も rngState を含む状態が復元され、同じ advance 結果になる', () => {
    const original = worldWithTrips();
    advance(original, 137);

    // ロード時と同じ境界に揃える。走行中の車と、その車が作った混雑はどちらも transient。
    original.state.vehicles = [];
    original.congestion = createCongestionMap();
    const save = createSaveGame(original.state, '2026-08-02T00:00:00.000Z', 'determinism');
    const loaded = restoredWorld(save);

    advance(original, 900);
    advance(loaded, 900);

    expect(loaded.state).toEqual(original.state);
    expect(loaded.rng.state).toBe(original.rng.state);
    expect(loaded.congestion).toEqual(original.congestion);
  });

  it('壊れたJSON・壊れたbase64・未知の版を例外にせず明示的に失敗する', () => {
    expect(loadSaveGame('{not json')).toEqual({ ok: false, error: 'invalid-json' });

    const valid = createSaveGame(worldWithTrips().state, '2026-08-02T00:00:00.000Z', 'test');
    const corrupt = structuredClone(valid);
    corrupt.state.grid.terrain['0,0'] = '%%%=';
    expect(loadSaveGame(corrupt)).toEqual({ ok: false, error: 'invalid-save' });

    expect(loadSaveGame({ ...valid, schemaVersion: 0 })).toEqual({
      ok: false,
      error: 'unsupported-version',
    });
    expect(loadSaveGame({ ...valid, schemaVersion: SAVE_SCHEMA_VERSION + 1 })).toEqual({
      ok: false,
      error: 'unsupported-version',
    });
  });
});
