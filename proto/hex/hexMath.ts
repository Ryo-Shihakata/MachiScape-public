/**
 * ヘックス座標系のユーティリティ（axial座標、pointy-top）。
 *
 * pointy-top を選んだ理由: スマホは縦持ちが基本で、主な指の動きは上下スクロール（パン）になりやすい。
 * pointy-top は隣接行が水平にきれいに揃って見えるため（flat-top は列が上下にずれて見える）、
 * 縦方向のパンと相性がよいと判断した。
 *
 * ワールド座標は src/render/camera.ts が正方タイル基準の等方スケール（tileScreenSize）を前提にしている。
 * ヘックスの隣接セル中心間の距離が「グリッド版の隣接タイル間距離 = 1 ワールド単位」と揃うように
 * HEX_SIZE（外接半径）を選ぶ。これにより、カメラのズーム感・ダミー交通の速度感（タイル/秒）を
 * 3方式で近い体感に保てる。
 */

export interface Axial {
  q: number;
  r: number;
}

/** 隣接セル中心間の距離が 1 ワールド単位になる外接半径（pointy-top: 距離 = size * sqrt(3)） */
export const HEX_SIZE = 1 / Math.sqrt(3);

export function axialKey(q: number, r: number): string {
  return `${q},${r}`;
}

export function parseKey(id: string): Axial {
  const [qs, rs] = id.split(',');
  return { q: Number(qs ?? 0), r: Number(rs ?? 0) };
}

export function axialToWorld(q: number, r: number): { x: number; y: number } {
  return {
    x: HEX_SIZE * Math.sqrt(3) * (q + r / 2),
    y: HEX_SIZE * 1.5 * r,
  };
}

function cubeRound(qf: number, rf: number): Axial {
  const xf = qf;
  const zf = rf;
  const yf = -xf - zf;
  let x = Math.round(xf);
  const y = Math.round(yf);
  let z = Math.round(zf);
  const xDiff = Math.abs(x - xf);
  const yDiff = Math.abs(y - yf);
  const zDiff = Math.abs(z - zf);
  // q,r(=x,z) だけを返すので、丸め誤差は x か z のどちらかに吸収させればよい
  // （y の丸め誤差が最大のときは x, z をそのまま使ってよい = 何もしない）
  if (xDiff > yDiff && xDiff > zDiff) {
    x = -y - z;
  } else if (yDiff <= zDiff) {
    z = -x - y;
  }
  return { q: x, r: z };
}

/** ワールド座標 → 最も近い axial セル（キューブ座標での丸め） */
export function worldToAxial(x: number, y: number): Axial {
  const qf = ((Math.sqrt(3) / 3) * x - y / 3) / HEX_SIZE;
  const rf = ((2 / 3) * y) / HEX_SIZE;
  return cubeRound(qf, rf);
}

/** 6方向の隣接オフセット（axial 座標では pointy/flat どちらでも共通） */
export const AXIAL_DIRS: Axial[] = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
];

export function neighborsOf(q: number, r: number): Axial[] {
  return AXIAL_DIRS.map((d) => ({ q: q + d.q, r: r + d.r }));
}

export function hexDistance(a: Axial, b: Axial): number {
  return (Math.abs(a.q - b.q) + Math.abs(a.q + a.r - b.q - b.r) + Math.abs(a.r - b.r)) / 2;
}

/**
 * a から b までの間にある axial セルを線形補間で埋める。
 * 速いドラッグで pointermove が飛んでもセルを取りこぼさないようにするため。
 * 微小なイプシロンを足しているのは、ちょうど辺の境界に乗ったときの丸め先を安定させるため
 * （redblobgames のヘックス線分描画の定石）。
 */
export function hexLine(a: Axial, b: Axial): Axial[] {
  const n = hexDistance(a, b);
  if (n === 0) return [a];
  const out: Axial[] = [];
  const EPS_Q = 1e-6;
  const EPS_R = 2e-6;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const qf = a.q + EPS_Q + (b.q - a.q) * t;
    const rf = a.r + EPS_R + (b.r - a.r) * t;
    out.push(cubeRound(qf, rf));
  }
  return out;
}

/** ヘックス1個分の6頂点（ワールド座標、pointy-top） */
export function hexCorners(cx: number, cy: number, size = HEX_SIZE): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 30);
    pts.push({ x: cx + size * Math.cos(angle), y: cy + size * Math.sin(angle) });
  }
  return pts;
}
