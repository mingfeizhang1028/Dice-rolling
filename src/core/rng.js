/**
 * 可种子随机。用于音效变体的确定性烘焙 —— 同一个 seed 必须烘出同一段音频，
 * 否则每次启动的声音都不一样，用户会觉得"这次的声音不对"。
 */

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 真实随机（投掷用这个，不要用可种子版本） */
export const rand = Math.random;

export function randRange(min, max) {
  return min + Math.random() * (max - min);
}

/** 对数均匀取 [min,max]，用于频率这种按倍频程感知的量 */
export function randLogRange(min, max) {
  return Math.exp(Math.log(min) + Math.random() * (Math.log(max) - Math.log(min)));
}

export function randInt(minInclusive, maxExclusive) {
  return Math.floor(minInclusive + Math.random() * (maxExclusive - minInclusive));
}
