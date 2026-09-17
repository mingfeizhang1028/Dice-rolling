/**
 * 音频上下文与总线链。整个 P2 的最底层。
 *
 * 信号流：
 *   impact voices ─┐
 *   ui/soft ───────┼─► sfxBus ─┐
 *   ambience ──────► ambBus ───┴─► masterGain ─► DynamicsCompressor ─► destination
 *
 * 为什么要压缩器：碰撞音是瞬态，峰值能冲到 0dBFS 以上。骰子多、撞得密时
 * 不压就会削顶，听起来是"炸"而不是"响"。压缩器把峰值拉回来，
 * 顺带让"轻撞"和"重撞"的响度差更接近人耳的感觉，而不是线性差。
 *
 * ⚠️ 本模块只负责"有没有声音、整体多大声"，不负责"什么声音"。
 *    合成在 bake.js，播放策略在 impact.js，环境音在 ambience.js。
 */

import { emit } from '../core/bus.js';

/** 上下文的唯一持有者。null 表示还没解锁 */
let ctx = null;

let masterGain = null;
let compressor = null;
let sfxBus = null;
let ambBus = null;

/** 音量。解锁前后都可能被设置，所以先存下来，建链时再套上 */
let sfxVolume = 0.8;
let ambVolume = 0.5;
let muted = false;

/**
 * 僵尸上下文恢复。
 *
 * Android 上锁屏或切到后台一段时间后，ctx.state 会**仍然报 'running'**
 * 但实际不出声。这是 Chromium 的老问题，没有任何 API 能可靠检测它。
 * 唯一现实的做法是：每次用户手势都补一次 resume()，并且在
 * visibilitychange 回来时再补一次。resume() 对健康的上下文是空操作。
 */
let hiddenAt = 0;

export function create() {
  if (ctx) return ctx;

  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) {
    emit('audio:unavailable', { reason: '没有 AudioContext' });
    return null;
  }

  try {
    ctx = new AC({ latencyHint: 'interactive' });
  } catch (err) {
    emit('audio:unavailable', { reason: String(err?.message || err) });
    return null;
  }

  buildChain();
  watchVisibility();
  return ctx;
}

function buildChain() {
  compressor = ctx.createDynamicsCompressor();
  // 阈值 -12dB、4:1。碰撞音的峰值大多在 -6..0dBFS，这个设置能把
  // 最尖的那几毫秒压下来，又不会让整体发闷
  compressor.threshold.value = -12;
  compressor.knee.value = 6;
  compressor.ratio.value = 4;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.12;

  masterGain = ctx.createGain();
  masterGain.gain.value = muted ? 0 : 1;

  sfxBus = ctx.createGain();
  sfxBus.gain.value = sfxVolume;

  ambBus = ctx.createGain();
  ambBus.gain.value = ambVolume;

  sfxBus.connect(masterGain);
  ambBus.connect(masterGain);
  masterGain.connect(compressor);
  compressor.connect(ctx.destination);
}

/**
 * 在手势的**同一个同步栈**里调用。
 *
 * ⚠️ 三步顺序不能变，中间不能有 await：
 *    ① 建上下文（必须发生在手势里，否则某些浏览器会把它建在 suspended）
 *    ② 播一个真实的声音（哪怕听不见）—— 只调 resume() 常常静默失败
 *    ③ resume()
 *    iPhone 上尤其明显：少了第②步，context 会一直 suspended 而不报错。
 */
export function unlock() {
  const c = create();
  if (!c) return false;

  try {
    // 10ms 的极轻 blip。gain 取 1e-4 —— 人耳听不见，但足以让
    // 浏览器的"用户手势内产生了声音"判定成立
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.frequency.value = 440;
    g.gain.value = 1e-4;
    osc.connect(g);
    g.connect(c.destination);
    osc.start();
    osc.stop(c.currentTime + 0.01);
  } catch {
    /* 播不出也无所谓，下面是真正的关键步骤 */
  }

  if (c.state === 'suspended') {
    // 故意不 await：await 会把后续代码推出同步栈
    c.resume().catch(() => {});
  }

  return c.state === 'running';
}

/**
 * 每次用户手势都调一次。对健康的上下文是空操作，
 * 对"报 running 但实际哑了"的僵尸上下文是唯一的补救机会。
 */
export function revive() {
  if (!ctx) return;
  if (ctx.state === 'suspended' || ctx.state === 'interrupted') {
    ctx.resume().catch(() => {});
    emit('audio:revived', { state: ctx.state });
  }
}

function watchVisibility() {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      hiddenAt = Date.now();
      return;
    }
    // 回来时补一次。藏得久（>30s）就多补一次 —— 长时间后台后
    // 第一次 resume 偶尔仍然哑，第二次才真的恢复
    const away = Date.now() - hiddenAt;
    revive();
    if (away > 30000) setTimeout(revive, 120);
  });
}

// ── 取值 ──

export function getContext() {
  return ctx;
}

export function getSfxBus() {
  return sfxBus;
}

export function getAmbBus() {
  return ambBus;
}

export function isRunning() {
  return ctx?.state === 'running';
}

// ── 音量 ──

export function setSfxVolume(v) {
  sfxVolume = clamp01(v);
  if (sfxBus) setParam(sfxBus.gain, sfxVolume);
}

export function setAmbVolume(v) {
  ambVolume = clamp01(v);
  if (ambBus) setParam(ambBus.gain, ambVolume);
}

export function setMuted(on) {
  muted = !!on;
  if (masterGain) setParam(masterGain.gain, muted ? 0 : 1);
}

/**
 * 参数平滑。
 *
 * ⚠️ 不能直接给 .value 赋值：那会产生一个阶跃，听感上就是"咔"一声。
 *    15ms 的线性斜坡足够短，不会被听成渐变，又能消掉阶跃。
 */
function setParam(param, value) {
  if (!ctx) return;
  const now = ctx.currentTime;
  param.cancelScheduledValues(now);
  param.setValueAtTime(param.value, now);
  param.linearRampToValueAtTime(value, now + 0.015);
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * 给 ?debug=1 用的统计。
 *
 * 活跃音频节点数是判断"有没有泄漏"的唯一直接指标：
 * 碰撞音如果不复用 buffer、不控制并发，节点数会随时间线性增长，
 * 直到音频线程开始 glitch。
 */
let liveVoices = 0;
export function voiceStarted() { liveVoices++; }
export function voiceEnded() { liveVoices--; }
export function getStats() {
  return {
    state: ctx?.state ?? 'none',
    sampleRate: ctx?.sampleRate ?? 0,
    // 输出延迟。手机上这个值超过 ~40ms 就会觉得"撞了才响"
    baseLatencyMs: ctx ? Math.round((ctx.baseLatency || 0) * 1000) : 0,
    liveVoices: Math.max(0, liveVoices),
    sfxVolume,
    ambVolume,
    muted,
  };
}
