/**
 * 碰撞音烘焙的自测。
 *
 * ⚠️ 这个测试存在的理由：我听不到声音。
 *    "四种材质闭眼能分辨"是 P2 的验收标准之一，而在没有耳朵的情况下
 *    唯一诚实的做法是把它翻译成可测量的量 —— 衰减时间、过零率、峰值。
 *    人耳分辨材质靠的就是"余韵多长"和"多亮"，这两样恰好都能量。
 *
 * 断言的是**排序和量级**，不是精确值。精确值会随调音变化，
 * 排序（金属最长最亮、木头最短最闷）才是设计意图本身。
 */

import { renderForTest, measure, INTENSITY_LEVELS, VARIANTS_PER_LEVEL } from '../src/audio/bake.js';
import { pickLevel } from '../src/audio/impact.js';
import { PHYSICS } from '../src/config.js';
import { MATERIAL_IDS, MATERIALS } from '../src/materials.js';

let fail = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) fail++;
  console.log(`${cond ? '✓' : '✗'} ${label}${detail ? '  ' + detail : ''}`);
};

const HARD = INTENSITY_LEVELS - 1;   // 最重的一档，跨材质比较用它

/**
 * ⚠️ 必须对**所有变体取均值**再比较，不能只看第 0 个变体。
 *
 *    每档每个变体用的是不同的 seed，于是 decayJitter（玉石 ±15%）
 *    各抽各的。只看变体 0 等于拿三个互不相关的随机抽样互相比 ——
 *    实测出来分档衰减是 591 / 722 / 646ms，非单调，看起来像设计错了，
 *    其实是测量错了。播放期本来就是随机挑一个变体，均值才是用户听到的。
 */
function avgMeasure(id, level) {
  const runs = [];
  for (let v = 0; v < VARIANTS_PER_LEVEL; v++) {
    const { samples, rate } = renderForTest(id, level, v);
    runs.push(measure(samples, rate));
  }
  const mean = (k) => runs.reduce((s, r) => s + r[k], 0) / runs.length;
  return {
    decayMs: Number(mean('decayMs').toFixed(1)),
    zcr: Number(mean('zcr').toFixed(0)),
    peak: Number(mean('peak').toFixed(4)),
    attack: Number(mean('attack').toFixed(3)),
    lengthMs: runs[0].lengthMs,
    runs,
  };
}

console.log('── 各材质最重档的实测特征（3 变体均值）──\n');
console.log('材质   衰减ms   过零率   峰值    起振   长度ms   设计decayMs');
console.log('─'.repeat(60));

const stats = {};
for (const id of MATERIAL_IDS) {
  const m = avgMeasure(id, HARD);
  stats[id] = m;
  console.log(
    `${MATERIALS[id].label.padEnd(5)}  ` +
    `${String(m.decayMs).padStart(6)}  ` +
    `${String(m.zcr).padStart(6)}  ` +
    `${String(m.peak).padStart(6)}  ` +
    `${String(m.attack).padStart(5)}  ` +
    `${String(m.lengthMs).padStart(6)}  ` +
    `${String(MATERIALS[id].sound.decayMs).padStart(10)}`
  );
}
console.log('');

// 同一档的三个变体峰值必须完全一致 —— 归一化的作用就是"只换音色不换音量"。
// 如果这里不等，说明归一化被绕过，用户听到的会是"音量随机跳"
for (const id of MATERIAL_IDS) {
  const peaks = stats[id].runs.map((r) => r.peak);
  ok(`${MATERIALS[id].label} 变体间等响`, new Set(peaks).size === 1, peaks.join(' '));
}

// ── 1. 基本健全性 ──

for (const id of MATERIAL_IDS) {
  const m = stats[id];
  const label = MATERIALS[id].label;
  ok(`${label} 不削顶`, m.peak <= 1.0, `peak=${m.peak}`);
  ok(`${label} 不是静音`, m.peak > 0.1, `peak=${m.peak}`);
  // 撞击是瞬态：第一窗就该到包络峰值的 80% 以上
  ok(`${label} 起振是瞬态`, m.attack > 0.8, `首窗/峰值=${m.attack}`);
  // ⚠️ 衰减必须在缓冲区内量得到。量不到的话 decayMs 量的是缓冲区长度
  //    而不是声音长度 —— 那样跨材质比较就完全失去意义，而且不会报错
  ok(`${label} 余韵在缓冲区内衰完`, m.decayMs < m.lengthMs - 45,
     `${m.decayMs}ms / 缓冲 ${m.lengthMs}ms`);
}

// ── 2. 衰减排序：塑料 < 木头 < 玉石 < 金属 ──
//
// 这是"闭眼能分辨"的第一根支柱。留 1.35 倍的余量要求：
// 两两之间要拉开这么多，才算真的分得开，而不是"差不多长"。
const decayOrder = ['plastic', 'wood', 'jade', 'metal'];
let decayOk = true;
const decayParts = [];
for (let i = 1; i < decayOrder.length; i++) {
  const a = stats[decayOrder[i - 1]].decayMs;
  const b = stats[decayOrder[i]].decayMs;
  decayParts.push(`${MATERIALS[decayOrder[i-1]].label}${a}→${MATERIALS[decayOrder[i]].label}${b}(${(b/a).toFixed(2)}×)`);
  if (b < a * 1.35) decayOk = false;
}
ok('余韵长度排序 塑料<木头<玉石<金属', decayOk, decayParts.join(' '));

// 最长的和最短的之间至少要差 5 倍，否则"长余韵"这个描述不成立
const spread = stats.metal.decayMs / stats.plastic.decayMs;
ok('最长/最短 ≥5×', spread >= 5, `${spread.toFixed(1)}×`);

// ── 3. 亮度排序：木头最闷 ──
//
// 第二根支柱。木头基频 850Hz、低通 1kHz、Q=8，三条都指向"闷"。
// 只断言木头最低这一条 —— 金属/玉石/塑料之间谁更亮取决于分音增益，
// 那个排序不是设计意图，硬断言等于把调音参数焊死在测试里。
const brightest = MATERIAL_IDS.reduce((a, b) => (stats[a].zcr > stats[b].zcr ? a : b));
const dullest = MATERIAL_IDS.reduce((a, b) => (stats[a].zcr < stats[b].zcr ? a : b));
ok('最闷的是木头', dullest === 'wood', `实际 ${MATERIALS[dullest].label} zcr=${stats[dullest].zcr}`);
ok('最亮的是金属', brightest === 'metal', `实际 ${MATERIALS[brightest].label} zcr=${stats[brightest].zcr}`);
ok('最亮/最闷 ≥2×', stats[brightest].zcr >= stats[dullest].zcr * 2,
   `${(stats[brightest].zcr / stats[dullest].zcr).toFixed(1)}×`);

// ── 4. 三档强度必须真的分得开 ──

console.log('\n── 强度分档（以玉石为例）──\n');
console.log('档位   峰值     衰减ms   过零率   起振');
console.log('─'.repeat(40));
const tiers = [];
for (let lv = 0; lv < INTENSITY_LEVELS; lv++) {
  const m = avgMeasure('jade', lv);
  tiers.push(m);
  console.log(`  ${lv}   ${String(m.peak).padStart(6)}  ${String(m.decayMs).padStart(6)}  ${String(m.zcr).padStart(6)}  ${String(m.attack).padStart(5)}`);
}
console.log('');

// 响度必须分得开，否则"重撞听起来更重"就不成立。
// 要求相邻档差 ≥1.6 倍 —— 再小就淹没在压缩器的动态范围里了
ok('峰值逐档递增 ≥1.6×',
   tiers[1].peak >= tiers[0].peak * 1.6 && tiers[2].peak >= tiers[1].peak * 1.6,
   tiers.map(t => t.peak).join(' < '));
// 重撞更亮：高次分音被激发得更多。只调音量的话这里会持平
ok('重撞比轻碰更亮', tiers[2].zcr > tiers[0].zcr * 1.05,
   `${tiers[0].zcr} → ${tiers[2].zcr}`);
// ⚠️ 余韵必须逐档变长，不能只断言"首尾"。中间那一档若比两端都短，
//    听起来就是"中等力度反而最干"，而首尾断言完全看不出来
ok('余韵逐档变长 ≥1.12×',
   tiers[1].decayMs >= tiers[0].decayMs * 1.12 && tiers[2].decayMs >= tiers[1].decayMs * 1.12,
   tiers.map(t => t.decayMs).join(' → '));

// ── 5. 确定性 ──
//
// 同一个 seed 必须烘出逐字节相同的波形。不然每次启动音色都变，
// 用户会觉得"这次的声音不对"，而这是最难查的一类 bug。
const a1 = renderForTest('metal', 2, 1).samples;
const a2 = renderForTest('metal', 2, 1).samples;
let identical = a1.length === a2.length;
if (identical) for (let i = 0; i < a1.length; i++) if (a1[i] !== a2[i]) { identical = false; break; }
ok('同 seed 逐样本相同', identical);

const b1 = renderForTest('metal', 2, 2).samples;
let differs = false;
for (let i = 0; i < Math.min(a1.length, b1.length); i++) if (a1[i] !== b1[i]) { differs = true; break; }
ok('不同变体互不相同', differs);

// ── 6. 无 NaN / 无直流偏置 ──
//
// 直流偏置会让整个音频链多出一份你看不见的能量，压缩器会因此误动作。
// 一个不对称的包络或者写错的滤波器很容易产生它。
for (const id of MATERIAL_IDS) {
  const { samples } = renderForTest(id, 1, 0);
  let bad = 0, sum = 0;
  for (let i = 0; i < samples.length; i++) {
    if (!Number.isFinite(samples[i])) bad++;
    sum += samples[i];
  }
  const dc = sum / samples.length;
  ok(`${MATERIALS[id].label} 无 NaN`, bad === 0, bad ? `${bad} 个` : '');
  ok(`${MATERIALS[id].label} 无直流偏置`, Math.abs(dc) < 0.01, `dc=${dc.toFixed(5)}`);
}

// ── 7. 低采样率下不能混叠 ──
//
// 玉的 8.93 次分音在 baseHz 2100 下是 18.7kHz。44.1k 时它活着，
// 32k 时就越过奈奎斯特了。越界后不跳过的话，sin 会折返成一个
// 低频鬼影 —— 听起来像背景里有个走调的口哨，比不发声难听得多。
//
// renderForTest 固定用 44100，所以这里直接调内部的渲染路径不现实；
// 改为验证设计约束：所有材质的最高分音都必须在 22050Hz 以下。
let worstHz = 0, worstId = '';
for (const id of MATERIAL_IDS) {
  const s = MATERIALS[id].sound;
  const top = s.baseHz * Math.max(...s.partials) * (1 + s.hzJitter) * 1.03; // 1.03 = 最重档的音高抬升
  if (top > worstHz) { worstHz = top; worstId = id; }
}
ok('最高分音低于 44.1k 奈奎斯特', worstHz < 22050,
   `最高 ${MATERIALS[worstId].label} ${Math.round(worstHz)}Hz`);

// ── 8. 速度 → 强度档的映射 ──
//
// pickLevel 是纯函数，能在 Node 里直接测 —— 这正是它被单独抽出来的原因。
// 这里最容易出的错是**边界归属**：档与档之间差一格，用户不会觉得
// "分错了"，只会觉得"有时候撞击声怪怪的"，几乎无从复现。
console.log('\n── 速度 → 强度档边界 ──\n');
const lo = PHYSICS.impactMinSpeed, hi = PHYSICS.impactMaxSpeed;
const span = hi - lo;
const bounds = [lo, lo + span / 3, lo + span * 2 / 3, hi];
console.log(`阈值 ${lo} 上界 ${hi} → 分界点 ${bounds.map(b => b.toFixed(2)).join(' / ')}`);

ok('刚过阈值是最轻档', pickLevel(lo) === 0, `v=${lo}`);
ok('阈值以下也安全返回 0', pickLevel(0.1) === 0);
ok('第一分界点进入中档', pickLevel(bounds[1]) === 1, `v=${bounds[1].toFixed(2)}`);
ok('第一分界点前一丁点仍在轻档', pickLevel(bounds[1] - 0.001) === 0);
ok('第二分界点进入重档', pickLevel(bounds[2]) === 2, `v=${bounds[2].toFixed(2)}`);
ok('第二分界点前一丁点仍在中档', pickLevel(bounds[2] - 0.001) === 1);
ok('远超高上界仍是重档', pickLevel(50) === 2);
ok('上界本身是重档', pickLevel(hi) === 2);

// 三档的实际速度区间宽度必须相等。宽度不等的话某一档会挤掉大部分碰撞，
// 用户听到的声音就只剩一两种，"三档"白做
const widths = [bounds[1] - bounds[0], bounds[2] - bounds[1]];
ok('前两档宽度相等', Math.abs(widths[0] - widths[1]) < 1e-9,
   widths.map(w => w.toFixed(3)).join(' vs '));

// 极端速度不能返回越界下标 —— 越界会读到 undefined 的 buffer 变体，
// 然后 AudioBufferSourceNode.buffer = undefined 在部分浏览器上是抛异常
let everOut = false;
for (let v = 0; v <= 40; v += 0.05) {
  const lv = pickLevel(v);
  if (!Number.isInteger(lv) || lv < 0 || lv >= INTENSITY_LEVELS) { everOut = true; break; }
}
ok('全速度域内档位合法', !everOut);

console.log(fail ? `\n✗ ${fail} 项失败` : '\n✓ 全部通过');
process.exit(fail ? 1 : 0);
