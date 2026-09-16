/**
 * 能力检测 + 画质档判定。
 *
 * ⚠️ 震动必须用可选链或特性检测调用。iOS 上 navigator.vibrate 是 undefined，
 *    直接调 vibrate() 会抛 TypeError 并中断后续脚本执行。
 */

export function detect() {
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isTouch = navigator.maxTouchPoints > 0 || 'ontouchstart' in window;

  const canVibrate = typeof navigator.vibrate === 'function';
  const canMotion = typeof window.DeviceMotionEvent !== 'undefined';
  const needsMotionPermission =
    canMotion && typeof window.DeviceMotionEvent.requestPermission === 'function';

  // WebGL2 + 设备内存是画质档的主要依据
  const gl = document.createElement('canvas').getContext('webgl2');
  const deviceMemory = navigator.deviceMemory || 4;   // 只有 Chromium 有；缺省按 4GB 算
  const cores = navigator.hardwareConcurrency || 4;

  // 低配：无 WebGL2 / 内存小 / 核心少。决定是否开 transmission（双倍渲染量）
  let tier = 'high';
  if (!gl) tier = 'low';
  else if (deviceMemory <= 4 && cores <= 4) tier = 'low';
  else if (deviceMemory <= 6 || isIOS) tier = 'mid';

  return {
    isIOS,
    isTouch,
    canVibrate,
    canMotion,
    needsMotionPermission,
    deviceMemory,
    cores,
    tier,
    // 是否支持 AudioWorklet（P2 用；不支持就走 buffer 版）
    canWorklet: typeof AudioContext !== 'undefined' &&
      'audioWorklet' in AudioContext.prototype,
  };
}
