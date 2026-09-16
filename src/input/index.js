/**
 * 输入聚合层。
 *
 * 所有输入源（滑动、点击、键盘、以及 P2 的甩动）都把意图归一化成
 * {power: 0..1, dirX, dirZ, source} 再从这里出去。
 * 下游只认这一种形状 —— 加甩动输入时不需要改状态机一行。
 */

import { on } from '../core/bus.js';
import { initPointer } from './pointer.js';
import { initKeyboard } from './keyboard.js';

export function initInput(canvasEl) {
  initPointer(canvasEl);
  initKeyboard();
}

/**
 * 归一化力度。任何输入源给的值都从这里过一遍，
 * 防止某个源算出 NaN 或者越界把物理搞炸。
 */
export function normalize(power) {
  if (!Number.isFinite(power)) return 0.5;
  return Math.max(0, Math.min(1, power));
}

/**
 * 把 deviceorientation 的震动能量转成力度。P2 的 shake.js 用。
 * 放在这里是因为"能量 → 力度"的映射规则应该只有一个地方定义。
 */
export function energyToPower(energy) {
  // 平方根压缩：能量是平方量，线性映射会让轻晃几乎没有力度、
  // 稍微用点力就顶到满力，中间没有可调区间
  return normalize(Math.sqrt(Math.max(0, energy)));
}

export { on };
