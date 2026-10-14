/**
 * 施設の定義（実装書 §10・`docs/m6-plan.md` §2 W4）。
 *
 * **v1 では2種類だけ出す。** 実装書は5種を並べているが、
 * `docs/m6-plan.md` §1-3 の通り、あの5種は**どれも道路網の判断を変えない**
 * （誘引力は行き先の配分でしかなく、人の移動の総量は住宅の固定確率で決まる）。
 * 置く場所を考える楽しさは「そこに置くと交通がどう変わるか」から生まれるので、
 *
 *   - **学校** = 恩恵と引き換えに**新しい交通負荷を生む**施設
 *   - **公園** = 負荷を生まない純粋なバフ
 *
 * の対比だけをまず出し、Ryo のプレイテストで「置く場所で悩んだか」を判定してから
 * 残り3種を決める（D5 で承認済みの垂直スライス方針）。
 *
 * データ駆動なので、`FACILITY_DEFS` に足せば施設が増える。
 */

import { FACILITY } from '../balance';

export interface FacilityDef {
  id: string;
  /** 建設費 */
  cost: number;
  /** 1日あたりの維持費 */
  upkeep: number;
  /** 占有タイル数。4 のとき `pos` は左上タイルを指す */
  footprint: 1 | 4;
  /** 解放するマイルストーン。'start' なら最初から置ける */
  unlock: { milestoneId: string } | 'start';
  /**
   * 効果の半径（チェビシェフ距離＝正方形）。
   * マンハッタンにすると菱形になり、**プレイヤーが範囲を読み違える**
   * （道路が直交格子なので、正方形の方が「この区画に効く」を数えやすい）。
   */
  radius: number;
  /** 半径内の住宅の満足度がこの値を下回らなくなる。0 なら効果なし */
  satisfactionFloor: number;
  /**
   * 半径内の住宅から**追加で発生する移動**の1tickあたりの確率。
   *
   * **これがこの施設が「交通負荷を生むか」を決める唯一の値。**
   * 0 なら公園のように置いても交通は変わらない。正なら学校のように、
   * 恩恵の範囲がそのまま渋滞の原因になる。
   */
  extraTripRate: number;
}

export const FACILITY_DEFS: readonly FacilityDef[] = [
  {
    id: 'park',
    cost: FACILITY.PARK_COST,
    upkeep: FACILITY.PARK_UPKEEP,
    footprint: 1,
    unlock: 'start',
    radius: FACILITY.PARK_RADIUS,
    satisfactionFloor: FACILITY.PARK_SATISFACTION_FLOOR,
    // 公園は負荷を生まない。**この 0 が学校との対比そのもの**
    extraTripRate: 0,
  },
  {
    id: 'school',
    cost: FACILITY.SCHOOL_COST,
    upkeep: FACILITY.SCHOOL_UPKEEP,
    footprint: 1,
    unlock: { milestoneId: 'pop100' },
    radius: FACILITY.SCHOOL_RADIUS,
    satisfactionFloor: 0,
    // 半径内の住宅が通学の車を出す。中央に置けば広く効くが交通が集中し、
    // 周辺に置けば負荷は軽いが恩恵が狭い ＝ **置く場所が道路の判断を変える**
    extraTripRate: FACILITY.SCHOOL_EXTRA_TRIP_RATE,
  },
];

export function facilityDef(defId: string): FacilityDef | undefined {
  return FACILITY_DEFS.find((d) => d.id === defId);
}
