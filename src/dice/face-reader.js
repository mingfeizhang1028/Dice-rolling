/**
 * quaternion → 朝上的点数。纯函数，不依赖场景，可以脱离浏览器单跑。
 *
 * ⚠️ 这里没有用计划里写的欧拉角法（toEuler(euler,'YZX') 后忽略 y）。
 *    那个方法要手工处理象限和 epsilon，落在棱上时还得"重新开 sleep 等它稳定"。
 *    改成把六个法向量各自旋转到世界空间，取 Y 分量最大的那个：
 *    · 同样简单，但没有分支、没有 epsilon、没有象限问题
 *    · 落定后骰子必然是平贴的，所以"最接近朝上"就是"朝上"
 *    · 顺带白送一个置信度：胜出法向量的 Y 分量本身
 *        1.000 = 完全平贴     0.707 = 卡在棱上     0.577 = 卡在角上
 *      这个值落定判定直接能用，欧拉角法拿不到
 */

import { Quaternion, Vector3, Matrix4 } from 'three';
import { FACES } from './geometry.js';

/**
 * 平贴时法向量 Y 分量应为 1；低于这个值就认为没真正躺平。
 *
 * 0.995 ≈ 5.7° 倾斜。不能取 0.999 —— cannon 的软接触会让骰子四角
 * 有约 0.04 单位的高差（softness 带来的，不是真的翘着），
 * 按 0.999 判会让 nearly-flat 的骰子反复触发"推一把"，白等两个来回。
 * 真正的斜靠（靠在墙上）倾角在 30° 以上，0.995 照样能抓到。
 */
export const FLAT_THRESHOLD = 0.995;

/** 卡在棱上（Y = cos45° = 0.7071）的判定线，留一点余量 */
export const EDGE_THRESHOLD = 0.70;

const _v = new Vector3();
const _inv = new Quaternion();
const _m = new Matrix4();

/**
 * 主实现：把每个面的法向量用骰子朝向旋转到世界空间，取 Y 最大者。
 *
 * @param {Quaternion|{x,y,z,w}} quaternion 骰子的世界朝向
 * @returns {{value:number, confidence:number, runnerUp:number}}
 *   value      朝上的点数
 *   confidence 胜出面法向量的 Y 分量（0.577..1）
 *   runnerUp   第二名的 Y 分量，和 confidence 一起能看出"赢得悬不悬"
 */
export function readFace(quaternion) {
  let bestValue = 0;
  let bestY = -Infinity;
  let secondY = -Infinity;

  for (const face of FACES) {
    _v.set(face.normal[0], face.normal[1], face.normal[2]).applyQuaternion(quaternion);
    const y = _v.y;

    if (y > bestY) {
      secondY = bestY;
      bestY = y;
      bestValue = face.value;
    } else if (y > secondY) {
      secondY = y;
    }
  }

  return { value: bestValue, confidence: bestY, runnerUp: secondY };
}

/**
 * 交叉验证实现：换个方向算同一件事。
 *
 * 主实现是"把面的法向量转到世界空间"；这里是"把世界的上方向转回骰子本地空间"，
 * 再找本地法向量离它最近的面。两条路径数学上等价，但代码路径完全不同 ——
 * 任何一侧的符号错误、四元数求逆搞反，都会让两者对不上。
 *
 * ?selftest=1 里每次投掷都拿它跟主实现对比。这是发现"读数是错的还是物理是错的"
 * 的唯一低成本手段。
 */
export function readFaceInverse(quaternion) {
  _inv.copy(quaternion).invert();
  // 世界 +Y 转回骰子本地空间：就是本地哪个方向此刻朝上
  _v.set(0, 1, 0).applyQuaternion(_inv);

  let bestValue = 0;
  let bestDot = -Infinity;
  for (const face of FACES) {
    const [x, y, z] = face.normal;
    const dot = _v.x * x + _v.y * y + _v.z * z;
    if (dot > bestDot) {
      bestDot = dot;
      bestValue = face.value;
    }
  }
  return { value: bestValue, confidence: bestDot };
}

/** 从 cannon 的 Body 读点 */
export function readBody(body) {
  return readFace(body.quaternion);
}

/**
 * 这颗骰子是不是真的平躺在地上。
 *
 * 不是平躺基本只有一种情况：斜靠在墙上。这种姿态在现实中是不稳定的
 * （桌面有震动就会倒），所以 settle.js 会轻推它一下让它重新落定 ——
 * 这是物理上正确的补救，不是为了让测试通过而打补丁。
 */
export function isFlat(body) {
  return readFace(body.quaternion).confidence > FLAT_THRESHOLD;
}

/**
 * 用旋转矩阵再算一遍。第三个独立路径，专门抓四元数分量换位、
 * 手性翻转这类问题 —— 很隐蔽，因为四元数看起来"差不多"。
 *
 * ⚠️ 必须先把四元数拷进 THREE.Quaternion，不能直接传 cannon 的。
 *    three 的 Vector3.applyQuaternion 读公开字段 q.x/y/z/w，
 *    但 Matrix4.compose 读的是**私有字段** quaternion._x/_y/_z/_w：
 *
 *      Matrix4.js:1026   const x = quaternion._x, y = quaternion._y, ...
 *      Vector3.js:476    const qx = q.x, qy = q.y, ...
 *
 *    cannon 的 Quaternion 只有公开字段，于是 _x/_y/_z/_w 全是 undefined，
 *    矩阵整个变成 NaN。而 NaN > -Infinity 是 false，所以循环一次都不进，
 *    函数会安静地返回初始值 —— 不报错，不抛异常，只是永远返回同一个数。
 *    这个 bug 是靠 ?selftest 的三路对比抓出来的。
 */
const _q = new Quaternion();

export function readFaceViaMatrix(quaternion) {
  _q.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w).normalize();
  _m.makeRotationFromQuaternion(_q);

  const e = _m.elements;

  // 兜底：万一以后 three 又改了字段约定，这里要立刻炸，而不是返回一个
  // 看似合理的数字。上面那个 bug 就是"不炸"才这么难发现
  if (Number.isNaN(e[5])) {
    throw new Error('readFaceViaMatrix: 旋转矩阵出现 NaN，四元数字段访问有问题');
  }

  let bestValue = 0;
  let bestY = -Infinity;
  for (const face of FACES) {
    const [x, y, z] = face.normal;
    // 矩阵乘向量，手写展开。elements 是列主序，
    // e[1]/e[5]/e[9] 正好是第二行
    const wy = e[1] * x + e[5] * y + e[9] * z;
    if (wy > bestY) {
      bestY = wy;
      bestValue = face.value;
    }
  }
  return { value: bestValue, confidence: bestY };
}

/** 一群骰子的点数，按 slot 顺序 */
export function readAll(dice) {
  return dice.map((d) => readBody(d.body).value);
}
