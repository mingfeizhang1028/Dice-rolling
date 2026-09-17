/**
 * cannon-es 世界、托盘、以及四种材质两两之间的 ContactMaterial。
 */

import * as CANNON from 'cannon-es';
import { PHYSICS, SCENE } from '../config.js';
import { emit } from '../core/bus.js';
import { MATERIAL_IDS, getMaterial, blendContact } from '../materials.js';

let world = null;
const cannonMaterials = new Map();   // materialId → CANNON.Material

/** 骰子落地的那个面。托盘用的材质，跟四种骰子材质都不同 */
export const TRAY_MATERIAL = new CANNON.Material('tray');

/**
 * 挡墙单独一套材质，**故意和地板不同**。这是让骰子不斜靠在墙上的关键。
 *
 * 骰子能斜靠在竖直墙上并在那儿停住，靠的是两件事：
 *   ① 墙面的摩擦力撑住了它；
 *   ② 撞墙时它把动能交给了墙，就地停下 —— 停在哪就躺在哪。
 * 所以针对性地两条都反着来：
 *   ① 摩擦 0.05 —— 斜靠的骰子没有支撑，自己滑下来躺平；
 *   ② 弹性 0.55 —— 撞墙的骰子弹回场内，在空地上落定，而不是死在墙脚。
 *
 * ⚠️ 试过把墙做成向内倾斜 17° 的"漏斗"，**结果明显更差**：
 *    斜面成了坡道，骰子爬上去停在坡上（半径 2.3~3.2、离地 0.76），
 *    棱/角着地的比例从 5% 涨到 26%。斜坡要起作用得陡到 45° 以上，
 *    那托盘就变成碗了，骰子反而没地方平躺。竖直墙 + 打滑是正确的解法。
 */
export const WALL_MATERIAL = new CANNON.Material('wall');

/**
 * 墙面的摩擦与弹性。调这两个数会直接改变"骰子停在哪儿"。
 *
 * ⚠️ 这两个数是配套的，别单独动：
 *    弹性决定"骰子撞墙后会不会往上弹"，所以它受 wallHeight 约束。
 *    0.30 时倾斜率回升到 5%，0.55 时降到 1.8% —— 弹性在起作用。
 *    而 0.55 之所以现在安全，是因为 wallHeight 从 2.0 抬到了 3.0；
 *    早先矮墙配 0.55 会把骰子弹到半径 5.9 的地方去。
 */
const WALL_FRICTION = 0.05;
const WALL_RESTITUTION = 0.55;

/**
 * 建一个独立的世界，不碰模块单例。
 * ?selftest=1 用它另开一个世界跑 200 次投掷，不干扰正在跑的场景。
 */
export function buildWorld() {
  const w = new CANNON.World({
    gravity: new CANNON.Vec3(0, PHYSICS.gravity, 0),
  });

  w.allowSleep = true;
  w.solver.iterations = 12;             // 默认 10；骰子堆叠时 12 明显更稳
  w.solver.tolerance = 0.002;
  w.defaultContactMaterial.friction = 0.3;

  registerContacts(w);
  buildTray(w);
  return w;
}

export function createWorld() {
  world = buildWorld();
  return world;
}

export function getWorld() {
  return world;
}

/**
 * 四种骰子材质，以及它们两两之间的 ContactMaterial（含自己和自己的组合）。
 *
 * 混搭骰子互撞时如果不注册，会掉到 defaultContactMaterial，手感会失真 ——
 * 而且失真得很隐蔽，因为单看每一颗的物理参数都是对的。
 */
function registerContacts(w) {
  for (const id of MATERIAL_IDS) {
    cannonMaterials.set(id, new CANNON.Material(id));
  }

  for (let i = 0; i < MATERIAL_IDS.length; i++) {
    for (let j = i; j < MATERIAL_IDS.length; j++) {
      const a = MATERIAL_IDS[i];
      const b = MATERIAL_IDS[j];
      const blend = blendContact(a, b);

      w.addContactMaterial(new CANNON.ContactMaterial(
        cannonMaterials.get(a),
        cannonMaterials.get(b),
        {
          friction: blend.friction,
          restitution: blend.restitution,
          contactEquationStiffness: blend.contact.stiffness,
          contactEquationRelaxation: blend.contact.relaxation,
        },
      ));
    }
  }

  // 骰子对托盘也要注册，否则骰子撞地走默认摩擦/弹性
  for (const id of MATERIAL_IDS) {
    const p = getMaterial(id).physics;
    const contact = {
      contactEquationStiffness: p.contact.stiffness,
      contactEquationRelaxation: p.contact.relaxation,
    };
    w.addContactMaterial(new CANNON.ContactMaterial(
      cannonMaterials.get(id), TRAY_MATERIAL,
      { friction: p.friction, restitution: p.restitution, ...contact },
    ));

    // 对挡墙：打滑 + 回弹。理由见 WALL_MATERIAL 的注释
    w.addContactMaterial(new CANNON.ContactMaterial(
      cannonMaterials.get(id), WALL_MATERIAL,
      { friction: WALL_FRICTION, restitution: WALL_RESTITUTION, ...contact },
    ));
  }
}

function buildTray(w) {
  const half = SCENE.trayHalf;
  const wallH = SCENE.wallHeight;

  // 地板。无限大平面，骰子不可能从下面漏出去
  const floor = new CANNON.Body({
    mass: 0,
    shape: new CANNON.Plane(),
    material: TRAY_MATERIAL,
  });
  floor.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  w.addBody(floor);

  // 四面**竖直**挡墙。厚度给足，且互相重叠，避免骰子从接缝挤出去。
  // 用 WALL_MATERIAL 而不是 TRAY_MATERIAL —— 打滑回弹的那一套，
  // 专门用来防止骰子斜靠在墙上（见 WALL_MATERIAL 的注释）
  const t = 0.6;
  const walls = [
    { pos: [half + t, wallH / 2, 0], half: [t, wallH / 2, half + t * 2] },
    { pos: [-half - t, wallH / 2, 0], half: [t, wallH / 2, half + t * 2] },
    { pos: [0, wallH / 2, half + t], half: [half + t * 2, wallH / 2, t] },
    { pos: [0, wallH / 2, -half - t], half: [half + t * 2, wallH / 2, t] },
  ];

  for (const def of walls) {
    const b = new CANNON.Body({
      mass: 0,
      shape: new CANNON.Box(new CANNON.Vec3(def.half[0], def.half[1], def.half[2])),
      material: WALL_MATERIAL,
    });
    b.position.set(def.pos[0], def.pos[1], def.pos[2]);
    w.addBody(b);
  }
}

/**
 * 造一颗骰子的刚体。
 *
 * ⚠️ mass 恒为 PHYSICS.dieMass（1），不随材质变。
 *    金属密度是木头的 13 倍，照实做的话金属骰子根本甩不动 ——
 *    用户只会觉得"卡"，不会觉得"金属真沉"。
 *    重量感应该靠角阻尼和声音表达，不靠质量。
 */
export function createDieBody(materialId, slot = 0) {
  const p = getMaterial(materialId).physics;
  const h = PHYSICS.dieHalf;

  const body = new CANNON.Body({
    mass: PHYSICS.dieMass,
    shape: new CANNON.Box(new CANNON.Vec3(h, h, h)),
    material: cannonMaterials.get(materialId),
    allowSleep: true,
    sleepSpeedLimit: PHYSICS.sleepSpeedLimit,
    sleepTimeLimit: PHYSICS.sleepTimeLimit,
    linearDamping: p.linearDamping,
    angularDamping: p.angularDamping,
  });

  body.angularVelocity.set(0, 0, 0);
  body.slot = slot;
  attachImpactReporter(body, materialId);
  return body;
}

/**
 * 碰撞 → 'impact' 事件。物理层只报告"撞了、多快、在哪"，
 * 不知道有没有声音、要不要震 —— 那些是订阅方的事。
 *
 * ⚠️ 用 WeakMap 存去抖时间戳，不挂到 body 上。
 *    body 是 cannon 的对象，我们往里塞自定义属性（slot 除外，
 *    那个是身份）会让后面读代码的人分不清哪些字段是 cannon 的。
 */
const lastImpactAt = new WeakMap();

function attachImpactReporter(body, materialId) {
  body.addEventListener('collide', (e) => {
    const speed = Math.abs(e.contact.getImpactVelocityAlongNormal());
    if (speed < PHYSICS.impactMinSpeed) return;

    // 去抖。一次真实撞击会在连续几个物理步里持续接触，
    // 不去抖就是同一个撞击响三四声，听起来像"咔咔咔"
    const now = performance.now();
    const last = lastImpactAt.get(body) || 0;
    if (now - last < PHYSICS.impactDebounceMs) return;
    lastImpactAt.set(body, now);

    emit('impact', {
      slot: body.slot,
      materialId,
      speed,
      // 位置用来做声场定位：骰子在托盘左边就在左边响。
      // 归一化到 -1..1，消费方不用再知道托盘多大
      pan: Math.max(-1, Math.min(1, body.position.x / SCENE.trayHalf)),
    });
  });
}

export function stepWorld(dt) {
  if (world) world.step(1 / 60, dt, 3);
}

/** 换材质时重建该骰子的物理属性。质量不变，只换阻尼和接触材质 */
export function retuneBody(body, materialId) {
  const p = getMaterial(materialId).physics;
  body.material = cannonMaterials.get(materialId);
  body.linearDamping = p.linearDamping;
  body.angularDamping = p.angularDamping;
  body.updateMassProperties();
}

export function isSleeping(body) {
  return body.sleepState === CANNON.Body.SLEEPING;
}
