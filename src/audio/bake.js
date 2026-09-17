/**
 * 碰撞音烘焙。把 materials.js 里的 sound 描述符变成 AudioBuffer。
 *
 * 为什么必须预烘、不能实时合成：一次撞击实时合成 = 25–40 个 OscillatorNode
 * + 1 个 BufferSource + 3 个 filter。3 颗骰子滚 3 秒、几十次碰撞 →
 * 每秒创建数千个音频节点 → GC 抖动 + 音频线程 glitch。手机上必炸。
 * 烘成 buffer 之后，每次碰撞只剩 1 个 BufferSource + 1 个 GainNode。
 *
 * ⚠️ 一个刻意的偏离：计划里写的是 OfflineAudioContext，这里改成了
 *    纯 JS 直接算进 AudioBuffer。理由有三条，都是实质性的 ——
 *    ① 合成公式本身就是"衰减正弦之和 + 噪声瞬态"，JS 里是两行 exp/sin，
 *       用 OfflineAudioContext 反而要起 40 个节点再等一轮渲染；
 *    ② 确定性。mulberry32 播种 → 同样的 seed 必得同样的波形，
 *       于是 tools/test-bake.mjs 能在 Node 里断言频谱特征；
 *       OfflineAudioContext 的渲染顺序不保证跨浏览器一致；
 *    ③ 不需要 filter 之外任何 Web Audio 能力，而 filter 用一个
 *       15 行的 RBJ biquad 就够了，还能单独测。
 *    目标（预烘、播放期零合成）没有变，换的只是达到它的手段。
 */

import { getMaterial } from '../materials.js';
import { mulberry32 } from '../core/rng.js';

/**
 * 强度档。索引就是碰撞速度分档。
 *
 * 为什么要分档而不是"一个音 + 调音量"：真实撞击变响时音色会变 ——
 * 敲得重，高次分音被激发得更多，听起来更"亮"、余韵更长。
 * 只调音量的话，重撞听起来只是"同一个声音放大了"，很假。
 */
export const INTENSITY_LEVELS = 3;

/** 每档的变体数。变体之间只有随机化参数不同，用来消除"机关枪重复感" */
export const VARIANTS_PER_LEVEL = 3;

/**
 * 三档的强度系数。0 = 轻碰，2 = 重撞。
 *
 * amp   响度。⚠️ 取等比而不是等差：0.30 / 0.55 / 1.00 每档差 5.3dB，听感
 *       上才是"三级台阶"等距的。早先用 0.34 / 0.68 / 1.00，档间是 6.0dB
 *       和 3.4dB —— 轻→中的跳变比中→重明显一倍，用户会觉得"中间那档
 *       跟重撞差不多"，三档名存实亡。
 * bright 分音增益的底数：第 k 个分音乘 bright^k。越接近 1，高次分音越
 *       突出 = 越亮。敲得重，高次模态被激发得更多，这是真实物体的行为。
 * tail  衰减常数（不只是缓冲区长度！）。轻碰激发得浅，余韵就是短。
 *       ⚠️ 早先只拿它缩缓冲区、没缩 τ，结果轻撞和重撞的衰减速度一模一样，
 *          只是被截断得更早 —— 量出来的"余韵"一半是缓冲长度。见 test-bake。
 */
const TIERS = [
  { amp: 0.30, bright: 0.55, tail: 0.62, pitch: 0.97, clickTauMs: 14 },
  { amp: 0.55, bright: 0.78, tail: 0.82, pitch: 1.00, clickTauMs: 10 },
  { amp: 1.00, bright: 1.00, tail: 1.00, pitch: 1.03, clickTauMs: 7 },
];

/** 缓冲末尾的淡出长度。不淡的话波形被硬切，听感上是一声"咔" */
const FADE_OUT_MS = 40;

/** 缓存：materialId → { levels: [ [buffer x3] x3 ], bytes } */
const cache = new Map();
const pending = new Map();

export function isBaked(materialId) {
  return cache.has(materialId);
}

export function getBaked(materialId) {
  return cache.get(materialId) || null;
}

export function bakedBytes() {
  let total = 0;
  for (const entry of cache.values()) total += entry.bytes;
  return total;
}

export function listBaked() {
  return [...cache.keys()];
}

/**
 * 烘焙一种材质。幂等 —— 重复调用返回同一个 promise，不会重复劳动。
 * 必须先解锁（有 AudioContext）才能调，因为 AudioBuffer 要从 ctx 造。
 */
export function bakeMaterial(materialId, ctx) {
  const id = getMaterial(materialId).id;
  if (cache.has(id)) return Promise.resolve(cache.get(id));
  if (pending.has(id)) return pending.get(id);

  const task = Promise.resolve().then(() => {
    const started = performance.now();
    const entry = renderMaterial(id, ctx);
    entry.ms = Math.round(performance.now() - started);
    cache.set(id, entry);
    pending.delete(id);
    return entry;
  });

  pending.set(id, task);
  return task;
}

/**
 * 烘当前材质之外的，交给空闲时间。
 * 用 requestIdleCallback 而不是 setTimeout：这些工作不急，
 * 让给正在跑的物理和渲染更重要。
 */
export function bakeIdle(materialIds, ctx, onOne) {
  const queue = materialIds.filter((id) => !cache.has(id) && !pending.has(id));
  if (!queue.length) return () => {};

  let cancelled = false;
  const schedule = window.requestIdleCallback
    ? (fn) => window.requestIdleCallback(fn, { timeout: 2000 })
    : (fn) => setTimeout(fn, 200);

  const step = () => {
    if (cancelled || !queue.length) return;
    const id = queue.shift();
    bakeMaterial(id, ctx).then((entry) => {
      if (cancelled) return;
      onOne?.(id, entry);
      schedule(step);
    });
  };

  schedule(step);
  return () => { cancelled = true; };
}

// ── 渲染 ──

function renderMaterial(materialId, ctx) {
  const s = getMaterial(materialId).sound;
  const rate = ctx.sampleRate;

  const levels = [];
  let bytes = 0;

  for (let level = 0; level < INTENSITY_LEVELS; level++) {
    const variants = [];
    for (let v = 0; v < VARIANTS_PER_LEVEL; v++) {
      // seed 由材质名 + 档 + 变体决定 → 跨会话完全可复现
      const seed = hashSeed(`${materialId}:${level}:${v}`);
      const samples = renderOne(s, level, mulberry32(seed), rate);
      const buf = ctx.createBuffer(1, samples.length, rate);
      buf.copyToChannel(samples, 0);
      variants.push(buf);
      bytes += samples.length * 4;
    }
    levels.push(variants);
  }

  return { materialId, levels, bytes, decayMs: s.decayMs, baseHz: s.baseHz };
}

/**
 * 合成一个变体。
 *
 * 公式：① 噪声瞬态（白噪 × 指数衰减 × 谐振低通）+ ② 模态分音（多个
 * 衰减正弦之和）。两者都乘同一个强度包络。
 *
 * 单声道。立体声宽度在播放期用 StereoPanner 加 —— 烘两份声道要
 * 双倍内存，而播放期的随机 pan 效果一样好还更灵活。
 */
function renderOne(s, level, rnd, rate) {
  const tier = TIERS[level];

  // 该档的基准衰减常数。tier.tail 在这里生效 —— 它决定声音**多快衰下去**，
  // 不只是缓冲区开多长
  const decaySec = (s.decayMs / 1000) * (1 + (rnd() * 2 - 1) * s.decayJitter) * tier.tail;
  // ⚠️ 尾部长度必须够包络真的衰下去。3τ = -26dB，再叠 40ms 淡出，收尾干净。
  //    早先用 2.6τ 时玉石只剩 -22dB 就被切了，量出来的"余韵"其实是
  //    缓冲区长度而不是声音本身的长度 —— tools/test-bake.mjs 因此报错。
  const tailSec = decaySec * 3.0 + FADE_OUT_MS / 1000;
  const n = Math.max(64, Math.ceil(tailSec * rate));

  const out = new Float32Array(n);

  // 每个分音的频率和衰减常数各随机一次 —— 这是"同一颗骰子每次撞
  // 声音都略有不同"的来源。hzJitter 0.06 是 ±6%。
  const base = s.baseHz * tier.pitch * (1 + (rnd() * 2 - 1) * s.hzJitter);
  const phases = [];
  const freqs = [];
  const taus = [];
  const gains = [];
  for (let k = 0; k < s.partials.length; k++) {
    freqs.push(base * s.partials[k]);
    gains.push(s.partialGains[k] * Math.pow(tier.bright, k));
    // partialDecay[k] < 1 表示高次分音衰减更快。再叠一点随机
    taus.push(decaySec * s.partialDecay[k] * (1 + (rnd() * 2 - 1) * s.decayJitter * 0.5));
    phases.push(rnd() * Math.PI * 2);
  }

  const invRate = 1 / rate;
  for (let i = 0; i < n; i++) {
    const t = i * invRate;
    let v = 0;
    for (let k = 0; k < freqs.length; k++) {
      // 超过奈奎斯特的分音直接跳过。jade 的 8.93 次分音在 44.1k 下
      // 是 18.7kHz，还活着；但如果用户换了低采样率设备就会越界，
      // 越界后 sin 会混叠成一个低频鬼影，比直接不发声难听得多
      if (freqs[k] >= rate * 0.5) continue;
      v += gains[k] * Math.exp(-t / taus[k]) * Math.sin(2 * Math.PI * freqs[k] * t + phases[k]);
    }
    out[i] = v;
  }

  // ── 噪声瞬态 ──
  const noiseLen = Math.ceil((tier.clickTauMs * 6) * invRate * rate);
  if (s.noiseMix > 0) {
    const tauNoise = (tier.clickTauMs / 1000);
    const raw = new Float32Array(noiseLen);
    for (let i = 0; i < noiseLen; i++) {
      raw[i] = (rnd() * 2 - 1) * Math.exp(-(i * invRate) / tauNoise);
    }
    const filtered = lowpass(raw, s.noiseLpfHz, s.noiseQ, rate);

    // 噪声按分音总增益归一化，否则 noiseMix 的含义会随分音个数漂移
    let partialSum = 0;
    for (const g of gains) partialSum += g;
    const noiseAmp = (s.noiseMix / Math.max(0.001, 1 - s.noiseMix)) * partialSum * 0.5;

    for (let i = 0; i < noiseLen && i < n; i++) out[i] += filtered[i] * noiseAmp;
  }

  // ── 归一化 + 强度 + 末尾淡出 ──
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(out[i]);
    if (a > peak) peak = a;
  }
  // 归一到 1 再乘 gain。不归一的话，分音个数多的金属会比木头响一倍，
  // 用户换材质时听到的是"音量变了"而不是"音色变了"
  const norm = (peak > 1e-6 ? 1 / peak : 0) * s.gain * tier.amp;

  const fadeN = Math.min(n, Math.ceil((FADE_OUT_MS / 1000) * rate));
  const fadeStart = n - fadeN;
  for (let i = 0; i < n; i++) {
    let g = norm;
    if (i >= fadeStart) {
      // 升余弦淡出，不是线性 —— 线性的斜率在两端有折点，仍有轻微可闻感。
      // 只在最后 40ms 生效，前面的波形完全不动
      const x = (i - fadeStart) / fadeN;
      g *= 0.5 + 0.5 * Math.cos(Math.PI * x);
    }
    out[i] *= g;
  }

  return out;
}

/**
 * RBJ Audio EQ Cookbook 的双极点低通。
 *
 * Q 是谐振量。玉的 Q=30 会在 6kHz 上"叮"一下 —— 这正是碰撞音里
 * 那个清脆的"嗒"。没有谐振的话噪声只是一层闷响，撞击就没了着力点。
 */
function lowpass(input, cutoffHz, q, rate) {
  const out = new Float32Array(input.length);

  // 截止频率必须低于奈奎斯特，否则 w0 → π，系数退化
  const f0 = Math.min(cutoffHz, rate * 0.45);
  const w0 = (2 * Math.PI * f0) / rate;
  const cw = Math.cos(w0);
  const sw = Math.sin(w0);
  const alpha = sw / (2 * Math.max(0.05, q));

  const a0 = 1 + alpha;
  const b0 = ((1 - cw) / 2) / a0;
  const b1 = (1 - cw) / a0;
  const b2 = b0;
  const a1 = (-2 * cw) / a0;
  const a2 = (1 - alpha) / a0;

  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x0 = input[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    out[i] = y0;
    x2 = x1; x1 = x0;
    y2 = y1; y1 = y0;
  }
  return out;
}

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ── 离线测量。tools/test-bake.mjs 用这个证明四种材质真的不一样 ──

/**
 * 从波形里量出三个数。人耳分辨材质靠的就是这三样：
 *   decayMs     — 包络衰到 -20dB 要多久（金属长余韵 vs 塑料"啪"）
 *   centroidHz  — 频谱重心（金属亮 vs 木头闷）
 *   zcr         — 过零率，centroid 的廉价替身，用来交叉验证
 */
export function measure(samples, rate) {
  const win = Math.max(1, Math.round(rate * 0.005));   // 5ms 窗
  const frames = Math.floor(samples.length / win);

  // 逐窗 RMS 包络
  const env = new Float64Array(frames);
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let j = f * win; j < (f + 1) * win; j++) sum += samples[j] * samples[j];
    env[f] = Math.sqrt(sum / win);
  }

  let envMax = 0, envMaxAt = 0;
  for (let f = 0; f < frames; f++) {
    if (env[f] > envMax) { envMax = env[f]; envMaxAt = f; }
  }

  // ⚠️ 阈值必须和被测的量同量纲。早先拿 RMS 去比 peak*0.1 ——
  //    峰值是瞬时值、RMS 是有效值，两者差 1/√2，于是标称的 -20dB
  //    实际测的是 -17dB，而且各材质差得还不一样（噪声占比不同，
  //    峰值因数就不同）。跨材质比较时这个偏差会污染结论
  const thresh = envMax * 0.1;                          // 真 -20dB
  let decayFrame = frames;
  for (let f = envMaxAt; f < frames; f++) {
    if (env[f] < thresh) { decayFrame = f; break; }
  }

  let zc = 0;
  for (let i = 1; i < samples.length; i++) {
    if ((samples[i - 1] < 0) !== (samples[i] < 0)) zc++;
  }

  // 起振陡度：第一窗 RMS 相对包络峰值。真正的撞击是"一上来就满"，
  // 慢起振听起来像被风吹而不是被敲。用这个而不是"最大瞬时值的位置" ——
  // 四个非谐分音叠加时包络顶部本来就是平的，最大值落在 0ms 还是 20ms
  // 纯属相位巧合，没有听感含义
  const attack = envMax > 1e-9 ? env[0] / envMax : 0;

  return {
    peak: Number(peak.toFixed(4)),
    attack: Number(attack.toFixed(3)),
    decayMs: Number((((decayFrame - envMaxAt) * win / rate) * 1000).toFixed(1)),
    zcr: Number((zc / (samples.length / rate)).toFixed(0)),
    lengthMs: Number(((samples.length / rate) * 1000).toFixed(0)),
  };
}

/** 在 Node 里也能跑：不依赖 AudioContext 的纯渲染入口 */
export function renderForTest(materialId, level, variant) {
  const s = getMaterial(materialId).sound;
  const seed = hashSeed(`${getMaterial(materialId).id}:${level}:${variant}`);
  // 44100 是 Node 侧的采样率。真实设备上用 ctx.sampleRate
  return { samples: renderOne(s, level, mulberry32(seed), 44100), rate: 44100 };
}
