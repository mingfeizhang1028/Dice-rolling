/**
 * 临时诊断：失败样本到底停在哪儿。
 * 用完即弃，不进版本库。
 */
import { buildWorld } from '../src/physics/world.js';
import { settleWorld } from '../src/physics/settle.js';
import { placeDie, tossDie } from '../src/physics/throw.js';
import { createDie } from '../src/dice/die.js';
import { readFace } from '../src/dice/face-reader.js';
import { PHYSICS, SCENE } from '../src/config.js';

const diceCount = Number(process.argv[2] || 3);
const throws = Number(process.argv[3] || 200);
const materialId = process.argv[4] || 'metal';

const world = buildWorld();
const dice = [];
for (let i = 0; i < diceCount; i++) {
  dice.push(createDie({ materialId, slot: i, world, name: `t${i}` }));
}

const dt = 1 / 60;
const rows = [];

for (let t = 0; t < throws; t++) {
  for (let i = 0; i < dice.length; i++) placeDie(dice[i].body, i, dice.length);
  for (let i = 0; i < dice.length; i++) {
    tossDie(dice[i].body, {
      power: 0.15 + Math.random() * 0.85,
      dirX: Math.random() * 2 - 1,
      dirZ: Math.random() * 2 - 1,
    });
  }
  settleWorld(world, dice, { maxSteps: 900, dt });
  for (let k = 0; k < 8; k++) world.step(dt, dt, 3);

  for (let i = 0; i < dice.length; i++) {
    const b = dice[i].body;
    const r = readFace(b.quaternion);
    const rad = Math.hypot(b.position.x, b.position.z);
    rows.push({
      r: Number(rad.toFixed(3)),
      y: Number(b.position.y.toFixed(3)),
      conf: Number(r.confidence.toFixed(3)),
      value: r.value,
    });
  }
}

// 按置信度分档，看它们离中心多远
const buckets = [
  { name: '平躺 conf>=0.995', lo: 0.995, hi: 2 },
  { name: '微斜 0.95~0.995', lo: 0.95, hi: 0.995 },
  { name: '明显斜 0.70~0.95', lo: 0.70, hi: 0.95 },
  { name: '棱/角 <0.70    ', lo: 0, hi: 0.70 },
];

console.log(`\n${materialId} ${diceCount}颗 × ${throws} = ${rows.length} 样本`);
console.log(`托盘半宽 ${SCENE.trayHalf}\n`);

for (const bk of buckets) {
  const sel = rows.filter((x) => x.conf >= bk.lo && x.conf < bk.hi);
  if (!sel.length) { console.log(`${bk.name}  0`); continue; }
  const radii = sel.map((x) => x.r).sort((a, b) => a - b);
  const p = (q) => radii[Math.min(radii.length - 1, Math.floor(radii.length * q))];
  const ys = sel.map((x) => x.y);
  const avgY = ys.reduce((a, b) => a + b, 0) / ys.length;
  console.log(
    `${bk.name}  ${String(sel.length).padStart(4)}  ` +
    `半径 p50=${p(0.5).toFixed(2)} p90=${p(0.9).toFixed(2)} max=${p(1).toFixed(2)}  ` +
    `平均y=${avgY.toFixed(2)}`,
  );
}
console.log('');
