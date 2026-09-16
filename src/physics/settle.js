/**
 * 落定判定 + 看门狗 + 越界救援。
 *
 * 判定不只看 cannon 的 sleep 标志。骰子停在托盘上时，接触求解器会留下
 * 微小抖动，sleep 可能迟迟不触发；反过来，骰子在空中恰好瞬间速度为零时
 * sleep 也可能误触发。所以用"连续 N 帧速度和角速度都低于阈值"作为判据，
 * sleep 标志只作为加速通道（一旦 sleep 直接算停）。
 */

import { Vec3 } from 'cannon-es';
import { PHYSICS, SCENE } from '../config.js';
import { isSleeping } from './world.js';
import { resetDie } from './throw.js';
import { isFlat } from '../dice/face-reader.js';

/** 低于这个速度算"基本不动" */
const STILL_SPEED = 0.18;
/** 角速度阈值要比线速度宽松 —— 骰子原地慢速自转时肉眼已经觉得停了 */
const STILL_ANGULAR = 0.35;
/** 连续这么多帧都静止才算落定。60fps 下约 83ms */
const STILL_FRAMES = 5;

/**
 * 最多轻推几次让斜靠的骰子躺平。
 * 必须有上限 —— 否则一旦某颗骰子因为几何原因永远躺不平，
 * 就会卡在 THROWING 出不来，这是最糟的失败模式。
 */
const MAX_NUDGES = 3;

export function createSettleWatcher() {
  let dice = [];
  let startTime = 0;
  let stillFrames = 0;
  let active = false;
  let nudges = 0;
  let stage = 'idle';      // 'idle' | 'watching' | 'damping'

  return {
    begin(dieList, now = performance.now()) {
      dice = dieList;
      startTime = now;
      stillFrames = 0;
      nudges = 0;
      stage = 'watching';
      active = true;
    },

    get active() {
      return active;
    },

    /**
     * 每帧调用。
     * @returns {null | {forced:boolean, elapsedMs:number}} null = 还在动
     */
    update(now = performance.now()) {
      if (!active) return null;

      this.rescue();

      const elapsed = now - startTime;

      // 第二级：超过超时再等 forceStopAfterMs 还没停，就硬停。
      // 不硬停的话用户会卡在 THROWING 状态出不来，这是最糟的失败模式
      if (elapsed > PHYSICS.settleTimeoutMs) {
        for (const d of dice) {
          const b = d.body;
          b.velocity.scale(0.85, b.velocity);
          b.angularVelocity.scale(0.85, b.angularVelocity);
        }
        stage = 'damping';

        if (elapsed > PHYSICS.settleTimeoutMs + PHYSICS.forceStopAfterMs) {
          for (const d of dice) {
            d.body.velocity.setZero();
            d.body.angularVelocity.setZero();
            d.body.sleep();
          }
          active = false;
          stage = 'idle';
          return { forced: true, elapsedMs: elapsed };
        }
        return null;
      }

      if (this.isAllStill()) {
        stillFrames++;
        if (stillFrames >= STILL_FRAMES) {
          // 停是停了，但可能没躺平（斜靠在墙上）。推一把让它重新落定 ——
          // 现实中这种姿态本来就会被任何一点震动推翻，所以这是正确的补救
          const tilted = dice.filter((d) => !isFlat(d.body));
          if (tilted.length && nudges < MAX_NUDGES) {
            nudges++;
            for (const d of tilted) nudge(d.body);
            stillFrames = 0;
            return null;
          }

          active = false;
          stage = 'idle';
          // 落定时把还没 sleep 的刚体强制 sleep，省掉之后的空转
          for (const d of dice) d.body.sleep();
          return { forced: false, elapsedMs: elapsed, nudges };
        }
      } else {
        stillFrames = 0;
      }

      return null;
    },

    isAllStill() {
      for (const d of dice) {
        const b = d.body;
        if (isSleeping(b)) continue;
        if (b.velocity.length() > STILL_SPEED) return false;
        if (b.angularVelocity.length() > STILL_ANGULAR) return false;
      }
      return true;
    },

    /** 把跑出托盘或者掉到地板下面的骰子捞回来 */
    rescue() {
      const lim = SCENE.trayHalf + 3;
      for (let i = 0; i < dice.length; i++) {
        const b = dice[i].body;
        if (
          b.position.y < -2 ||
          Math.abs(b.position.x) > lim ||
          Math.abs(b.position.z) > lim
        ) {
          console.warn('[settle] 骰子跑出托盘，已捞回', i);
          resetDie(b, i);
        }
      }
    },

    abort() {
      active = false;
      stage = 'idle';
    },

    get stage() {
      return stage;
    },
  };
}

// 复用的向量。applyImpulse 必须是真的 CANNON.Vec3 ——
// 传字面量对象会在 r.cross() 上炸，而且只在极少数姿态下才触发
const _imp = new Vec3();
const _rel = new Vec3();

/**
 * 轻推一颗斜靠着的骰子。
 *
 * ⚠️ 方向必须朝托盘中心，不能随机。
 *    斜靠的骰子必然是靠在某面墙上的，随机推的话它会原地转一圈、
 *    又靠回同一面墙上 —— 实测这么做等于没推。
 *    "向心"就是"离开支撑物"的方向，推出去之后它会落在空地上自己倒平。
 *
 * 力度要够把它带离墙脚，但不能像投掷那么大。
 */
function nudge(body) {
  const strength = 1.8;
  body.wakeUp();

  const { x, z } = body.position;
  const dist = Math.hypot(x, z) || 1;

  _imp.set(
    (-x / dist) * strength + (Math.random() - 0.5) * 0.4,
    0.15,
    (-z / dist) * strength + (Math.random() - 0.5) * 0.4,
  );
  _rel.set(
    (Math.random() - 0.5) * 0.3,
    0,
    (Math.random() - 0.5) * 0.3,
  );

  body.applyImpulse(_imp, _rel);
  body.angularVelocity.set(
    (Math.random() - 0.5) * 3,
    (Math.random() - 0.5) * 3,
    (Math.random() - 0.5) * 3,
  );
}

/**
 * 供 selftest 用：跑一个独立世界直到静止，含"斜靠就推一把"的完整逻辑。
 * 直接复用生产代码的判定，避免测试和线上行为不一致。
 */
export function settleWorld(world, dice, { maxSteps = 900, dt = 1 / 60 } = {}) {
  const watcher = createSettleWatcher();
  watcher.begin(dice);

  let steps = 0;
  let forced = false;

  while (steps < maxSteps) {
    world.step(dt, dt, 3);
    steps++;
    const r = watcher.update(steps * dt * 1000);
    if (r) {
      forced = r.forced;
      break;
    }
  }

  if (steps >= maxSteps) forced = true;
  return { steps, forced };
}
