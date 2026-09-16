/**
 * 投掷意图 → 冲量。
 *
 * 关键设计：power 永远归一化到 0..1。所有输入源（滑动速度、甩动能量、点击）
 * 都先转成 0..1 的"意图强度"，再由这里按当前重力换算成冲量。
 * 这样用户调重力只影响观感速度，不会把滑动手感带偏。
 */

import * as CANNON from 'cannon-es';
import { PHYSICS, SCENE } from '../config.js';

const _impulse = new CANNON.Vec3();
const _offset = new CANNON.Vec3();

/**
 * 把一颗骰子扔出去。
 *
 * @param {CANNON.Body} body
 * @param {object} opts
 * @param {number} opts.power  0..1 归一化力度
 * @param {number} [opts.dirX] 水平方向 X（会被归一化）
 * @param {number} [opts.dirZ] 水平方向 Z
 * @param {number} [opts.spin] 额外角速度倍率
 */
export function tossDie(body, { power = 0.5, dirX = 0, dirZ = 0, spin = 1 } = {}) {
  const p = Math.max(0, Math.min(1, power));

  // 力度 → 冲量大小
  const force = PHYSICS.impulseBase + p * PHYSICS.impulseRange;

  // 水平方向归一化。两者都是 0 时（甩动/键盘）给一个随机方向，
  // 否则骰子每次都原地上抛，看起来像跳而不是掷
  let hx = dirX;
  let hz = dirZ;
  const hlen = Math.hypot(hx, hz);
  if (hlen < 1e-4) {
    const a = Math.random() * Math.PI * 2;
    hx = Math.cos(a);
    hz = Math.sin(a);
  } else {
    hx /= hlen;
    hz /= hlen;
  }

  // 垂直分量给满，水平分量按 horizontalRatio 打折。
  // 打得太少骰子会一头撞在墙上然后斜靠着停下（见 config.js 的注释）
  const vy = force;
  const vh = force * PHYSICS.horizontalRatio;

  _impulse.set(-hx * vh, vy, -hz * vh);

  // ⚠️ 第二个参数是"施力点相对质心的偏移"，不是方向。
  //    它产生力矩 = r × F，这才是骰子会翻滚的原因。
  //    偏移量随机，否则每颗骰子转法一样，一眼看出是程序
  const ox = (Math.random() - 0.5) * 0.34 * spin;
  const oz = (Math.random() - 0.5) * 0.34 * spin;
  _offset.set(ox, 0, oz);

  body.wakeUp();
  body.applyImpulse(_impulse, _offset);

  // 再补一点纯角速度。只靠偏移量的话，力度小的时候几乎不转，
  // 骰子会"啪"一下平拍在地上，没有滚动过程
  const av = (2 + p * 10) * spin;
  body.angularVelocity.set(
    (Math.random() - 0.5) * av,
    (Math.random() - 0.5) * av,
    (Math.random() - 0.5) * av,
  );
}

/**
 * 把骰子摆到待投位置。每颗在托盘内散开一点，避免出生就重叠。
 *
 * @param {CANNON.Body} body
 * @param {number} slot  0..2，用来错开落点
 * @param {number} total 总颗数
 */
export function placeDie(body, slot, total) {
  const spread = PHYSICS.spawnSpread;
  // 沿一条弧线错开，而不是纯随机 —— 随机可能让两颗重叠
  const t = total <= 1 ? 0 : (slot / (total - 1) - 0.5) * 2;   // -1..1
  const angle = slot * 2.4;

  const x = t * spread + Math.cos(angle) * spread * 0.35;
  const z = t * spread * 0.6 + Math.sin(angle) * spread * 0.35;

  // 别贴着墙出生，否则一投就卡在墙角
  const lim = SCENE.trayHalf - 0.9;
  body.position.set(
    Math.max(-lim, Math.min(lim, x)),
    PHYSICS.spawnHeight + slot * PHYSICS.slotLift,
    Math.max(-lim, Math.min(lim, z)),
  );

  // 随机初始朝向。不随机的话，每局的起始姿态一样，
  // 投掷结果会出现肉眼可辨的规律
  body.quaternion.setFromEuler(
    Math.random() * Math.PI * 2,
    Math.random() * Math.PI * 2,
    Math.random() * Math.PI * 2,
  );

  body.velocity.set(0, 0, 0);
  body.angularVelocity.set(0, 0, 0);
  body.force.set(0, 0, 0);
  body.torque.set(0, 0, 0);
  body.wakeUp();
}

/** 把骰子从托盘里捞回来（越界救援用） */
export function resetDie(body, slot) {
  const lim = SCENE.trayHalf - 1.2;
  body.position.set(
    (Math.random() - 0.5) * lim,
    PHYSICS.spawnHeight * 0.5,
    (Math.random() - 0.5) * lim,
  );
  body.velocity.set(0, 0, 0);
  body.angularVelocity.set(0, 0, 0);
  body.wakeUp();
}
