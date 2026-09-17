/**
 * 环境音。四种：雨 / 白噪 / 粉噪 / 棕噪。
 *
 * 用户的原话是"投的时候也最好能加一些自然的白噪声能更心净一点"——
 * 所以它不是为了好听，是为了让人静下来。这条决定了几个设计：
 *   · 默认是雨，不是白噪。纯白噪是"嘶——"，听久了烦躁；雨有颗粒，
 *     大脑会把它归到"外面在下雨"这一类，反而放松。
 *   · 低频垫底。只有颗粒会显得干、像电流声，垫一层棕噪才像真的雨。
 *   · 音量刻意偏低，且**落定后完全消失**。揭晓那一秒要安静 ——
 *     噪声散尽、结果浮现，这 600ms 的空白是节奏本身。
 *
 * ⚠️ 雨声的关键是**泊松到达的颗粒事件**，不是滤波噪声。
 *    纯滤波噪声只能得到"嘶嘶"声，一点也不像雨。三条让它像真的：
 *    ① 间隔取指数分布 —— 自然出现"密一阵疏一阵"的簇。
 *       固定间隔听起来像机关枪，是合成雨声最典型的失败。
 *    ② 每滴独立随机：高通截止、音量、时长、声像全部各抽各的。
 *       尤其是**随机声像**，这一条一加，雨立刻有了空间宽度。
 *    ③ 不要用 AudioWorklet。前瞻调度器就够了，少一整套降级路径。
 */

import { mulberry32 } from '../core/rng.js';
import { getAmbBus, getContext } from './engine.js';
import { emit } from '../core/bus.js';

/** 噪声床的长度。2 秒足够长到听不出周期，又足够短到瞬间生成 */
const BED_SECONDS = 2;

/** 循环点的交叉淡化长度。不淡的话每 2 秒会有一个"咔" */
const SEAM_FADE_MS = 120;

/** 前瞻调度的两个参数。照搬 Chris Wilson "A Tale of Two Clocks" */
const LOOKAHEAD_S = 0.2;
const TICK_MS = 25;

/** 雨滴颗粒的长度 */
const DROP_MS = 62;

/** 雨滴数量的范围，对应 energy 0 → 1。上限别调太高：超过约 60/s 就糊成一片嘶声，反而失去颗粒感 */
const DROP_RATE_MIN = 5;
const DROP_RATE_MAX = 44;

/** 噪声床的低通截止范围，对应 energy 0 → 1。甩得猛，"雨"听起来更近更亮 */
const BED_LP_MIN = 2600;
const BED_LP_MAX = 8200;

/** 环境音的四个档位。flow 状态机切档，不直接调 gain */
export const AMB_LEVELS = {
  IDLE: 0.34,      // 静置时的底噪。不刺耳，但能盖住房间里的空调声
  ARMING: 0.55,    // 抬手准备，雨开始靠近
  THROWING: 1.0,   // 骰子在空中，雨最大
  RESULT: 0,       // 揭晓时完全安静
};

let ctx = null;
let bus = null;

let bedSource = null;
let bedFilter = null;
let bedGain = null;
let dropBus = null;

let kind = 'rain';
let energy = 0;
let targetGain = 0;
let running = false;

let tickTimer = null;
let nextDropAt = 0;
let dropIndex = 0;
let dropBuffers = [];
const liveDrops = [];

/** 预生成的噪声床，按 kind 缓存。换 kind 不重新生成 */
const bedCache = new Map();

/** 确定性种子。雨声每次启动都一样，用户不会觉得"这次的声音不对" */
const SEED = 0x5eed1a1;

export function createAmbience() {
  ctx = getContext();
  bus = getAmbBus();
  if (!ctx || !bus) return null;

  bedFilter = ctx.createBiquadFilter();
  bedFilter.type = 'lowpass';
  bedFilter.frequency.value = BED_LP_MIN;
  bedFilter.Q.value = 0.7;

  bedGain = ctx.createGain();
  bedGain.gain.value = 0;

  dropBus = ctx.createGain();
  dropBus.gain.value = 0;

  bedFilter.connect(bedGain);
  bedGain.connect(bus);
  dropBus.connect(bus);

  return { setKind, setEnergy, fadeTo, start, stop, getStats };
}

function ensureBedBuffers() {
  if (dropBuffers.length) return;
  const rnd = mulberry32(SEED ^ 0x9e37);
  // 一滴雨：极快起振 + 指数衰减的带限噪声。
  // 起振用 2ms 而不是 0 —— 硬起振的波形角点会产生一个宽频"啪"，
  // 听起来像静电而不是水滴
  const n = Math.ceil((DROP_MS / 1000) * ctx.sampleRate);
  const attackN = Math.max(1, Math.ceil(0.002 * ctx.sampleRate));
  const base = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / ctx.sampleRate;
    const env = Math.exp(-t / (DROP_MS / 4000));
    const atk = i < attackN ? i / attackN : 1;
    base[i] = (rnd() * 2 - 1) * env * atk;
  }
  // 4 个变体，播放时再叠随机速率 → 实际音色空间远大于 4
  for (let v = 0; v < 4; v++) {
    const samples = new Float32Array(n);
    for (let i = 0; i < n; i++) samples[i] = base[i] * (0.82 + rnd() * 0.36);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    buf.copyToChannel(samples, 0);
    dropBuffers.push(buf);
  }
}

/**
 * 造一段可无缝循环的噪声。
 *
 * ⚠️ 直接周期性播放一段噪声，在循环点会有一次波形跳变 —— 听感是
 *    每 2 秒"咔"一下。噪声本身听不出周期，但这个跳变非常明显。
 *    解法是生成 N+F 个样本，把 [N, N+F) 这段"续写"交叉淡化进开头：
 *    于是 buf[0] 接得上 buf[N-1]，环就闭合了。
 */
function makeBed(kindId) {
  if (bedCache.has(kindId)) return bedCache.get(kindId);
  const samples = renderBed(kindId, ctx.sampleRate);
  const buf = ctx.createBuffer(1, samples.length, ctx.sampleRate);
  buf.copyToChannel(samples, 0);
  bedCache.set(kindId, buf);
  return buf;
}

/**
 * 造一段可无缝循环的噪声。纯函数，不碰 AudioContext ——
 * 于是 tools/test-ambience.mjs 能在 Node 里量它的循环接缝和频谱。
 *
 * ⚠️ 直接周期性播放一段噪声，在循环点会有一次波形跳变 —— 听感是
 *    每 2 秒"咔"一下。噪声本身听不出周期，但这个跳变非常明显。
 *    解法是生成 N+F 个样本，把 [N, N+F) 这段"续写"交叉淡化进开头：
 *    于是 buf[0] 接得上 buf[N-1]，环就闭合了。
 */
export function renderBed(kindId, rate, seconds = BED_SECONDS) {
  const rnd = mulberry32((SEED ^ hash(kindId)) >>> 0);
  const fadeN = Math.ceil((SEAM_FADE_MS / 1000) * rate);
  const total = Math.ceil(seconds * rate) + fadeN;
  const raw = new Float32Array(total);

  if (kindId === 'white') {
    for (let i = 0; i < total; i++) raw[i] = rnd() * 2 - 1;
  } else if (kindId === 'pink') {
    // Paul Kellet 的粉噪近似。7 个一阶极点，误差 ±0.05dB (10Hz–20kHz)
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < total; i++) {
      const w = rnd() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.0168980;
      raw[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
  } else {
    // 棕噪 = 白噪的泄漏积分（rain 的底层垫的也是它）。
    // ⚠️ 泄漏系数不能取 1。取 1 就是纯积分 = 随机游走，方差随长度
    //    无界增长，听感上先从"噗"变成慢慢漂移的低频晃动。
    //    除以 1.02 每一步丢 2% —— 这个泄漏就是"有界"的全部保证，
    //    也是 tools/test-ambience.mjs 里漂移测试要抓的东西
    let last = 0;
    for (let i = 0; i < total; i++) {
      const w = rnd() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      raw[i] = last * 3.5;
    }
  }

  // 交叉淡化闭合循环
  const out = new Float32Array(Math.ceil(seconds * rate));
  out.set(raw.subarray(0, out.length));
  for (let i = 0; i < fadeN; i++) {
    const t = i / fadeN;
    out[i] = out[i] * t + raw[out.length + i] * (1 - t);
  }

  // 归一化到 -6dBFS。不归一的话白噪/粉噪/棕噪三种的响度差一大截，
  // 用户切 kind 时听到的是"音量变了"
  let peak = 0;
  for (let i = 0; i < out.length; i++) {
    const a = Math.abs(out[i]);
    if (a > peak) peak = a;
  }
  const k = peak > 1e-6 ? 0.5 / peak : 0;
  for (let i = 0; i < out.length; i++) out[i] *= k;

  return out;
}

function startBed() {
  stopBed();
  const buf = makeBed(kind);
  bedSource = ctx.createBufferSource();
  bedSource.buffer = buf;
  bedSource.loop = true;
  bedSource.connect(bedFilter);
  bedSource.start();
}

function stopBed() {
  if (!bedSource) return;
  try { bedSource.stop(); } catch { /* 已经停了 */ }
  try { bedSource.disconnect(); } catch { /* 已经断开 */ }
  bedSource = null;
}

// ── 对外接口 ──

function start() {
  if (running || !ctx) return;
  running = true;
  ensureBedBuffers();
  startBed();
  nextDropAt = ctx.currentTime + 0.1;
  tickTimer = setInterval(tick, TICK_MS);
  document.addEventListener('visibilitychange', onVisibility);
}

function stop() {
  running = false;
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  stopBed();
  for (const d of liveDrops) stopDrop(d, 60);
  liveDrops.length = 0;
  dropBuffers.length = 0;
  document.removeEventListener('visibilitychange', onVisibility);
}

/**
 * 切档。**只改目标值**，实际增益走斜坡 —— 状态机切档是瞬时的，
 * 但声音突变会"咔"。600ms 是 SETTLING 的长度，正好用来淡出。
 */
function fadeTo(level, ms = 400) {
  targetGain = level;
  if (!ctx) return;
  const now = ctx.currentTime;
  const end = now + Math.max(0.01, ms / 1000);
  for (const g of [bedGain, dropBus]) {
    g.gain.cancelScheduledValues(now);
    g.gain.setValueAtTime(g.gain.value, now);
    g.gain.linearRampToValueAtTime(level, end);
  }
}

/**
 * 甩动能量 0..1。同时映射到雨滴密度和噪声床的亮度。
 *
 * ⚠️ 密度取**平方**映射：人耳对"密度变化"的感知是压缩的，
 *    线性映射会让 0.1→0.2 和 0.9→1.0 听起来变化差不多，
 *    而实际上前者应该几乎察觉不到、后者应该汹涌。
 *    平方之后低能量段的变化被压平，高能量段被拉开，正合适。
 */
function setEnergy(v) {
  energy = Math.max(0, Math.min(1, Number(v) || 0));
  if (!ctx) return;
  const curved = energy * energy;
  const lp = BED_LP_MIN + (BED_LP_MAX - BED_LP_MIN) * curved;
  bedFilter.frequency.setTargetAtTime(lp, ctx.currentTime, 0.25);
}

function setKind(next) {
  if (!ctx || next === kind) return;
  kind = next;
  if (!running) return;
  // 雨才有颗粒（tick 里按 kind 判断）。其余三种是纯噪声床 ——
  // 给白噪也撒"雨滴"就自相矛盾了
  const bed = makeBed(next);
  startBed();
  emit('ambience:kind', { kind: next, bedMs: Math.round((bed.length / ctx.sampleRate) * 1000) });
}

function getStats() {
  return {
    kind,
    running,
    energy: Number(energy.toFixed(2)),
    dropRate: Number(currentDropRate().toFixed(1)),
    bedCutoffHz: Math.round(bedFilter?.frequency.value ?? 0),
    liveDrops: liveDrops.length,
    gain: Number((bedGain?.gain.value ?? 0).toFixed(2)),
    target: targetGain,
  };
}

// ── 调度 ──

function currentDropRate() {
  const curved = energy * energy;
  return DROP_RATE_MIN + (DROP_RATE_MAX - DROP_RATE_MIN) * curved;
}

/**
 * ⚠️ 这个 while 里有两个必须写对的细节。
 *
 * ① **追赶夹紧。** 页面切到后台时 setInterval 被节流到 1 秒一次，
 *    于是 nextDropAt 会远远落在 currentTime 后面。不夹的话下一拍
 *    会试图把欠下的几百滴雨**全部排在过去的时间点上** ——
 *    Web Audio 对过去的时间点是"立即播放"，结果是几百个节点同一
 *    瞬间起播，一声爆响 + 音频线程卡死。
 *    （切后台时我们本来就会淡出，但淡出有 400ms 斜坡，
 *      而第一次节流 tick 可能来得更早。）
 *
 * ② **rate 为 0 时不能进循环。** 1/0 = Infinity，nextDropAt 变成
 *    Infinity 之后这个 while 就永远不执行了 —— 能量再升上来也不会
 *    恢复下雨。所以必须显式判断。
 */
function tick() {
  if (!running || !ctx) return;
  const now = ctx.currentTime;
  if (nextDropAt < now) nextDropAt = now;

  const rate = kind === 'rain' ? currentDropRate() : 0;
  if (rate <= 0.01) {
    nextDropAt = now + LOOKAHEAD_S;
    return;
  }

  const horizon = now + LOOKAHEAD_S;
  let guard = 0;
  while (nextDropAt < horizon && guard++ < 200) {
    scheduleDrop(nextDropAt);
    nextDropAt += poissonInterval(rate);
  }
}

/**
 * 泊松过程的到达间隔采样（指数分布）。
 *
 * 单独抽出来是为了能在 Node 里量它的分布 ——
 * "是不是泊松"直接决定雨听起来像雨还是像机关枪，而这一条
 * 光靠听是没法在开发机上验证的（我听不到声音）。
 * 判据是变异系数 CV = 标准差/均值：指数分布 CV = 1，
 * 固定间隔 CV = 0。见 tools/test-ambience.mjs。
 */
export function poissonInterval(rate) {
  // 1-U 而不是 U：U 可能取到 0，log(0) = -Infinity
  return -Math.log(1 - Math.random()) / rate;
}

function scheduleDrop(at) {
  if (!ctx || !dropBus) return;
  // 声像只取 ±0.35。雨是一个"场"，不是左右两串雨；
  // 拉太开听感会变成两个发声点，失去包围感
  const pan = (Math.random() * 2 - 1) * 0.35;
  const src = ctx.createBufferSource();
  src.buffer = dropBuffers[dropIndex++ % dropBuffers.length];
  // 速率随机同时改变音高和时长，是"每一滴都不一样"的主要来源
  src.playbackRate.value = 0.72 + Math.random() * 0.85;

  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  // 对数均匀：频率按倍频程感知，线性均匀会让低截止的那一半挤在一起
  hp.frequency.value = Math.exp(Math.log(2200) + Math.random() * (Math.log(5200) - Math.log(2200)));
  hp.Q.value = 0.9;

  const g = ctx.createGain();
  // 音量抖动 ±35%。不做这一步的话密度一高就暴露成规律的"嗒嗒嗒"
  g.gain.value = 0.055 + Math.random() * 0.055;

  let tail = g;
  let panner = null;
  if (ctx.createStereoPanner) {
    panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    g.connect(panner);
    tail = panner;
  }
  src.connect(hp);
  hp.connect(g);
  tail.connect(dropBus);

  const drop = { src, hp, g, tail, done: false };
  src.onended = () => {
    if (drop.done) return;
    drop.done = true;
    try { src.disconnect(); hp.disconnect(); g.disconnect(); tail.disconnect(); } catch { /* 已断开 */ }
    const i = liveDrops.indexOf(drop);
    if (i >= 0) liveDrops.splice(i, 1);
  };

  src.start(at);
  liveDrops.push(drop);
}

function stopDrop(d, fadeMs) {
  if (!d || d.done) return;
  const now = ctx.currentTime;
  try {
    d.g.gain.cancelScheduledValues(now);
    d.g.gain.setValueAtTime(d.g.gain.value, now);
    d.g.gain.linearRampToValueAtTime(0, now + fadeMs / 1000);
    d.src.stop(now + fadeMs / 1000 + 0.005);
  } catch { /* 已经停了 */ }
}

/**
 * 切到后台就停。
 *
 * ⚠️ 不只是省电 —— 手机揣兜里还在放雨声，用户会以为程序没关干净。
 *    而且此时 setInterval 被节流，调度精度全失。
 *    回到前台不自动恢复：恢复由 flow 状态机在下次进 IDLE 时触发，
 *    否则用户切回来会听到一阵突兀的雨声。
 */
function onVisibility() {
  if (document.hidden) {
    if (running) {
      stop();
      emit('ambience:suspended', {});
    }
  }
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
