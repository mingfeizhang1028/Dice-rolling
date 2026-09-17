/**
 * 甩动自测。
 *
 * ⚠️ 这是整个 P2 里最需要自动验证的一块：甩动是唯一一条**桌面无法
 *    真机验证**的路径。Chrome DevTools 的 Sensors 面板能手动模拟单次
 *    加速度，但没有任何办法在浏览器里跑"揣兜里走两分钟"这种回归。
 *    而误触发恰恰是甩动唯一的真实失败模式 —— 手机在兜里走一路、
 *    掷了一路，用户在发现之前根本不知道发生了什么。
 *
 * 所以这里合成加速度轨迹喂给检测器。合成不是妥协：真实走路的
 * 加速度特征（2Hz 步频 + 每 500ms 一次脚跟冲击 + 小幅抖动）
 * 是可以按实测幅值建模的，而且**生成得比真实情况更苛刻**
 * （脚跟冲击取到 20 m/s²，比多数实测值大），测试才有意义。
 *
 * 三个量决定了检测器好不好用，逐个测：
 *   ① 误触发率 —— 走路/掏手机/放桌上必须零触发
 *   ② 召回率   —— 轻晃和猛晃都必须触发，且各只触发一次
 *   ③ 力度映射 —— 猛晃的 power 必须显著大于轻晃
 */

import { createShakeDetector } from '../src/input/shake.js';

let fail = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) fail++;
  console.log(`${cond ? '✓' : '✗'} ${label}${detail ? '  ' + detail : ''}`);
};

// ── 确定性随机。测试必须可复现 ──
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const G = 9.81;

/**
 * 传感器噪声幅值，m/s²，逐采样点。
 *
 * ⚠️ 这个值必须取真实量级。MEMS 加速度计的噪声密度约
 *    0.005 m/s²/√Hz，60Hz 下每个采样点约 0.04 m/s²。
 *
 *    我最初随手写了 0.4 —— 高了 10 倍。后果不是"测试更严格"，
 *    而是**结论完全反过来**：噪声在 60Hz 下的逐帧差分被 dt 放大成
 *    约 210 m/s³ 的恒定加加速度（占满量程 15%），把轻晃的信号
 *    整个淹掉，于是看起来"轻晃和走路无法区分"，而那是噪声造成的
 *    假象，不是设备的真相。合成测试里任何一个物理量都要按真实
 *    量级取，否则调出来的参数在真机上完全是另一回事。
 */
const SENSOR_NOISE = 0.04;

/**
 * 走路：手机在口袋里。
 *
 * 三个成分，都按实测幅值取：
 *   · 2Hz 的步频振荡（腿的摆动传到口袋）
 *   · 每 500ms 一次的脚跟冲击 —— 20 m/s² 尖峰、20ms 衰减。
 *     取到 20 是刻意的保守：多数实测在 10–15，取大一点测试才有意义
 *   · 各轴随机抖动
 * 再叠一个缓慢的重力方向变化（口袋里的手机不是完全固定的）
 */
function walkTrace({ seconds = 120, rate = 60, heelPeak = 20, seed = 7 } = {}) {
  const rnd = rng(seed);
  const dt = 1 / rate;
  const n = Math.round(seconds * rate);
  const out = [];
  const strikes = [];
  for (let t = 0.5; t < seconds; t += 0.5) strikes.push(t);

  for (let i = 0; i < n; i++) {
    const t = i * dt;
    const swing = 4.0 * Math.sin(2 * Math.PI * 2.0 * t);
    let heel = 0;
    for (const ts of strikes) {
      const d = t - ts;
      if (d >= 0 && d < 0.08) heel += heelPeak * Math.exp(-d / 0.012);
    }
    const jx = (rnd() * 2 - 1) * SENSOR_NOISE;
    const jy = (rnd() * 2 - 1) * SENSOR_NOISE;
    const jz = (rnd() * 2 - 1) * SENSOR_NOISE;
    // 重力方向的缓慢摆动（步态导致手机在口袋里翻转几度）
    const tilt = 0.35 * Math.sin(2 * Math.PI * 0.5 * t);
    out.push({
      x: jx + G * Math.sin(tilt) * 0.6,
      y: jy,
      z: -G * Math.cos(tilt) + swing + heel + jz,
      t: t * 1000,
    });
  }
  return out;
}

/** 一次刻意的甩动：若干个周期的正弦摆动，持续 duration 秒 */
function shakeTrace({ amp = 20, freq = 3, cycles = 3, rate = 60, seed = 11 } = {}) {
  const rnd = rng(seed);
  const seconds = cycles / freq;
  const dt = 1 / rate;
  const n = Math.round(seconds * rate);
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = i * dt;
    // 起手的 15% 淡入，收手的 15% 淡出 —— 真实手势不会瞬间起止
    const env = Math.min(1, t / (seconds * 0.15), (seconds - t) / (seconds * 0.15));
    const s = amp * env * Math.sin(2 * Math.PI * freq * t);
    out.push({
      x: s * 0.7 + (rnd() * 2 - 1) * SENSOR_NOISE,
      y: (rnd() * 2 - 1) * SENSOR_NOISE,
      z: -G + s * 0.5 + (rnd() * 2 - 1) * SENSOR_NOISE,
      t: t * 1000,
    });
  }
  return out;
}

/** 把手机从桌上拿起来：重力的方向在几百毫秒里转 90° */
function pickupTrace({ seconds = 0.8, rate = 60 } = {}) {
  const dt = 1 / rate;
  const n = Math.round(seconds * rate);
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = i * dt;
    const p = t / seconds;
    const ang = (Math.PI / 2) * (p * p * (3 - 2 * p));   // smoothstep
    out.push({ x: G * Math.sin(ang), y: 0, z: -G * Math.cos(ang), t: t * 1000 });
  }
  return out;
}

/** 把手机放到桌上：一下闷响，然后静止 */
function thudTrace({ peak = 18, rate = 60 } = {}) {
  const dt = 1 / rate;
  const n = Math.round(1.0 * rate);
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = i * dt;
    const d = t - 0.2;
    const s = d >= 0 ? peak * Math.exp(-d / 0.010) * Math.sin(2 * Math.PI * 30 * d) : 0;
    out.push({ x: 0, y: 0, z: -G + s, t: t * 1000 });
  }
  return out;
}

/** 静止：只有传感器噪声 */
function stillTrace({ seconds = 30, rate = 60, seed = 3 } = {}) {
  const rnd = rng(seed);
  const dt = 1 / rate;
  const n = Math.round(seconds * rate);
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      x: (rnd() * 2 - 1) * SENSOR_NOISE,
      y: (rnd() * 2 - 1) * SENSOR_NOISE,
      z: -G + (rnd() * 2 - 1) * SENSOR_NOISE,
      t: i * dt * 1000,
    });
  }
  return out;
}

/** 跑一条轨迹，收集事件 */
function run(trace) {
  const events = { arm: 0, throw: 0, powers: [], disarm: 0, maxLevel: 0 };
  const det = createShakeDetector({
    onEnergy: (l) => { if (l > events.maxLevel) events.maxLevel = l; },
    onArm: () => events.arm++,
    onDisarm: () => events.disarm++,
    onThrow: (power) => { events.throw++; events.powers.push(Number(power.toFixed(3))); },
  });
  for (const s of trace) det.feed(s.x, s.y, s.z, s.t);
  return events;
}

// ── 1. 误触发：这是甩动唯一的真实失败模式 ──
console.log('── 不该触发的（误触发 = 手机在兜里自己掷）──\n');

{
  const walk = walkTrace({ seconds: 120 });
  const e = run(walk);
  console.log(`  走路 120 秒（${walk.length} 个采样点，脚跟冲击峰值 20 m/s²）`);
  console.log(`    触发 ${e.throw} 次，抬手 ${e.arm} 次，能量峰值 ${e.maxLevel.toFixed(2)}\n`);
  ok('揣兜走 2 分钟：0 次投掷', e.throw === 0, `实际 ${e.throw} 次`);
  ok('揣兜走 2 分钟：0 次抬手', e.arm === 0, `实际 ${e.arm} 次`);
}

{
  const e = run(pickupTrace());
  ok('把手机从桌上拿起来：不触发', e.throw === 0, `arm=${e.arm} throw=${e.throw} 峰值${e.maxLevel.toFixed(2)}`);
}
{
  const e = run(thudTrace());
  ok('把手机放到桌上：不触发', e.throw === 0, `arm=${e.arm} throw=${e.throw} 峰值${e.maxLevel.toFixed(2)}`);
}
{
  const e = run(stillTrace());
  ok('静止 30 秒：不触发', e.throw === 0, `峰值${e.maxLevel.toFixed(2)}`);
}

// 跑一天的强度要够 —— 走路峰值若已经逼近抬手阈值，说明余量不足，
// 换个口袋、换双鞋就会误触发
{
  const e = run(walkTrace({ seconds: 120 }));
  const armLevel = 0.26;
  ok('走路的能量峰值离抬手阈值有 ≥30% 余量', e.maxLevel < armLevel * 0.7,
     `走路峰值 ${e.maxLevel.toFixed(3)} vs 阈值 ${armLevel}`);
}

// ── 2. 召回：该触发的必须触发 ──
console.log('\n── 该触发的 ──\n');

const gentle = run(shakeTrace({ amp: 14, freq: 2.4, cycles: 2 }));
const hard = run(shakeTrace({ amp: 30, freq: 3.4, cycles: 4 }));

console.log(`  轻晃  触发 ${gentle.throw} 次，power ${JSON.stringify(gentle.powers)}`);
console.log(`  猛晃  触发 ${hard.throw} 次，power ${JSON.stringify(hard.powers)}\n`);

ok('轻晃触发', gentle.throw >= 1, `${gentle.throw} 次`);
ok('猛晃触发', hard.throw >= 1, `${hard.throw} 次`);
// 一次手势只该掷一次。两次说明冷却窗口太短，骰子还在空中就又掷了
ok('一次手势只掷一次', gentle.throw === 1 && hard.throw === 1,
   `轻 ${gentle.throw} / 猛 ${hard.throw}`);
ok('触发前有抬手（手感上是"抬手→甩出"两段）', gentle.arm >= 1 && hard.arm >= 1,
   `轻 arm=${gentle.arm} / 猛 arm=${hard.arm}`);

// ── 3. 力度映射：轻晃小掷、猛晃大掷 ──
//
// 用户的原话诉求里有"猛晃大掷"这一条。power 若和力度无关，
// 甩动就退化成一个开关，用户会觉得"晃多大力都一样"。
console.log('');
const gp = gentle.powers[0] ?? 0;
const hp = hard.powers[0] ?? 0;
ok('猛晃的 power 显著大于轻晃', hp > gp + 0.15, `轻 ${gp} → 猛 ${hp}`);
ok('power 在 0..1 内', gentle.powers.concat(hard.powers).every((p) => p >= 0 && p <= 1));

// ── 4. 冷却与重新武装 ──
console.log('\n── 冷却与重新武装 ──\n');

/** 把两条轨迹接起来，中间空一段时间 */
function splice(a, b, gapSeconds) {
  const t0 = a.length ? a[a.length - 1].t + 1000 / 60 : 0;
  const shifted = b.map((s) => ({ ...s, t: s.t + t0 + gapSeconds * 1000 }));
  return a.concat(shifted);
}

function idle(seconds, rate = 60, t0 = 0) {
  const out = [];
  for (let i = 0; i < Math.round(seconds * rate); i++) {
    out.push({ x: 0, y: 0, z: -G, t: t0 + (i * 1000) / rate });
  }
  return out;
}

{
  // 两次甩动间隔 2.5 秒 —— 足够冷却、足够静止，应该掷两次
  const s1 = shakeTrace({ amp: 26, freq: 3.2, cycles: 3 });
  const g1 = idle(2.5, 60, s1[s1.length - 1].t + 1000 / 60);
  const s2 = shakeTrace({ amp: 26, freq: 3.2, cycles: 3 }).map((s) => ({
    ...s, t: s.t + g1[g1.length - 1].t + 1000 / 60,
  }));
  const e = run(s1.concat(g1).concat(s2));
  ok('间隔 2.5 秒的两次甩动 → 2 次投掷', e.throw === 2, `${e.throw} 次`);
}

{
  // 两次甩动只隔 0.25 秒 —— 冷却期内，应该只掷一次
  const s1 = shakeTrace({ amp: 26, freq: 3.2, cycles: 3 });
  const s2 = shakeTrace({ amp: 26, freq: 3.2, cycles: 3 }).map((s) => ({
    ...s, t: s.t + s1[s1.length - 1].t + 250,
  }));
  const e = run(s1.concat(s2));
  ok('间隔 0.25 秒的两次甩动 → 只掷 1 次', e.throw === 1, `${e.throw} 次`);
}

{
  // 抬手了但没甩，手又放下 —— 不该触发，且要回到 IDLE 以便下次正常
  const armOnly = shakeTrace({ amp: 9, freq: 2.0, cycles: 2 });   // 只够抬手，不够甩
  const rest = idle(2.0, 60, armOnly[armOnly.length - 1].t + 1000 / 60);
  const after = shakeTrace({ amp: 28, freq: 3.2, cycles: 3 }).map((s) => ({
    ...s, t: s.t + rest[rest.length - 1].t + 1000 / 60,
  }));
  const e = run(armOnly.concat(rest).concat(after));
  ok('抬手未甩不触发，且之后仍能正常触发', e.throw === 1, `${e.throw} 次（期望 1）`);
}

// ── 5. 采样率无关 ──
//
// ⚠️ 判据除以 dt 的全部理由就在这一条。Android 约 60Hz、iOS 可到 100Hz。
//    若用逐帧差分而不除以 dt，同一手势在两种设备上差 1.7 倍，
//    阈值就得按设备调 —— 那等于没法调。
console.log('');
{
  const rates = [40, 60, 100];
  const results = rates.map((r) => run(shakeTrace({ amp: 26, freq: 3.2, cycles: 3, rate: r })));
  const walks = rates.map((r) => run(walkTrace({ seconds: 60, rate: r })));
  console.log(`  ${rates.map((r, i) => `${r}Hz: 晃${results[i].throw}/走${walks[i].throw}`).join('  ')}\n`);
  ok('各采样率下都恰好触发一次', results.every((e) => e.throw === 1),
     results.map((e) => e.throw).join(' / '));
  ok('各采样率下走路都不触发', walks.every((e) => e.throw === 0),
     walks.map((e) => e.throw).join(' / '));
  // power 也不能差太多，否则"猛晃大掷"在不同手机上力度不一样
  const powers = results.map((e) => e.powers[0] ?? 0);
  const spread = Math.max(...powers) - Math.min(...powers);
  ok('各采样率下 power 一致（差 <0.2）', spread < 0.2,
     powers.map((p) => p.toFixed(2)).join(' / '));
}

// ── 6. 异常输入不能崩 ──
//
// 传感器偶尔会给出 null 或 NaN（尤其在权限刚拿到、传感器在自检时）。
// 这里不检查的话，一次 NaN 会让 energy 变成 NaN，之后所有比较都是
// false —— 检测器静默失效，而且没有任何报错
console.log('');
{
  const det = createShakeDetector({});
  det.feed(NaN, 0, 0, 0);
  det.feed(0, NaN, 0, 16);
  det.feed(0, 0, NaN, 32);
  det.feed(null, 0, 0, 48);
  det.feed(1, 2, 3, 64);
  ok('NaN / null 输入不污染状态', Number.isFinite(det.energy), `energy=${det.energy}`);
}

{
  // 时间戳重复或倒流。dt 若不夹紧，jerk 会冲到 ±Infinity
  const det = createShakeDetector({});
  det.feed(0, 0, -G, 1000);
  det.feed(5, 5, -G, 1000);      // 同一时刻
  det.feed(0, 0, -G, 900);       // 时间倒流
  ok('时间戳重复/倒流不产生 Inf', Number.isFinite(det.energy), `energy=${det.energy}`);
  ok('时间戳异常不至于触发', det.state === 'IDLE', `state=${det.state}`);
}

console.log(fail ? `\n✗ ${fail} 项失败` : '\n✓ 全部通过');
process.exit(fail ? 1 : 0);
