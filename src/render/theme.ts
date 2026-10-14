/**
 * デザイントークン（計画書 §6）。
 * Mini Motorways 風のフラット配色 + ソフトシャドウ。色の直書きを禁止する。
 */

export interface Theme {
  background: number;
  gridLine: number;
  gridLineStrong: number;
  water: number;
  mountain: number;
  forest: number;
  road: number;
  roadOutline: number;
  residential: number;
  commercial: number;
  industrial: number;
  facility: number;
  /**
   * 解放済みに隣接する未購入チャンク（`docs/m6-plan.md` §2 W1）が、まだ人口の
   * マイルストーンに届かず買えない間の見た目。`preview`（買える・青）/`previewInvalid`
   * （買えるが資金不足・赤）とは意味が違う——「そもそも今は選択肢に無い」ことを
   * 示すので、既存の信号色（青/赤/緑/琥珀）を使い回さず中立な色を別に持つ。
   */
  districtLocked: number;
  vehicleCar: number;
  vehicleTruck: number;
  tracePast: number;
  traceFuture: number;
  preview: number;
  previewInvalid: number;
  bad: number;
  warn: number;
  good: number;
  demolish: number;
  shadow: number;
  shadowAlpha: number;
  text: string;
  panel: string;
}

export const lightTheme: Theme = {
  background: 0xf5f3ef,
  gridLine: 0xe4e0d8,
  gridLineStrong: 0xd2cdc2,
  water: 0xa8cfe0,
  mountain: 0xbdb5a8,
  forest: 0xa9c49a,
  road: 0x6e6a63,
  roadOutline: 0x565249,
  residential: 0x7cb06a,
  commercial: 0x5b9bd5,
  industrial: 0xe0b352,
  facility: 0xc76f6f,
  districtLocked: 0x9c9384,
  vehicleCar: 0x3f3d39,
  vehicleTruck: 0x8a5a3c,
  tracePast: 0x8b7d9f,
  traceFuture: 0x8a4fff,
  preview: 0x4a90d9,
  previewInvalid: 0xd9534f,
  bad: 0xd9534f,
  warn: 0xe0b352,
  good: 0x7cb06a,
  demolish: 0xc94c4c,
  shadow: 0x000000,
  shadowAlpha: 0.16,
  text: '#2b2a27',
  panel: 'rgba(255,255,255,0.92)',
};

export const darkTheme: Theme = {
  background: 0x1a1c22,
  gridLine: 0x272a32,
  gridLineStrong: 0x343843,
  water: 0x2c4a5c,
  mountain: 0x4a4740,
  forest: 0x3a5236,
  road: 0x8d8a84,
  roadOutline: 0xa8a49c,
  residential: 0x6da05c,
  commercial: 0x4f8ec4,
  industrial: 0xc99f45,
  facility: 0xb96060,
  districtLocked: 0x6b665c,
  vehicleCar: 0xe8e5df,
  vehicleTruck: 0xd8a97f,
  tracePast: 0x9a8aaf,
  traceFuture: 0xc28cff,
  preview: 0x6aa9e9,
  previewInvalid: 0xe06c68,
  bad: 0xe06c68,
  warn: 0xc99f45,
  good: 0x6da05c,
  demolish: 0xf07872,
  shadow: 0x000000,
  shadowAlpha: 0.4,
  text: '#e8e5df',
  panel: 'rgba(30,32,39,0.92)',
};

export function prefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function currentTheme(): Theme {
  return prefersDark() ? darkTheme : lightTheme;
}
