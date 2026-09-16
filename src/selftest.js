/**
 * 自测：跑 N 次投掷，验证读点、朝向、静止姿态、点数分布。
 *
 * ⚠️ 这个文件不碰 DOM，也不碰 three 的 renderer —— 所以它既能在浏览器里
 *    用 ?selftest=1 跑，也能在 Node 里用 tools/selftest.mjs 跑。
 *    在 Node 里跑的意义很大：几何和读点的问题不需要等到开浏览器才发现。
 *
 * 它测的是"物理说朝上的是哪一面，和几何算出来的那一面是否一致"。
 * 它测不了"屏幕上看起来是不是那一面"—— 那是贴图和朝向的问题，只能靠眼睛。
 * 但绝大多数 bug 都出在前者。
 */

import { buildWorld } from './physics/world.js';
import { settleWorld } from './physics/settle.js';
import { placeDie, tossDie } from './physics/throw.js';
import { createDie } from './dice/die.js';
import {
  readFace, readFaceInverse, readFaceViaMatrix, EDGE_THRESHOLD,
} from './dice/face-reader.js';
import { validateFaceTable } from './dice/geometry.js';
import { PHYSICS } from './config.js';

const CORNER = PHYSICS.dieHalf;

/** 骰子的 8 个角，局部坐标 */
const CORNERS = [];
for (const x of [-CORNER, CORNER]) {
  for (const y of [-CORNER, CORNER]) {
    for (const z of [-CORNER, CORNER]) CORNERS.push([x, y, z]);
  }
}

/**
 * 0.09 ≈ 立方体倾斜 5°。与 face-reader 的 FLAT_THRESHOLD（0.995）对齐。
 *
 * 不能取 0.03 —— cannon 的软接触让平躺的骰子四角有约 0.04 的高差，
 * 按 0.03 判会把明明是平的骰子报成"卡在棱上"。实测 0.03 时
 * 3.6% 的投掷误报，其中绝大多数 cornerSpan 只有 1.037（立方体棱长是 1.0）。
 * 真正斜靠的 cornerSpan 在 1.4 上下，两者相差一个量级，很好区分。
 */
const CORNER_TOLERANCE = 0.09;

/** 把骰子的一个局部角点转到世界坐标。手写展开，不依赖 three */
function worldCornerY(body, c) {
  const [cx, cy, cz] = c;
  const { x, y, z, w } = body.quaternion;

  const ix = w * cx + y * cz - z * cy;
  const iy = w * cy + z * cx - x * cz;
  const iz = w * cz + x * cy - y * cx;
  const iw = -x * cx - y * cy - z * cz;

  const wy = iy * w + iw * -y + iz * -x - ix * -z;
  return body.position.y + wy;
}

/**
 * 最低的那个平面上有几个角。
 *
 * 平躺的骰子，无论躺在什么上面（地板、还是另一颗骰子），
 * 都恰好有 4 个角共面于最低点。所以这个判据是普适的 ——
 * 早先写"4 个角贴地板"在多颗时会误报，因为叠在上面的骰子
 * 最低点不在 y=0。
 *
 * 卡在棱上时只有 2 个角共面，卡在角上时只有 1 个。
 * 这是**独立于面朝向表**的几何检查：单纯比较三种读法（都读同一张表）
 * 抓不出"读数是按表算的，但物理姿态不对"这类问题。
 */
function bottomCornerCount(body) {
  let minY = Infinity;
  const ys = [];

  for (const c of CORNERS) {
    const y = worldCornerY(body, c);
    ys.push(y);
    if (y < minY) minY = y;
  }

  let count = 0;
  for (const y of ys) if (y - minY < CORNER_TOLERANCE) count++;
  return count;
}


/**
 * @param {object} [opts]
 * @param {number} [opts.throws=200]
 * @param {number} [opts.diceCount=1]
 * @param {string} [opts.materialId='jade']
 * @param {boolean} [opts.log] 传 false 静默
 * @returns {{ok:boolean, failures:Array, stats:object}}
 */
export function runSelfTest({
  throws = 200,
  diceCount = 1,
  materialId = 'jade',
  log = console.log,
  maxSteps = 900,
} = {}) {
  const say = log || (() => {});
  const t0 = Date.now();

  say('\n── 骰子自测 ──────────────────────────────');

  // 1. 面朝向表本身合不合法
  try {
    validateFaceTable();
    say('✓ 面朝向表合法（对面和为 7，手性为 +1）');
  } catch (err) {
    say(`✗ 面朝向表非法：${err.message}`);
    return { ok: false, failures: [{ kind: 'face-table', message: err.message }], stats: {} };
  }

  // 2. 另开一个世界，不干扰正在跑的场景
  const world = buildWorld();
  const dice = [];
  for (let i = 0; i < diceCount; i++) {
    dice.push(createDie({ materialId, slot: i, world, name: `测试${i + 1}` }));
  }

  const failures = [];
  const histogram = new Map();
  const dt = 1 / 60;
  let maxStepsUsed = 0;
  let forcedStops = 0;

  for (let t = 0; t < throws; t++) {
    for (let i = 0; i < dice.length; i++) placeDie(dice[i].body, i, dice.length);
    for (let i = 0; i < dice.length; i++) {
      tossDie(dice[i].body, {
        power: 0.15 + Math.random() * 0.85,
        dirX: Math.random() * 2 - 1,
        dirZ: Math.random() * 2 - 1,
      });
    }

    // 复用生产代码的落定判定（含"斜靠就推一把"）。
    // 自己写一套的话，测试通过不代表线上会有同样的行为
    const settled = settleWorld(world, dice, { maxSteps, dt });
    if (settled.forced) forcedStops++;
    if (settled.steps > maxStepsUsed) maxStepsUsed = settled.steps;

    // 再走几步让它彻底停稳，避免在"刚好睡着"的那一帧读数
    for (let k = 0; k < 8; k++) world.step(dt, dt, 3);

    for (let i = 0; i < dice.length; i++) {
      const body = dice[i].body;

      // 三种独立读法必须一致
      const a = readFace(body.quaternion);
      const b = readFaceInverse(body.quaternion);
      const c = readFaceViaMatrix(body.quaternion);

      if (a.value !== b.value || a.value !== c.value) {
        failures.push({
          kind: 'reader-mismatch', throw: t, die: i,
          forward: a.value, inverse: b.value, matrix: c.value,
        });
      }

      // 必须真的平贴，不能卡在棱或角上
      if (a.confidence < EDGE_THRESHOLD) {
        failures.push({
          kind: 'not-flat', throw: t, die: i,
          confidence: Number(a.confidence.toFixed(4)),
        });
      }

      // 几何检查：平躺就必须有 4 个角共面于最低点。
      // 对叠在别的骰子上的那几颗同样成立
      const bottom = bottomCornerCount(body);
      if (bottom !== 4) {
        failures.push({ kind: 'corners', throw: t, die: i, bottom });
      }

      // 单颗时才能查高度（多颗会叠起来）
      if (diceCount === 1) {
        const y = body.position.y;
        if (y < 0.35 || y > 0.7) {
          failures.push({ kind: 'rest-height', throw: t, die: i, y: Number(y.toFixed(3)) });
        }
      }

      histogram.set(a.value, (histogram.get(a.value) || 0) + 1);
    }
  }

  // 3. 分布检查。只报警不判失败 —— 200 次的抽样波动本来就大，
  //    把它当硬失败会让人误以为代码有问题
  const total = throws * diceCount;
  const expected = total / 6;
  const distWarnings = [];
  for (let face = 1; face <= 6; face++) {
    const got = histogram.get(face) || 0;
    // 6 面 × 期望 33 次，[15,55] 大约对应 ±3σ
    if (got < expected * 0.45 || got > expected * 1.75) {
      distWarnings.push({ face, got, expected: Math.round(expected) });
    }
  }

  const ms = Date.now() - t0;
  const ok = failures.length === 0;

  say('');
  say(`投掷 ${throws} 次 × ${diceCount} 颗 = ${total} 个样本，耗时 ${ms}ms`);
  say(`单次最长物理步进 ${maxStepsUsed} 步（上限 ${maxSteps}）`);
  if (forcedStops) say(`⚠ ${forcedStops} 次触顶未自然静止`);

  say('');
  say('点数分布：');
  for (let face = 1; face <= 6; face++) {
    const got = histogram.get(face) || 0;
    const pct = ((got / total) * 100).toFixed(1);
    const bar = '█'.repeat(Math.round((got / total) * 120));
    say(`  ${face}  ${String(got).padStart(4)}  ${pct.padStart(5)}%  ${bar}`);
  }
  if (distWarnings.length) {
    say(`  ⚠ 偏离较大：${distWarnings.map((w) => `${w.face}点${w.got}次(期望${w.expected})`).join('、')}`);
  }

  say('');
  if (ok) {
    say('✓ 全部通过');
  } else {
    say(`✗ ${failures.length} 项失败，前 10 条：`);
    for (const f of failures.slice(0, 10)) say(`   ${JSON.stringify(f)}`);
    const byKind = {};
    for (const f of failures) byKind[f.kind] = (byKind[f.kind] || 0) + 1;
    say(`   分类：${JSON.stringify(byKind)}`);
  }
  say('─────────────────────────────────────────\n');

  return {
    ok,
    failures,
    stats: {
      throws, diceCount, total, ms, maxStepsUsed, forcedStops,
      histogram: Object.fromEntries(histogram),
      distributionWarnings: distWarnings,
    },
  };
}
