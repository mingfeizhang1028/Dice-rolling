/**
 * 校验四种材质各自的 4 个区分色是不是真的分得开。
 *
 * 为什么需要这个脚本：区分色是"多颗骰子靠颜色分辨"的唯一依据
 * （名字只在虚按时才浮出来）。挑色板时靠眼睛看色卡完全不够 ——
 * 在暗色面板上、缩到 11px、还隔着一层毛玻璃，
 * 原本在色卡上"明显不同"的两个颜色会变成同一个点。
 * 这里把它量化。
 */

import { MATERIAL_IDS, getMaterial, dieColor, hexToCss } from '../src/materials.js';

/**
 * "红均值"加权色差。比裸 RGB 欧氏距离更接近人眼，
 * 又比 CIEDE2000 简单得多 —— 挑 16 个颜色不需要那么精确。
 * 经验阈值：>100 一眼能分，60~100 能分，<40 基本分不出
 */
function dist(a, b) {
  const r1 = (a >> 16) & 255, g1 = (a >> 8) & 255, b1 = a & 255;
  const r2 = (b >> 16) & 255, g2 = (b >> 8) & 255, b2 = b & 255;
  const rm = (r1 + r2) / 2;
  const dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
  return Math.sqrt(
    (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db,
  );
}

const lum = (h) =>
  0.2126 * ((h >> 16) & 255) + 0.7152 * ((h >> 8) & 255) + 0.0722 * (h & 255);

/** 暗室主题下面板的底色，用来查"会不会糊在背景里" */
const PANEL = 0x2a2a30;

let worstOverall = Infinity;
let fail = 0;

for (const id of MATERIAL_IDS) {
  const cols = [0, 1, 2, 3].map((s) => dieColor(id, s));

  let minPair = Infinity;
  let minAt = '';
  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) {
      const d = dist(cols[i], cols[j]);
      if (d < minPair) {
        minPair = d;
        minAt = `${i}↔${j}`;
      }
    }
  }

  // 最暗的那颗会不会糊进面板背景
  const dimmest = Math.min(...cols.map(lum));
  const bgLum = lum(PANEL);
  const contrast = Math.abs(dimmest - bgLum);

  const ok = minPair >= 80 && contrast >= 25;
  if (!ok) fail++;
  if (minPair < worstOverall) worstOverall = minPair;

  console.log(
    `${ok ? '✓' : '✗'} ${id.padEnd(8)} ${cols.map(hexToCss).join(' ')}  ` +
    `最小色差 ${minPair.toFixed(0)} (${minAt}) · 最暗 ${dimmest.toFixed(0)} vs 底色 ${bgLum.toFixed(0)} 差 ${contrast.toFixed(0)}`,
  );
}

console.log('');
if (fail) {
  console.log(`✗ ${fail} 种材质的区分色分不开（最小色差 ${worstOverall.toFixed(0)}，要求 ≥80）`);
  process.exit(1);
}
console.log(`✓ 四种材质全部分得开（全局最小色差 ${worstOverall.toFixed(0)}）`);
