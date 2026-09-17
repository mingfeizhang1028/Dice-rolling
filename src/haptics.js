/**
 * 震动。探针 + 分级脉冲 + 限流 + 退避。
 *
 * ⚠️ 关于这个模块必须先说清楚一件事：**navigator.vibrate 是"有 API"
 *    和"真的会震"完全两回事。**
 *    · iOS Safari 至今没有 navigator.vibrate（iPhone 上永远是 undefined）；
 *    · 部分 Android 浏览器有 API 但没有马达（平板）；
 *    · 调用成功返回 true 只代表"请求被接受"，不代表马达转了。
 *    没有任何办法能程序化地检测到底震没震 —— 所以这里的策略是
 *    能探测的就探测（API 是否存在），探测不到的就不假装知道：
 *    `available` 只反映 API 存在性，UI 上据此决定要不要显示这个开关。
 *
 * 限流不是优化，是**必需**：navigator.vibrate 每次调用都会取消上一个，
 * 且马达有 20–50ms 的启动时间。碰撞密集时不限流的话，每一次调用都会
 * 掐掉上一次的震动，结果是连续撞了十下却只感觉到零星的几下抖动。
 */

import { getMaterial } from './materials.js';
import { emit } from './core/bus.js';

/** 两次震动之间的最小间隔。短于这个值的碰撞直接丢掉 */
const MIN_GAP_MS = 32;

/**
 * 马达从通电到有明显振幅大约要 20–50ms。比这更短的脉冲
 * 用户感觉不到"震了一下"，只感觉到手机好像动了一下。
 * 材质描述符里的 impactMs 是"听觉上的撞击长度"，不是震动长度，
 * 所以这里要抬到能感觉到的下限。
 */
const MIN_PULSE_MS = 8;

/** 连续失败多少次之后放弃。用于"有 API 但调用报错"的设备 */
const FAIL_LIMIT = 3;

let api = null;
let enabled = true;
let probed = false;
let available = false;
let failCount = 0;
let disabledByFailure = false;
let lastAt = 0;
let lastPattern = null;

/** 统计，给 ?debug=1 用 */
const stats = { calls: 0, skippedRate: 0, skippedOff: 0 };

/**
 * 必须在用户手势里调一次。
 *
 * 除了拿 sticky activation（有些浏览器要求震动必须由用户激活触发），
 * 这一次调用也是**唯一的探针机会**：API 存在但调用抛异常的设备
 * 只有真调一次才知道。探针用 1ms —— 太短，用户感觉不到。
 */
export function probe() {
  probed = true;
  api = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function'
    ? navigator.vibrate.bind(navigator)
    : null;

  if (!api) {
    available = false;
    emit('haptics:unavailable', { reason: 'no navigator.vibrate' });
    return false;
  }

  try {
    api(1);
    available = true;
  } catch (err) {
    available = false;
    emit('haptics:unavailable', { reason: String(err?.message || err) });
  }
  return available;
}

export function isAvailable() {
  return available;
}

export function isEnabled() {
  return enabled && available && !disabledByFailure;
}

export function setEnabled(on) {
  enabled = !!on;
  // 关掉的时候顺手取消正在进行的震动，否则用户关了开关还要等它震完
  if (!enabled) cancel();
}

/** 取消正在进行的震动 */
export function cancel() {
  if (!api) return;
  try { api(0); } catch { /* 忽略 */ }
  lastPattern = null;
}

/**
 * 一次撞击。strength 是 0..1 的强度，来自碰撞速度。
 *
 * 材质影响两件事：脉冲长度（haptic.impactMs）和整体增益（haptic.gain）。
 * 金属比塑料震得久、震得实 —— 这和它的物理阻尼是一套语言。
 */
export function impact(materialId, strength = 0.5) {
  const h = getMaterial(materialId).haptic;
  const s = clamp01(strength);
  // 轻撞不缩到 0：完全没有震动的撞击会让人觉得"这次没生效"
  const ms = Math.round(Math.max(MIN_PULSE_MS, h.impactMs * (0.55 + 0.45 * s)));
  fire([ms]);
}

/**
 * 落定的三连脉冲。这是"骰子停了"的触觉签名 ——
 * 用户不看屏幕也知道结果出来了。
 */
export function settle(materialId) {
  const h = getMaterial(materialId).haptic;
  fire(h.settle);
}

/** 界面反馈用的轻点。设置开关、chip 切换都走这个 */
export function tick(ms = 6) {
  fire([Math.max(4, Math.round(ms))]);
}

// ── 内部 ──

function fire(pattern) {
  stats.calls++;
  if (!isEnabled()) {
    stats.skippedOff++;
    return false;
  }

  const now = performance.now();
  if (now - lastAt < MIN_GAP_MS) {
    // ⚠️ 丢弃而不是合并。合并成一次长震动的话，密集碰撞会变成
    //    持续嗡嗡响，比"少震几下"难听得多，也失去了"一下一下"的节奏感
    stats.skippedRate++;
    return false;
  }
  lastAt = now;

  try {
    const accepted = api(pattern);
    // 规范要求返回 false 表示"被拒绝"（比如页面不可见）。
    // 这不算设备故障，不累加失败计数 —— 切后台时碰撞还在继续是正常的
    if (accepted === false) return false;
    lastPattern = pattern;
    failCount = 0;
    return true;
  } catch (err) {
    failCount++;
    if (failCount >= FAIL_LIMIT) {
      disabledByFailure = true;
      available = false;
      emit('haptics:unavailable', { reason: `连续 ${FAIL_LIMIT} 次调用失败：${err?.message || err}` });
    }
    return false;
  }
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * 页面藏起来时不要震。
 *
 * ⚠️ 这条不只是省电：手机在兜里还一震一震的，用户会以为程序出问题了。
 *    取消之后 lastAt 不清零 —— 清掉的话回到前台的第一下会立刻震，
 *    而那时用户可能还在把手机掏出来。
 */
export function handleVisibility() {
  if (typeof document !== 'undefined' && document.hidden) cancel();
}

export function getStats() {
  return { ...stats, available, enabled, disabledByFailure, lastPattern: lastPattern ? [...lastPattern] : null };
}

/**
 * 测试用：把模块恢复到刚加载的状态。
 * 这个模块的状态全是模块级的，一个用例污染了后面全错，
 * 而"限流"和"退避"恰恰是只有连着调才能测出来的东西。
 */
export function __resetForTest() {
  api = null;
  enabled = true;
  probed = false;
  available = false;
  failCount = 0;
  disabledByFailure = false;
  lastAt = 0;
  lastPattern = null;
  stats.calls = 0;
  stats.skippedRate = 0;
  stats.skippedOff = 0;
}
