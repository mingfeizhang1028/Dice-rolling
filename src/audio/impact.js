/**
 * 碰撞音的播放策略。订阅 'impact' 事件，挑一个烘好的 buffer 放出来。
 *
 * 每次碰撞的节点成本：1 个 BufferSource + 1 个 GainNode + 1 个 StereoPanner
 * = 3 个节点，用完即弃。对比实时合成方案每次 25–40 个节点，
 * 这是"手机上不炸"和"必炸"的区别。
 *
 * 本地只做三件让声音不重复的事：
 *   ① 变体随机 —— 同一档有 3 个烘好的变体，轮换着放
 *   ② 播放速率 ±8% —— 连音高带衰减时间一起变，比只调音量真实得多
 *   ③ 随机相位偏移不可行（buffer 是死的），所以靠 ①② 撑
 * 连续几十次撞击听不出重复，这三条就够了。
 */

import { PHYSICS } from '../config.js';
import { on } from '../core/bus.js';
import { bakeMaterial, getBaked, INTENSITY_LEVELS } from './bake.js';
import { getContext, getSfxBus, voiceStarted, voiceEnded } from './engine.js';


/**
 * 同时最多几个碰撞音。超了偷最旧的那个。
 *
 * 8 是个经验值：3 颗骰子最密的时候一秒能撞十几次，但人的耳朵
 * 分不出第 9 个同时发声的瞬态；而每个 voice 都是 3 个节点在跑，
 * 上限不设的话密集碰撞时音频线程会开始 glitch。
 */
const MAX_VOICES = 8;

/** 被偷走的 voice 用这么长的淡出收尾，直接 stop 会"啪"一声 */
const STEAL_FADE_MS = 8;

/** 播放速率抖动范围。±8% 大约是半个半音，听不出走调但能听出不同 */
const RATE_JITTER = 0.08;

/** 活跃 voice 的环形表。旧的在前 */
const voices = [];

/** 材质变化时音色也要跟着变 —— 但已经在飞的碰撞音不打断 */
let currentMaterialId = null;
let unsub = null;

/**
 * 累计播放过的碰撞音。只给 ?debug=1 用。
 *
 * 存在的理由：`live` 是个瞬态量，截图那一刻多半是 0 —— 而 0 既可能是
 * "这一局响完了"，也可能是"一次都没响过"。两者在面板上长得一模一样，
 * 但一个是正常、一个是哑的。要区分只能看累计值。
 */
let playedTotal = 0;

export function init() {
  if (unsub) return unsub;
  unsub = on('impact', handleImpact);
  return unsub;
}

export function dispose() {
  unsub?.();
  unsub = null;
  for (const v of voices) stopVoice(v, 0);
  voices.length = 0;
}

/** 当前该用哪种材质的声音。设置界面换材质时调 */
export function useMaterial(materialId) {
  currentMaterialId = materialId;
}

/**
 * 事件入口。
 *
 * ⚠️ 没有烘焙好的 buffer 时**静默跳过**，不现场烘。
 *    现场烘要走 async，等烘完这次撞击早就过去了 —— 补一声迟到的
 *    闷响比不响更糟。烘焙由启动序列保证，这里只负责放。
 */
function handleImpact(e) {
  const materialId = e.materialId || currentMaterialId;
  const baked = getBaked(materialId);
  if (!baked) return;

  const level = pickLevel(e.speed);
  const variants = baked.levels[level];
  const buffer = variants[Math.floor(Math.random() * variants.length)];

  playBuffer(buffer, level, e.pan || 0, e.speed);
}

/**
 * 法向速度 → 强度档。
 *
 * 线性映射到三档。做成线性而不是按能量（v²）：用户感知的"撞得重不重"
 * 更接近速度而不是动能 —— 动能是四次方量级，会让绝大多数碰撞掉进最低档。
 */
export function pickLevel(speed) {
  const span = Math.max(0.01, PHYSICS.impactMaxSpeed - PHYSICS.impactMinSpeed);
  const t = (speed - PHYSICS.impactMinSpeed) / span;
  const idx = Math.floor(t * INTENSITY_LEVELS);
  return Math.max(0, Math.min(INTENSITY_LEVELS - 1, idx));
}

function playBuffer(buffer, level, pan, speed) {
  const ctx = getContext();
  const bus = getSfxBus();
  if (!ctx || !bus) return;

  // 上下文没跑就别排期。排了也不会响，还会把 voice 表占满，
  // 等上下文恢复时一次性全炸出来
  if (ctx.state !== 'running') return;

  // 满了就偷最旧的。淡出而不是硬停 —— 硬停的波形断口是一个宽带瞬态，
  // 听起来就是"啪"，恰好混在碰撞音里最难分辨
  while (voices.length >= MAX_VOICES) {
    stopVoice(voices.shift(), STEAL_FADE_MS);
  }

  const now = ctx.currentTime;

  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = 1 + (Math.random() * 2 - 1) * RATE_JITTER;

  const gain = ctx.createGain();
  // 速度只做微调（±1.5dB）。分档已经承担了主要的响度差，
  // 这里再线性跟随的话同一档内部会忽大忽小，反而听出"随机"
  const trim = 1 + Math.max(-0.2, Math.min(0.2, (speed - 5) / 20));
  gain.gain.value = trim;

  let tail = gain;
  let panner = null;
  if (ctx.createStereoPanner) {
    panner = ctx.createStereoPanner();
    // pan 只取一半幅度。骰子都在同一个托盘里，拉满会像两个音箱
    // 分别发声，而不是"一颗骰子在左边一点"
    panner.pan.value = Math.max(-0.6, Math.min(0.6, pan * 0.6));
    gain.connect(panner);
    tail = panner;
  }
  tail.connect(bus);

  src.connect(gain);

  const voice = { src, gain, tail, endsAt: 0, done: false };
  src.onended = () => {
    if (voice.done) return;
    voice.done = true;
    voiceEnded();
    try { src.disconnect(); gain.disconnect(); tail.disconnect(); } catch { /* 已断开 */ }
    const i = voices.indexOf(voice);
    if (i >= 0) voices.splice(i, 1);
  };

  src.start(now);
  voice.endsAt = now + buffer.duration / src.playbackRate.value;
  voices.push(voice);
  playedTotal++;
  voiceStarted();
}

function stopVoice(v, fadeMs) {
  if (!v || v.done) return;
  const ctx = getContext();
  if (!ctx || fadeMs <= 0) {
    try { v.src.stop(); } catch { /* 还没 start 或已停 */ }
    return;
  }
  const now = ctx.currentTime;
  try {
    v.gain.gain.cancelScheduledValues(now);
    v.gain.gain.setValueAtTime(v.gain.gain.value, now);
    v.gain.gain.linearRampToValueAtTime(0, now + fadeMs / 1000);
    v.src.stop(now + fadeMs / 1000 + 0.002);
  } catch {
    /* 已经停了 */
  }
}

/** 投掷开始前清场：上一局的余音不该混进这一局 */
export function clearVoices() {
  for (const v of voices) stopVoice(v, STEAL_FADE_MS);
  voices.length = 0;
}

export function getStats() {
  return {
    live: voices.length,
    max: MAX_VOICES,
    played: playedTotal,
    // 当前材质的波形烘好了没有。没烘好时 handleImpact 是静默跳过的，
    // 面板上必须能看出"哑"是这个原因，而不是事件没来
    ready: !!getBaked(currentMaterialId),
  };
}

/**
 * 启动时预热。跟 bakeMaterial 分开是因为职责不同：
 * bake 只管造波形，这里管"造好之后接上事件"。
 */
export async function warmup(materialId, ctx) {
  await bakeMaterial(materialId, ctx);
  if (!getBaked(materialId)) return null;
  useMaterial(materialId);
  init();
  return getBaked(materialId);
}
