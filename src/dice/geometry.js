/**
 * 骰子几何：圆角方块本体 + 点数。
 *
 * ⚠️ 为什么点数不做成贴图。
 *    RoundedBoxGeometry 虽然继承自 BoxGeometry，但**不调用 addGroup**，
 *    几何体里没有 6 个材质分组，无法给六个面分别贴图。实测确认：
 *    grep addGroup node_modules/three/examples/jsm/geometries/RoundedBoxGeometry.js → 无结果。
 *
 *    改把点数做成真实几何（21 个小圆片 merge 成一个 geometry）。这样：
 *    · 不碰 UV、不碰贴图，绕开整个问题
 *    · 点数有真实的凸起/厚度，四种材质靠 raise/depth/color 三个参数就能
 *      表现出"镶嵌 / 雕刻 / 涂装 / 烧烙"的区别
 *    · 每颗骰子只有 2 个 draw call（本体 + 点数），且两个几何体全局共享
 *
 * ⚠️ 面朝向（与计划文档的表格有一处偏离，见下）
 *    #1 → +Y    #6 → -Y
 *    #3 → +X    #4 → -X
 *    #2 → +Z    #5 → -Z
 *
 *    计划里写的是 #2 → +X、#3 → +Z。按那个排法，三个法向量的三重积
 *    n₁·(n₂×n₃) = -1，得到的是**镜像骰子**（中式排列）。国际通用标准是
 *    "1 朝上、2 朝自己时，3 在自己右手边"，即 2 → +Z、3 → +X，三重积 +1。
 *    两种排列肉眼都像正常骰子，这里选了认得的人多的那个。
 *    —— 想换成中式镜像，把下面 FACES 里 2 和 3 的位置对调即可。
 */

import { CylinderGeometry, Vector3, Quaternion, Matrix4 } from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PHYSICS } from '../config.js';
import { getMaterial } from '../materials.js';

const HALF = PHYSICS.dieHalf;          // 0.5。cannon 用半边长，three 用全长
const FULL = HALF * 2;

/** 圆角半径。太大骰子会变成球，太小棱角还在。0.11 是肉眼最像"骰子"的值 */
const CORNER_RADIUS = 0.11;
/** 圆角分段。3 段在手机上已经看不出棱面，4 段是浪费顶点 */
const CORNER_SEGMENTS = 3;

/**
 * 点数在面内的位置，单位是"面半宽的比例"。
 * 所有点阵都是 180° 旋转对称的 —— 所以面内的朝向随便定都不影响正确性，
 * 骰子的手性完全由"哪个面放哪个数"决定。
 */
const PIP_LAYOUT = {
  1: [[0, 0]],
  2: [[-1, -1], [1, 1]],
  3: [[-1, -1], [0, 0], [1, 1]],
  4: [[-1, -1], [-1, 1], [1, -1], [1, 1]],
  5: [[-1, -1], [-1, 1], [0, 0], [1, -1], [1, 1]],
  6: [[-1, -1], [-1, 0], [-1, 1], [1, -1], [1, 0], [1, 1]],
};

/** 点阵离面中心的最大偏移，占面半宽的比例。0.56 让 6 点的两列靠近边缘 */
const PIP_SPACING = 0.56;

/**
 * 六个面的朝向。顺序 = 骰子点数，值 = 面法线（单位向量）。
 * 对面之和恒为 7：1/6、2/5、3/4。这是骰子的定义，不是可调参数。
 */
export const FACES = [
  { value: 1, normal: [0, 1, 0] },
  { value: 2, normal: [0, 0, 1] },
  { value: 3, normal: [1, 0, 0] },
  { value: 4, normal: [-1, 0, 0] },
  { value: 5, normal: [0, 0, -1] },
  { value: 6, normal: [0, -1, 0] },
];

// ── 本体 ────────────────────────────────────────────────────────────

let bodyGeometry = null;

/**
 * 圆角方块本体。全局共享一份 —— 所有骰子、所有材质长得一样，
 * 只有材质（颜色）不同，所以几何体没必要每颗一份。
 */
export function getBodyGeometry() {
  if (!bodyGeometry) {
    bodyGeometry = new RoundedBoxGeometry(
      FULL, FULL, FULL, CORNER_SEGMENTS, CORNER_RADIUS,
    );
    bodyGeometry.computeVertexNormals();
  }
  return bodyGeometry;
}

// ── 点数 ────────────────────────────────────────────────────────────

/**
 * 给定面法线，造一组正交基。因为点阵都是 180° 对称的，
 * 这组基具体怎么转都无所谓，只要 (right, up, normal) 是右手系。
 */
function basisFor(n) {
  const normal = new Vector3(...n);
  // 法线接近 ±Y 时换一个参考轴，避免叉积退化成零向量
  const ref = Math.abs(normal.y) > 0.9 ? new Vector3(0, 0, 1) : new Vector3(0, 1, 0);
  const right = new Vector3().crossVectors(ref, normal).normalize();
  const up = new Vector3().crossVectors(normal, right).normalize();
  return { right, up, normal };
}

const pipGeometryCache = new Map();

/**
 * 某个材质的点数几何体：21 个圆片（1+2+3+4+5+6）merge 成一个。
 *
 * 圆片做成轻微锥形（顶面比底面小 14%），这样侧面能吃到光，
 * 看起来是个有厚度的"点"，而不是一块贴在面上的贴纸。
 *
 * 摆放：圆片轴向沿面法线，外表面落在 half + raise 处。
 * 不做真正的"凹陷"——本体是不透明的，凹进去的圆片完全看不见。
 * 所以 engraving 是靠"几乎不凸起 + 深色 + 扁"来表现的。
 */
export function getPipGeometry(materialId) {
  const cached = pipGeometryCache.get(materialId);
  if (cached) return cached;

  const { pip } = getMaterial(materialId);
  const { radius, raise, depth, color } = pip;

  // 单个圆片。radialSegments 14 在骰子尺度上已经看不出多边形
  const unit = new CylinderGeometry(radius * 0.86, radius, depth, 14, 1);

  const pieces = [];
  const q = new Quaternion();
  const m = new Matrix4();
  const scale = new Vector3(1, 1, 1);
  const upAxis = new Vector3(0, 1, 0);

  for (const face of FACES) {
    const { right, up, normal } = basisFor(face.normal);
    // 圆心：外表面在 half + raise，所以中心往里退半个 depth
    const centerDist = HALF + raise - depth / 2;

    for (const [u, v] of PIP_LAYOUT[face.value]) {
      const pos = new Vector3()
        .copy(normal).multiplyScalar(centerDist)
        .addScaledVector(right, u * HALF * PIP_SPACING)
        .addScaledVector(up, v * HALF * PIP_SPACING);

      // 圆片的局部 Y 轴转到面法线方向
      q.setFromUnitVectors(upAxis, normal);
      m.compose(pos, q, scale);

      const piece = unit.clone();
      piece.applyMatrix4(m);
      pieces.push(piece);
    }
  }

  const merged = mergeGeometries(pieces, false);
  merged.computeVertexNormals();

  // 合并后原片就没用了，立刻释放。4 份材质 × 21 片，不释放会留下 84 个孤儿几何体
  for (const p of pieces) p.dispose();
  unit.dispose();

  pipGeometryCache.set(materialId, merged);
  return merged;
}

/** 点数几何体上不属于任何面的属性：颜色由材质提供，这里只记一笔 */
export function pipColorOf(materialId) {
  return getMaterial(materialId).pip.color;
}

// ── 一致性自检 ──────────────────────────────────────────────────────

/**
 * 断言 FACES 表确实构成一个合法的骰子。启动时跑一次，几微秒。
 * 如果哪天有人手滑改了 FACES，这里会立刻炸，而不是等到投掷时读到错点数。
 */
export function validateFaceTable() {
  if (FACES.length !== 6) throw new Error('FACES 必须是 6 个面');

  const seen = new Set();
  for (const f of FACES) {
    if (seen.has(f.value)) throw new Error(`面 ${f.value} 重复`);
    seen.add(f.value);

    const len = Math.hypot(...f.normal);
    if (Math.abs(len - 1) > 1e-6) {
      throw new Error(`面 ${f.value} 的法线不是单位向量：${f.normal}`);
    }
  }

  // 对面之和必须是 7
  for (const f of FACES) {
    const opp = FACES.find(
      (g) => g.normal[0] === -f.normal[0] &&
             g.normal[1] === -f.normal[1] &&
             g.normal[2] === -f.normal[2],
    );
    if (!opp) throw new Error(`面 ${f.value} 没有对面`);
    if (f.value + opp.value !== 7) {
      throw new Error(`面 ${f.value} 的对面是 ${opp.value}，和不是 7`);
    }
  }

  // 手性：1/2/3 三重积为 +1 = 国际标准（1 朝上、2 朝自己时 3 在右手边）
  const n1 = FACES.find((f) => f.value === 1).normal;
  const n2 = FACES.find((f) => f.value === 2).normal;
  const n3 = FACES.find((f) => f.value === 3).normal;
  const cross23 = [
    n2[1] * n3[2] - n2[2] * n3[1],
    n2[2] * n3[0] - n2[0] * n3[2],
    n2[0] * n3[1] - n2[1] * n3[0],
  ];
  const triple = n1[0] * cross23[0] + n1[1] * cross23[1] + n1[2] * cross23[2];
  if (Math.round(triple) !== 1) {
    throw new Error(
      `骰子手性错误：n₁·(n₂×n₃) = ${triple.toFixed(3)}，应为 +1（国际标准）`,
    );
  }

  return true;
}

/** 供 P3 主题切换时清理。4 份几何体加本体，总共 5 个 */
export function disposeGeometry() {
  for (const g of pipGeometryCache.values()) g.dispose();
  pipGeometryCache.clear();
  bodyGeometry?.dispose();
  bodyGeometry = null;
}
