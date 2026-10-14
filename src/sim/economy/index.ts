/**
 * 経済（実装書 §9）。
 *
 * 日次精算: 入居済みの建物から税収を集め、道路・施設の維持費を引き、
 * 純増減を `state.money` に反映して `DayReport` を残す。
 *
 * 設計判断（仕様に明記が無いため、ここで決めたことを明記する）:
 * `state.money` は負にならない。税収は全額受け取り、維持費は
 * 「まず全部引いてみて、0を下回ったら0で止める」という一括計算にしている
 * （道路と施設のどちらの維持費が払えなかったかを区別しない）。
 * 実装書 §8.3「破産・ゲームオーバーは存在しない」に沿う扱い。
 */

import { ECONOMY, GROWTH, SPACE, TIME, UI } from '../balance';
import { roadRankAt, terrainAt } from '../grid';
import { facilityDef } from '../facility/defs';
import type { GameState } from '../types';
import type { DayReport } from '../types';
import type { BuildingStats, SettleDay } from '../pipeline';

const CS = SPACE.CHUNK_SIZE;

/** 解放済みチャンクの道路タイル数（維持費の算出に使う） */
export function countRoadTiles(state: GameState): number {
  let count = 0;
  for (const d of state.districts) {
    for (let ly = 0; ly < CS; ly++) {
      for (let lx = 0; lx < CS; lx++) {
        const x = d.cx * CS + lx;
        const y = d.cy * CS + ly;
        if (roadRankAt(state.grid, x, y) > 0) count++;
      }
    }
  }
  return count;
}

/**
 * 道路種別ごとの維持費。橋は道路ランクの費用に橋梁分を上乗せする。
 */
export function roadUpkeep(state: GameState): number {
  let upkeep = 0;
  for (const district of state.districts) {
    for (let ly = 0; ly < CS; ly++) {
      for (let lx = 0; lx < CS; lx++) {
        const x = district.cx * CS + lx;
        const y = district.cy * CS + ly;
        const rank = roadRankAt(state.grid, x, y);
        if (rank === 0) continue;
        upkeep += rank === 2 ? ECONOMY.UPKEEP_ARTERIAL_PER_DAY : ECONOMY.UPKEEP_ROAD_PER_DAY;
        if (terrainAt(state.grid, x, y) === 'water') {
          upkeep += ECONOMY.UPKEEP_BRIDGE_SURCHARGE_PER_DAY;
        }
      }
    }
  }
  return upkeep;
}

/** 施設定義にある1日あたり維持費の合算。 */
export function facilityUpkeep(state: GameState): number {
  return state.facilities.reduce((sum, facility) => {
    return sum + (facilityDef(facility.defId)?.upkeep ?? 0);
  }, 0);
}

interface TaxBreakdown {
  taxR: number;
  taxC: number;
  taxI: number;
}

/** 入居済みの建物から税収を集計する（実装書 §9） */
function computeTaxIncome(state: GameState): TaxBreakdown {
  let taxR = 0;
  let taxC = 0;
  let taxI = 0;
  for (const b of state.buildings) {
    if (!b.occupied) continue;
    switch (b.zone) {
      case 'residential':
        taxR += ECONOMY.TAX_RESIDENTIAL;
        break;
      case 'commercial':
        // 在庫切れの日は半額（実装書 §9）
        taxC += b.stock === 0 ? ECONOMY.TAX_COMMERCIAL / 2 : ECONOMY.TAX_COMMERCIAL;
        break;
      case 'industrial':
        taxI += ECONOMY.TAX_INDUSTRIAL;
        break;
    }
  }
  return { taxR, taxC, taxI };
}

/** 入居済み residential 棟数から人口を数え直す（実装書 §8.1: pop = 8 × occupiedR） */
function countPopulation(state: GameState): number {
  let occupiedR = 0;
  for (const b of state.buildings) {
    if (b.zone === 'residential' && b.occupied) occupiedR++;
  }
  return occupiedR * GROWTH.POP_PER_BUILDING;
}

function currentDay(state: GameState): number {
  return Math.floor(state.tick / TIME.TICKS_PER_DAY);
}

/** 日次精算（実装書 §9・pipeline.ts の契約） */
export const settleDay: SettleDay = (state: GameState, stats: BuildingStats, rewards = 0): void => {
  const { taxR, taxC, taxI } = computeTaxIncome(state);
  const upkeepRoad = roadUpkeep(state);
  const upkeepFacility = facilityUpkeep(state);

  const net = taxR + taxC + taxI - upkeepRoad - upkeepFacility + rewards;
  // 残高は負にならない（このファイル冒頭の設計判断を参照）
  state.money = Math.max(0, state.money + net);

  const report: DayReport = {
    day: currentDay(state),
    taxR,
    taxC,
    taxI,
    upkeepRoad,
    upkeepFacility,
    rewards,
    popStart: stats.population,
    popEnd: countPopulation(state),
  };

  state.progress.lastDayReport = report;
  state.progress.dayReports.push(report);
  const overflow = state.progress.dayReports.length - UI.REPORT_HISTORY_DAYS;
  if (overflow > 0) state.progress.dayReports.splice(0, overflow);
};
