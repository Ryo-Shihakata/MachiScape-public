/**
 * セーブ形式の純粋な変換（実装書 §13）。
 *
 * IndexedDB・時計・ファイル操作はブラウザ側に残し、ここは値の検証と変換だけを行う。
 * セーブ処理を sim の時刻や DOM に結び付けると、同じ入力列を再生する決定論テストまで
 * ブラウザ環境に依存してしまうため。
 */

import { SPACE } from '../balance';
import type {
  Building,
  DayReport,
  District,
  Facility,
  GameState,
  Grid,
  IntersectionAxis,
  IntersectionSignalState,
  Progress,
  TilePos,
} from '../types';

export const SAVE_SCHEMA_VERSION = 1;
export type SaveSlot = 'auto' | 'manual-1' | 'manual-2' | 'manual-3';
export const MANUAL_SAVE_SLOTS: readonly SaveSlot[] = ['manual-1', 'manual-2', 'manual-3'];

type EncodedGrid = Omit<Grid, 'terrain' | 'road' | 'zone'> & {
  terrain: Record<string, string>;
  road: Record<string, string>;
  zone: Record<string, string>;
};

export type EncodedGameState = Omit<GameState, 'grid' | 'vehicles'> & {
  grid: EncodedGrid;
};

export interface SaveGame {
  schemaVersion: number;
  savedAt: string;
  name: string;
  state: EncodedGameState;
}

export interface LoadedSaveGame {
  schemaVersion: number;
  savedAt: string;
  name: string;
  state: GameState;
}

export type SaveLoadError =
  'invalid-json' | 'invalid-save' | 'unsupported-version' | 'migration-failed';

export type SaveLoadResult =
  { ok: true; save: LoadedSaveGame } | { ok: false; error: SaveLoadError };

export type SaveMigration = (oldSave: unknown) => unknown;

/**
 * キー n は schemaVersion n から n+1 への変換を表す。
 * v1 の時点でも入口を固定しておかないと、最初の形式変更時にロード処理を丸ごと
 * 書き換えることになるため、空の移行表を先に用意する。
 */
export const migrations: Record<number, SaveMigration> = {};

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const CHUNK_BYTES = SPACE.CHUNK_SIZE * SPACE.CHUNK_SIZE;

/** Uint8Array をランタイム非依存の base64 にする。 */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const hasB = i + 1 < bytes.length;
    const hasC = i + 2 < bytes.length;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const n = (a << 16) | (b << 8) | c;
    out += BASE64_ALPHABET[(n >>> 18) & 63];
    out += BASE64_ALPHABET[(n >>> 12) & 63];
    out += hasB ? BASE64_ALPHABET[(n >>> 6) & 63] : '=';
    out += hasC ? BASE64_ALPHABET[n & 63] : '=';
  }
  return out;
}

/** 不正な文字・padding・長さを許容しない base64 デコーダ。 */
export function base64ToBytes(encoded: string): Uint8Array | null {
  if (encoded.length === 0) return new Uint8Array();
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null;
  const firstPadding = encoded.indexOf('=');
  if (firstPadding >= 0 && firstPadding < encoded.length - 2) return null;

  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((encoded.length / 4) * 3 - padding);
  let offset = 0;
  for (let i = 0; i < encoded.length; i += 4) {
    const a = BASE64_ALPHABET.indexOf(encoded[i] ?? '');
    const b = BASE64_ALPHABET.indexOf(encoded[i + 1] ?? '');
    const c = encoded[i + 2] === '=' ? 0 : BASE64_ALPHABET.indexOf(encoded[i + 2] ?? '');
    const d = encoded[i + 3] === '=' ? 0 : BASE64_ALPHABET.indexOf(encoded[i + 3] ?? '');
    if (a < 0 || b < 0 || c < 0 || d < 0) return null;
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    if (offset < out.length) out[offset++] = (n >>> 16) & 255;
    if (offset < out.length) out[offset++] = (n >>> 8) & 255;
    if (offset < out.length) out[offset++] = n & 255;
  }
  // 非canonicalな末尾ビットも破損扱いにし、同じバイト列に複数の表現を持たせない。
  return bytesToBase64(out) === encoded ? out : null;
}

function encodeArrays(source: Record<string, Uint8Array>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(source).map(([key, bytes]) => [key, bytesToBase64(bytes)]),
  );
}

/** vehicles を落とし、grid のバイト列だけを base64 に変える。入力 state は変更しない。 */
export function createSaveGame(state: GameState, savedAt: string, name: string): SaveGame {
  const stateFields = { ...state } as Partial<GameState>;
  delete stateFields.grid;
  delete stateFields.vehicles;
  return {
    schemaVersion: SAVE_SCHEMA_VERSION,
    savedAt,
    name,
    state: {
      ...stateFields,
      grid: {
        terrain: encodeArrays(state.grid.terrain),
        road: encodeArrays(state.grid.road),
        zone: encodeArrays(state.grid.zone),
        buildingIndex: { ...state.grid.buildingIndex },
        facilityIndex: { ...state.grid.facilityIndex },
      },
    } as EncodedGameState,
  };
}

export function stringifySaveGame(save: SaveGame): string {
  return JSON.stringify(save, null, 2);
}

/** JSON文字列・IndexedDBの値のどちらも、例外を外へ漏らさず同じ検証経路へ通す。 */
export function loadSaveGame(input: string | unknown): SaveLoadResult {
  let value: unknown = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input) as unknown;
    } catch {
      return { ok: false, error: 'invalid-json' };
    }
  }

  if (!isRecord(value) || !isInteger(value.schemaVersion)) {
    return { ok: false, error: 'invalid-save' };
  }
  if (value.schemaVersion > SAVE_SCHEMA_VERSION || value.schemaVersion < 1) {
    return { ok: false, error: 'unsupported-version' };
  }

  try {
    while (value.schemaVersion < SAVE_SCHEMA_VERSION) {
      const migration = migrations[value.schemaVersion];
      if (!migration) return { ok: false, error: 'unsupported-version' };
      value = migration(value);
      if (!isRecord(value) || !isInteger(value.schemaVersion)) {
        return { ok: false, error: 'migration-failed' };
      }
    }
  } catch {
    return { ok: false, error: 'migration-failed' };
  }

  if (
    !isRecord(value) ||
    value.schemaVersion !== SAVE_SCHEMA_VERSION ||
    typeof value.savedAt !== 'string' ||
    typeof value.name !== 'string' ||
    !isRecord(value.state)
  ) {
    return { ok: false, error: 'invalid-save' };
  }

  const grid = decodeGrid(value.state.grid);
  if (!grid) return { ok: false, error: 'invalid-save' };
  const state = { ...value.state, grid, vehicles: [] };
  if (!isGameState(state)) return { ok: false, error: 'invalid-save' };

  return {
    ok: true,
    save: {
      schemaVersion: value.schemaVersion,
      savedAt: value.savedAt,
      name: value.name,
      state,
    },
  };
}

function decodeGrid(value: unknown): Grid | null {
  if (!isRecord(value)) return null;
  const terrain = decodeArrays(value.terrain);
  const road = decodeArrays(value.road);
  const zone = decodeArrays(value.zone);
  if (!terrain || !road || !zone) return null;
  const terrainKeys = Object.keys(terrain).sort();
  if (
    JSON.stringify(terrainKeys) !== JSON.stringify(Object.keys(road).sort()) ||
    JSON.stringify(terrainKeys) !== JSON.stringify(Object.keys(zone).sort()) ||
    !isNumberRecord(value.buildingIndex) ||
    !isNumberRecord(value.facilityIndex)
  ) {
    return null;
  }
  return {
    terrain,
    road,
    zone,
    buildingIndex: { ...value.buildingIndex },
    facilityIndex: { ...value.facilityIndex },
  };
}

function decodeArrays(value: unknown): Record<string, Uint8Array> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, Uint8Array> = {};
  for (const [key, encoded] of Object.entries(value)) {
    if (!isChunkKey(key) || typeof encoded !== 'string') return null;
    const bytes = base64ToBytes(encoded);
    if (!bytes || bytes.length !== CHUNK_BYTES) return null;
    out[key] = bytes;
  }
  return out;
}

function isGameState(value: unknown): value is GameState {
  if (!isRecord(value)) return false;
  return (
    isInteger(value.seed) &&
    isInteger(value.rngState) &&
    isNonNegativeInteger(value.tick) &&
    isFiniteNumber(value.money) &&
    isNonNegativeInteger(value.nextId) &&
    isGrid(value.grid) &&
    Array.isArray(value.buildings) &&
    value.buildings.every(isBuilding) &&
    Array.isArray(value.facilities) &&
    value.facilities.every(isFacility) &&
    Array.isArray(value.vehicles) &&
    value.vehicles.length === 0 &&
    Array.isArray(value.districts) &&
    value.districts.every(isDistrict) &&
    isProgress(value.progress) &&
    isOptionalAxisRecord(value.intersectionPriorities) &&
    isOptionalAxisRecord(value.intersectionLastServedAxes) &&
    isOptionalSignalRecord(value.intersectionSignals)
  );
}

function isGrid(value: unknown): value is Grid {
  return (
    isRecord(value) &&
    isByteRecord(value.terrain) &&
    isByteRecord(value.road) &&
    isByteRecord(value.zone) &&
    isNumberRecord(value.buildingIndex) &&
    isNumberRecord(value.facilityIndex)
  );
}

function isBuilding(value: unknown): value is Building {
  if (!isRecord(value)) return false;
  return (
    isNonNegativeInteger(value.id) &&
    isTilePos(value.pos) &&
    (value.zone === 'residential' || value.zone === 'commercial' || value.zone === 'industrial') &&
    value.level === 1 &&
    typeof value.occupied === 'boolean' &&
    isFiniteNumber(value.satisfaction) &&
    isOptionalFiniteNumber(value.stock) &&
    isOptionalFiniteNumber(value.output) &&
    isNonNegativeInteger(value.lowSatisfactionDays) &&
    isNonNegativeInteger(value.tripsOkToday) &&
    isNonNegativeInteger(value.tripsFailToday)
  );
}

function isFacility(value: unknown): value is Facility {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.id) &&
    typeof value.defId === 'string' &&
    isTilePos(value.pos)
  );
}

function isDistrict(value: unknown): value is District {
  return (
    isRecord(value) &&
    isInteger(value.cx) &&
    isInteger(value.cy) &&
    typeof value.purchased === 'boolean'
  );
}

function isProgress(value: unknown): value is Progress {
  return (
    isRecord(value) &&
    Array.isArray(value.achievedMilestones) &&
    value.achievedMilestones.every((id) => typeof id === 'string') &&
    typeof value.tutorialDone === 'boolean' &&
    (value.lastDayReport === null || isDayReport(value.lastDayReport)) &&
    Array.isArray(value.dayReports) &&
    value.dayReports.every(isDayReport) &&
    isNonNegativeInteger(value.totalTrips) &&
    isNonNegativeInteger(value.failedTrips) &&
    isNonNegativeInteger(value.tripsToday) &&
    isNonNegativeInteger(value.failedToday) &&
    isNonNegativeInteger(value.tripsLastDay) &&
    isNonNegativeInteger(value.failedLastDay) &&
    isNonNegativeInteger(value.unservedToday) &&
    isNonNegativeInteger(value.unservedLastDay)
  );
}

function isDayReport(value: unknown): value is DayReport {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.day) &&
    isFiniteNumber(value.taxR) &&
    isFiniteNumber(value.taxC) &&
    isFiniteNumber(value.taxI) &&
    isFiniteNumber(value.upkeepRoad) &&
    isFiniteNumber(value.upkeepFacility) &&
    isFiniteNumber(value.rewards) &&
    isNonNegativeInteger(value.popStart) &&
    isNonNegativeInteger(value.popEnd)
  );
}

function isTilePos(value: unknown): value is TilePos {
  return isRecord(value) && isInteger(value.x) && isInteger(value.y);
}

function isOptionalAxisRecord(
  value: unknown,
): value is Record<string, IntersectionAxis> | undefined {
  return value === undefined || (isRecord(value) && Object.values(value).every(isAxis));
}

function isOptionalSignalRecord(
  value: unknown,
): value is Record<string, IntersectionSignalState> | undefined {
  return value === undefined || (isRecord(value) && Object.values(value).every(isSignal));
}

function isSignal(value: unknown): value is IntersectionSignalState {
  if (!isRecord(value) || !isNonNegativeInteger(value.phaseStartedTick)) return false;
  if (value.phase === 'green') return isAxis(value.greenAxis);
  return (
    value.phase === 'allRed' &&
    value.greenAxis === null &&
    isAxis(value.clearingAxis) &&
    isAxis(value.nextGreenAxis)
  );
}

function isAxis(value: unknown): value is IntersectionAxis {
  return value === 'horizontal' || value === 'vertical';
}

function isByteRecord(value: unknown): value is Record<string, Uint8Array> {
  return (
    isRecord(value) &&
    Object.entries(value).every(
      ([key, bytes]) =>
        isChunkKey(key) && bytes instanceof Uint8Array && bytes.length === CHUNK_BYTES,
    )
  );
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  return isRecord(value) && Object.values(value).every(isNonNegativeInteger);
}

function isChunkKey(key: string): boolean {
  return /^-?\d+,-?\d+$/.test(key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isOptionalFiniteNumber(value: unknown): value is number | undefined {
  return value === undefined || isFiniteNumber(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return isInteger(value) && value >= 0;
}
