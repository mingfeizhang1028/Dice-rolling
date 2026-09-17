/**
 * 甩动检测。DeviceMotion → 归一化的投掷意图。
 *
 * ⚠️ 这个模块唯一的真实失败模式是**误触发**：手机揣兜里走一路，
 *    掷了一路。振幅阈值单独扛不住这个 —— 走路时脚跟着地的冲击
 *    是 10–15 m/s² 的尖峰，换算成加加速度比一次轻晃还大。
 *
 *    真正的判据是**持续性**，不是幅度：
 *      一次刻意甩动 = 持续 200–400ms 的高能量手势
 *      一次脚跟落地 = 1–2 个采样点的孤立尖峰
 *      一次掏手机   = 缓慢的、被重力方向变化主导的偏移
 *    所以下面用的是"能量在阈值之上持续了多久"，而不是"能量超没超阈值"。
 *    这条是设计核心，不是补丁 —— 见 tools/test-shake.mjs 里
 *    "揣兜走 2 分钟零触发"那条用例。
 *
 * 另一条纪律：能量必须**归一化**成 0..1 的意图强度，不能直接当冲量用。
 * 用户调大重力之后，"同样的甩动"应该还是同样的力度语义。
 */

import { on, emit } from '../core/bus.js';

/**
 * 加加速度（jerk）的归一化上限，单位 m/s³。
 *
 * 为什么要除以 dt 而不是直接用逐帧差分：Android 大约 60Hz、
 * iOS 可以到 100Hz，同样的手势在两种设备上逐帧差分会差 1.7 倍，
 * 于是阈值必须按设备调 —— 这是不可接受的。除以 dt 之后
 * 得到的是与采样率无关的量。
 *
 * 量级参考（实测与推算）：
 *   把手机从桌上拿起     ~50–120
 *   走路（含脚跟冲击）   ~200–900 的孤立尖峰，但持续不过 2 个采样点
 *   轻轻晃两下           ~300–600 且持续 200ms 以上
 *   用力甩               ~1500–4000
 */
const JERK_FULL = 1400;

/**
 * 判别用的平滑时间常数（秒）。
 *
 * ⚠️ 这个值**必须短**，否则"持续"判据会被平滑本身废掉：
 *    脚跟着地的冲击是一个 20ms 的孤立尖峰，但用 90ms 的平滑去跟，
 *    它会衰减成一条 117ms 的高读数曲线 —— 正好骗过 80ms 的持续判据，
 *    于是手机揣兜里走一路掷一路。
 *    35ms 下同样的尖峰只维持 2–3 个采样点（33–50ms），够不到 80ms；
 *    而一次真实的甩动是 200–400ms 的手势，平滑之后照样连续在线。
 */
const DECIDE_TAU = 0.035;

/**
 * 上报用的平滑时间常数（秒）。比判别用的慢得多。
 *
 * 判别要的是瞬时画面，环境音要的是手势的整体走势 ——
 * 用快值去驱动雨声密度会听到"嘶嘶"的抖动。
 * 两个用途要的时间尺度不一样，所以留两个。
 */
const REPORT_TAU = 0.2;

/**
 * 判定"这一瞬间算不算在动"的幅度门槛。
 *
 * ⚠️ 这个值只用来把能量二值化，**不用来判别手势**。
 *    原因见下面 duty 的注释：走路和甩动的幅度是重叠的。
 */
const ACT_LEVEL = 0.10;

/**
 * 占空比的滑动窗（秒）。
 *
 * 350ms 是一个手势的时间尺度：短于它，一次甩动会被切碎；
 * 长于它，走路的间歇会被平均掉。
 */
const DUTY_WINDOW = 0.35;

/**
 * 占空比 —— **这才是真正的判据**。
 *
 * ⚠️ 为什么不直接用幅度：走路时脚跟着地的冲击换算成加加速度是
 *    1200 m/s³ 量级（能量 0.53），**比一次轻晃（0.17）还高**。
 *    任何纯幅度阈值要么放过走路、要么滤掉轻晃，无解。
 *
 *    但两者在**时间分布**上完全不同：
 *      走路 = 每 500ms 一个 2–3 采样点的孤立尖峰，占空比 0.28
 *      甩动 = 持续 200–400ms 的连续高能量，占空比 0.59–0.96
 *    实测（tools/test-shake.mjs 里那些合成轨迹）：
 *      走路 0.282 │ 轻晃 0.589 │ 中晃 0.835 │ 猛晃 0.964
 *    2.1 倍的间隔，比幅度那一侧的 0.17 vs 0.53（反向重叠）好得多。
 *
 * 这两个数取 0.40 / 0.50 是把走路的 0.282 和轻晃的 0.589 按几何
 * 中点分开：抬手留 1.4 倍余量，甩出留 1.8 倍。
 */
const ARM_DUTY = 0.40;
const THROW_DUTY = 0.50;

/**
 * 抬手/甩出分别需要在各自占空比之上持续多久（毫秒）。
 *
 * 有占空比之后这两个数就不用扛主要判别责任了，只用来滤掉
 * 占空比曲线本身的毛刺。所以比早先的 80/40 松得多。
 */
const ARM_HOLD_MS = 60;
const THROW_HOLD_MS = 30;

/**
 * 甩出去还要求峰值能量到过这个值。
 *
 * 光有占空比没有幅度 = 持续的轻微晃动（比如边走边刷手机），
 * 那不是一次"甩"。这一条把"占空比高但幅度低"的情形挡在门外。
 */
const PEAK_MIN = 0.11;

/** 力度映射的上下界。到这个峰值就算全力 */
const PEAK_FOR_FULL_POWER = 0.75;
/**
 * 力度下限。
 *
 * 一次刻意甩动不该掷出一个"轻飘飘"的骰子 —— 用户甩了，就是
 * 想用力掷。映射从 0.35 起步，保留"猛晃大掷"的排序，
 * 又不至于让勉强达标的甩动显得没使劲。
 */
const POWER_FLOOR = 0.35;

/** 能量掉到这个值以下才算"手停了"，可以重新武装 */
const REARM_LEVEL = 0.13;
/** 手停之后要安静多久才重新武装 */
const REARM_QUIET_MS = 220;

/** 一次投掷之后的冷却。太短会在骰子还没落定时又掷一次 */
const COOLDOWN_MS = 800;

/** 抬手之后一直不甩，多久自动回到 IDLE */
const ARM_TIMEOUT_MS = 1400;

const STATE = { IDLE: 'IDLE', ARMED: 'ARMED', COOLDOWN: 'COOLDOWN' };

/**
 * 纯检测器。不碰 DeviceMotion、不碰 DOM —— 喂它样本，它给你事件。
 *
 * 抽成纯函数是为了能在 Node 里喂合成的加速度轨迹做验证。
 * 甩动是唯一一条桌面无法真机验证的路径（Chrome DevTools 的
 * Sensors 面板可以手动模拟，但没法跑"走两分钟"这种回归）。
 */
export function createShakeDetector(opts = {}) {
  const cfg = {
    jerkFull: opts.jerkFull ?? JERK_FULL,
    actLevel: opts.actLevel ?? ACT_LEVEL,
    dutyWindow: opts.dutyWindow ?? DUTY_WINDOW,
    armDuty: opts.armDuty ?? ARM_DUTY,
    throwDuty: opts.throwDuty ?? THROW_DUTY,
    armHoldMs: opts.armHoldMs ?? ARM_HOLD_MS,
    throwHoldMs: opts.throwHoldMs ?? THROW_HOLD_MS,
    peakMin: opts.peakMin ?? PEAK_MIN,
    peakForFullPower: opts.peakForFullPower ?? PEAK_FOR_FULL_POWER,
    powerFloor: opts.powerFloor ?? POWER_FLOOR,
    rearmLevel: opts.rearmLevel ?? REARM_LEVEL,
    rearmQuietMs: opts.rearmQuietMs ?? REARM_QUIET_MS,
    cooldownMs: opts.cooldownMs ?? COOLDOWN_MS,
    armTimeoutMs: opts.armTimeoutMs ?? ARM_TIMEOUT_MS,
    onEnergy: opts.onEnergy || (() => {}),
    onArm: opts.onArm || (() => {}),
    onThrow: opts.onThrow || (() => {}),
    onDisarm: opts.onDisarm || (() => {}),
  };

  let state = STATE.IDLE;
  let energy = 0;        // 判别用（快）
  let shown = 0;         // 上报用（慢）
  let duty = 0;          // 占空比。真正的主判据
  let last = null;
  let aboveArmMs = 0;
  let aboveThrowMs = 0;
  let quietMs = 0;
  let peakLevel = 0;
  let stateSince = 0;

  const d = {
    get state() { return state; },
    get energy() { return energy; },
    get duty() { return duty; },
    /** 上报给 UI / 环境音的强度。慢平滑，跟的是手势走势不是瞬时值 */
    get level() { return Math.min(1, shown / cfg.jerkFull); },

    /** 喂一个加速度样本。t 是毫秒时间戳 */
    feed(x, y, z, t) {
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;

      if (last === null) {
        last = { x, y, z, t };
        stateSince = t;
        return;
      }

      // dt 夹紧：后台切回来时可能隔了几秒，不夹的话 jerk 会算成 0，
      // 而 dt 太小（重复时间戳）会让 jerk 冲到天上造成误触发
      const dt = Math.min(0.1, Math.max(0.002, (t - last.t) / 1000));

      // 逐轴差分之和。用 includingGravity 也没关系 ——
      // 重力是常量，差分之后就没了
      const delta = Math.abs(x - last.x) + Math.abs(y - last.y) + Math.abs(z - last.z);
      const jerk = delta / dt;
      last = { x, y, z, t };

      // 两条一阶低通，时间常数不同：快的那条用来判别，慢的那条用来上报。
      // 不加"上升快回落慢"的偏置 —— 那等于给孤立尖峰加权，
      // 恰好是我们要滤掉的东西
      const kFast = Math.min(1, dt / DECIDE_TAU);
      const kSlow = Math.min(1, dt / REPORT_TAU);
      energy += (jerk - energy) * kFast;
      shown += (jerk - shown) * kSlow;

      const level = Math.min(1, energy / cfg.jerkFull);
      cfg.onEnergy(Math.min(1, shown / cfg.jerkFull));

      // 占空比：把"这一瞬算不算在动"二值化之后做长窗平均。
      // 走路是稀疏的孤立尖峰 → 长时间在阈值以下 → 占空比上不去；
      // 甩动是连续的 → 占空比很快逼近 1
      const active = level >= cfg.actLevel ? 1 : 0;
      duty += (active - duty) * Math.min(1, dt / cfg.dutyWindow);

      // 持续计时
      aboveArmMs = duty >= cfg.armDuty ? aboveArmMs + dt * 1000 : 0;
      aboveThrowMs = duty >= cfg.throwDuty ? aboveThrowMs + dt * 1000 : 0;
      quietMs = level <= cfg.rearmLevel ? quietMs + dt * 1000 : 0;

      if (level > peakLevel) peakLevel = level;

      switch (state) {
        case STATE.IDLE:
          if (aboveArmMs >= cfg.armHoldMs) toArmed(t);
          break;

        case STATE.ARMED:
          // 幅度这一条是必须的：占空比高但幅度一直上不去 =
          // 持续的轻微晃动（边走边刷手机），那不是一次"甩"
          if (aboveThrowMs >= cfg.throwHoldMs && peakLevel >= cfg.peakMin) {
            // 力度取峰值而不是当前值。当前值在甩出去的那一刻已经开始
            // 回落了（手在减速），用它会系统性地低估力度
            const span = Math.max(0.01, cfg.peakForFullPower - cfg.peakMin);
            const norm = clamp01((peakLevel - cfg.peakMin) / span);
            const power = clamp01(cfg.powerFloor + (1 - cfg.powerFloor) * norm);
            toCooldown(t);
            cfg.onThrow(power, peakLevel);
          } else if (t - stateSince > cfg.armTimeoutMs && energy < cfg.rearmLevel) {
            // 抬手半天没甩，或者手已经放下了
            toIdle(t, true);
          }
          break;

        case STATE.COOLDOWN:
          if (t - stateSince >= cfg.cooldownMs && quietMs >= cfg.rearmQuietMs) {
            toIdle(t, false);
          }
          break;
      }
    },

    /** 外部强制复位（比如用户用手势投掷了，甩动不该紧接着再触发一次） */
    reset(t = 0) {
      state = STATE.IDLE;
      energy = 0;
      shown = 0;
      duty = 0;
      last = null;
      aboveArmMs = 0;
      aboveThrowMs = 0;
      quietMs = 0;
      peakLevel = 0;
      stateSince = t;
    },

    /** 外部强制冷却。点击投掷之后调用，避免紧接着的晃动又触发一次 */
    suppress(ms, t = 0) {
      state = STATE.COOLDOWN;
      stateSince = t - cfg.cooldownMs + ms;
      energy = 0;
      shown = 0;
      duty = 0;
      aboveArmMs = 0;
      aboveThrowMs = 0;
      quietMs = 0;
      peakLevel = 0;
    },
  };

  function toArmed(t) {
    state = STATE.ARMED;
    stateSince = t;
    aboveThrowMs = 0;
    peakLevel = 0;
    cfg.onArm();
  }

  function toCooldown(t) {
    state = STATE.COOLDOWN;
    stateSince = t;
    aboveArmMs = 0;
    aboveThrowMs = 0;
    quietMs = 0;
    peakLevel = 0;
  }

  function toIdle(t, wasArmed) {
    state = STATE.IDLE;
    stateSince = t;
    aboveArmMs = 0;
    aboveThrowMs = 0;
    if (wasArmed) cfg.onDisarm();
  }

  return d;
}

// ── DeviceMotion 接线 ──

let listener = null;
let detector = null;
let supported = false;
let permission = 'unknown';   // 'granted' | 'denied' | 'unsupported' | 'unknown'

function hasApi() {
  return typeof window !== 'undefined' && 'DeviceMotionEvent' in window;
}

/** iOS 13+ 需要显式授权；其余平台没有这个静态方法，直接算通过 */
export function needsPermission() {
  return hasApi() && typeof window.DeviceMotionEvent.requestPermission === 'function';
}

export function isSupported() {
  return supported;
}

export function getPermission() {
  return permission;
}

/**
 * 必须在**用户手势里**调用（iOS 会拒绝非手势的授权请求）。
 *
 * ⚠️ 绝不 reject。甩动用不了只是少一种投掷方式，滑动和点击还在，
 *    功能必须照常可用。任何一条路径都不该因为运动权限而卡住。
 */
export async function enable(opts = {}) {
  if (!hasApi()) {
    permission = 'unsupported';
    emit('shake:unavailable', { reason: 'no DeviceMotionEvent' });
    return false;
  }

  if (needsPermission()) {
    try {
      const res = await window.DeviceMotionEvent.requestPermission();
      permission = res;
      if (res !== 'granted') {
        emit('shake:unavailable', { reason: `permission ${res}` });
        return false;
      }
    } catch (err) {
      // 用户在非手势上下文里触发了，或者直接拒绝
      permission = 'denied';
      emit('shake:unavailable', { reason: String(err?.message || err) });
      return false;
    }
  } else {
    permission = 'granted';
  }

  detector = createShakeDetector({
    ...opts,
    onEnergy: (level) => emit('shake:energy', { level }),
    onArm: () => emit('shake:arming', {}),
    onThrow: (power, level) => emit('shake:throw', { power, level, source: 'shake' }),
    onDisarm: () => emit('shake:disarm', {}),
  });

  listener = (e) => {
    // accelerationIncludingGravity 在 Android 和 iOS 上都稳定可用；
    // 不带重力的 acceleration 需要陀螺仪，很多设备给的是 null。
    // 反正逐轴差分会把重力常量消掉
    const a = e.accelerationIncludingGravity || e.acceleration;
    if (!a || a.x === null) return;
    detector.feed(a.x, a.y, a.z, e.timeStamp || performance.now());
  };

  window.addEventListener('devicemotion', listener);
  supported = true;
  return true;
}

export function disable() {
  if (listener) window.removeEventListener('devicemotion', listener);
  listener = null;
  detector = null;
  supported = false;
}

/** 点击/滑动投掷之后调，避免紧接着的晃动又触发一次 */
export function suppress(ms = 800) {
  detector?.suppress(ms, performance.now());
}

export function reset() {
  detector?.reset(performance.now());
}

/** 给 ?debug=1 用 */
export function getStats() {
  return {
    permission,
    supported,
    state: detector?.state ?? '-',
    energy: detector ? Number(detector.energy.toFixed(0)) : 0,
    level: detector ? Number(detector.level.toFixed(2)) : 0,
  };
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}
