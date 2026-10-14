import type { GameState, TilePos, Vehicle } from '../types';

export interface TripTrace {
  vehicleId: number;
  kind: 'car' | 'truck';
  leg: 'outbound' | 'return';
  /** 出発元の建物（復路でも「家」を指す。UI が役割を入れ替えて表示する） */
  homeBuildingId: number;
  homePos: TilePos;
  destPos: TilePos;
  /** 道路タイル列。建物アクセスの座標は含まない */
  path: readonly TilePos[];
  edgeIndex: number;
  edgeProgress: number;
  elapsedTicks: number;
  /** 残りの道路タイル数 */
  remainingTiles: number;
  /** 表示用の状態。i18n のキーに1対1で対応させる */
  status: 'driving' | 'waiting' | 'access' | 'dwelling';
}

function displayStatus(vehicle: Vehicle): TripTrace['status'] {
  if (vehicle.intersectionWaitSinceTick !== undefined || vehicle.mergeWaitSinceTick !== undefined) {
    return 'waiting';
  }
  if (vehicle.phase === 'dwell') return 'dwelling';
  if (vehicle.phase === 'exiting' || vehicle.phase === 'entering') return 'access';
  return 'driving';
}

function remainingRoadTiles(vehicle: Vehicle): number {
  if (vehicle.phase === 'exiting') return vehicle.path.length;
  if (vehicle.phase !== 'road') return 0;
  return Math.max(0, vehicle.path.length - Math.max(0, vehicle.edgeIndex) - 1);
}

function traceOf(state: GameState, vehicle: Vehicle): TripTrace {
  return {
    vehicleId: vehicle.id,
    kind: vehicle.kind,
    leg: vehicle.leg,
    homeBuildingId: vehicle.purpose.fromBuildingId,
    homePos: vehicle.purpose.from,
    destPos: vehicle.purpose.to,
    path: vehicle.path,
    edgeIndex: vehicle.edgeIndex,
    edgeProgress: vehicle.edgeProgress,
    elapsedTicks: Math.max(0, state.tick - vehicle.legStartedTick),
    remainingTiles: remainingRoadTiles(vehicle),
    status: displayStatus(vehicle),
  };
}

export function traceVehicle(state: GameState, vehicleId: number): TripTrace | null {
  const vehicle = state.vehicles.find((candidate) => candidate.id === vehicleId);
  return vehicle ? traceOf(state, vehicle) : null;
}

export function tracesForBuilding(
  state: GameState,
  buildingId: number,
  limit: number,
): TripTrace[] {
  const building = state.buildings.find((candidate) => candidate.id === buildingId);
  const count = Math.max(0, Math.floor(limit));
  if (!building || count === 0) return [];

  return state.vehicles
    .filter(
      (vehicle) =>
        vehicle.purpose.fromBuildingId === buildingId ||
        (vehicle.purpose.to.x === building.pos.x && vehicle.purpose.to.y === building.pos.y),
    )
    .sort((a, b) => a.id - b.id)
    .slice(0, count)
    .map((vehicle) => traceOf(state, vehicle));
}
