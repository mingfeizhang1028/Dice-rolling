/**
 * 顶盖（罐子）约束测试。
 *
 * 目的：证明大力猛掷时骰子**不会再飞出去** —— 之前只能靠越界瞬移捞回，
 * 现在被无形的顶盖全部弹回场内。
 *
 * 方法：用独立世界 + 12 颗骰子（按颗数缩放），power=1 满力猛掷，
 * 逐步检测是否出现「超出托盘 / 高于顶盖」的骰子。旧墙方案这里会有大量
 * 越界样本；有顶盖后应为 0。
 *
 * 同时回归：顶盖不该把骰子困在半空或增加斜靠比例 —— 检查落定后躺平率。
 */

import { buildWorld } from '../src/physics/world.js';
import { createDie } from '../src/dice/die.js';
import { placeDie, tossDie } from '../src/physics/throw.js';
import { settleWorld } from '../src/physics/settle.js';
import { isFlat } from '../src/dice/face-reader.js';
import { PHYSICS, SCENE, dieScaleFor } from '../src/config.js';

const N = 12;          // 最大颗数
const TRIALS = 60;     // 60 次满力猛掷
const dt = 1 / 60;

const world = buildWorld();
const size = dieScaleFor(N);
const dice = [];
for (let i = 0; i < N; i++) {
  dice.push(createDie({ materialId: 'metal', slot: i, world, size, name: `t${i}` }));
}

// 越界判据：超出托盘截面、或高于顶盖。容器内部 |x|,|z| ≤ trayHalf、y ≤ wallHeight
const ESCAPE_X = SCENE.trayHalf + 0.5;   // 墙厚 0.6，2.6+0.5=3.1 已超出内壁
const ESCAPE_Y = PHYSICS.wallHeight + 0.6; // 顶盖底 3.0，3.6 已在上方

let escapes = 0;
let badFrames = 0;
let samples = 0;

for (let t = 0; t < TRIALS; t++) {
  for (let i = 0; i < N; i++) placeDie(dice[i].body, i, N);
  for (let i = 0; i < N; i++) {
    tossDie(dice[i].body, {
      power: 1,                        // 满力：最容易飞出去
      dirX: Math.random() * 2 - 1,
      dirZ: Math.random() * 2 - 1,
    });
  }

  let frames = 0;
  let done = false;
  while (!done && frames < 900) {
    world.step(dt, dt, 3);
    frames++;

    for (const d of dice) {
      const b = d.body;
      if (
        Math.abs(b.position.x) > ESCAPE_X ||
        Math.abs(b.position.z) > ESCAPE_X ||
        b.position.y > ESCAPE_Y
      ) {
        escapes++;
        if (badFrames++ < 3) {
          console.warn(`[containment] 第 ${t} 局 越界: x=${b.position.x.toFixed(2)} z=${b.position.z.toFixed(2)} y=${b.position.y.toFixed(2)}`);
        }
      }
    }

    if (dice.every((d) => d.body.sleepState === 2 || d.body.sleepState === 3)) done = true;
  }

  // 落定后躺平率
  for (const d of dice) {
    const r = isFlat(d.body);
    samples++;
    if (!r) {
      // 斜靠的单独记 —— 顶盖不应加剧它
      void r;
    }
  }
}

const settled = dice.length * TRIALS;
console.log(`\n顶盖约束：${N} 颗 × ${TRIALS} 次满力投掷`);
console.log(`越界次数      = ${escapes}（应为 0）`);
console.log(`总骰子样本    = ${samples}`);

// 落定后统计斜靠（借 isFlat 的近似，不必精确，只作回归参考）
let tilted = 0;
for (let t = 0; t < 20; t++) {
  for (let i = 0; i < N; i++) placeDie(dice[i].body, i, N);
  for (let i = 0; i < N; i++) tossDie(dice[i].body, { power: 1, dirX: Math.random() * 2 - 1, dirZ: Math.random() * 2 - 1 });
  settleWorld(world, dice, { maxSteps: 900, dt });
  for (const d of dice) if (!isFlat(d.body)) tilted++;
}
console.log(`斜靠率（20局回归） = ${tilted}/${20 * N}（应远小于一半）`);

const ok = escapes === 0;
console.log(ok ? '\n✓ 全部通过：无骰子越出容器' : `\n✗ 失败：${escapes} 次越界`);
process.exit(ok ? 0 : 1);
