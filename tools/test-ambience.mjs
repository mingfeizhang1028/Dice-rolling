/**
 * 环境音自测。同样地 —— 我听不到声音，所以把"像不像雨"翻译成可测量的量。
 *
 * 雨声有两个最容易做错、而错了以后**完全不会报错**的地方：
 *   ① 循环接缝。噪声床每 2 秒接一次，接不好就是"咔、咔、咔"，
 *      而要等到一个长会话里才被察觉。
 *   ② 到达间隔的分布。做成固定间隔听起来像机关枪，做成泊松才像雨。
 *      这个差别是听觉上的，但分布本身可以量。
 */

import { renderBed, poissonInterval, AMB_LEVELS } from '../src/audio/ambience.js';

let fail = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) fail++;
  console.log(`${cond ? '✓' : '✗'} ${label}${detail ? '  ' + detail : ''}`);
};

const RATE = 44100;
const KINDS = ['rain', 'white', 'pink', 'brown'];

// ── 1. 循环接缝 ──
//
// 判据：把循环点当成一个普通的样本间隔，看它的"跳变"相对
// 信号自身的典型跳变有多大。自然噪声相邻样本本来就会跳，
// 所以要跟**同一条波形内部的平均跳变**比，不能跟 0 比。
//
// 接缝没闭合时，buf[0] 和 buf[N-1] 是两个无关的随机数，
// 跳变会明显大于平均值；闭合之后应该在同一量级。
console.log('── 循环接缝（跳变 / 内部平均跳变，1.0 = 与普通样本无异）──\n');

for (const kind of KINDS) {
  const s = renderBed(kind, RATE);
  let sumJump = 0;
  for (let i = 1; i < s.length; i++) sumJump += Math.abs(s[i] - s[i - 1]);
  const avgJump = sumJump / (s.length - 1);
  const seamJump = Math.abs(s[0] - s[s.length - 1]);
  const ratio = seamJump / avgJump;

  ok(`${kind} 接缝无跳变`, ratio < 5,
     `接缝 ${seamJump.toFixed(5)} / 平均 ${avgJump.toFixed(5)} = ${ratio.toFixed(2)}×`);
}

// ── 2. 三种噪声的频谱斜率必须真的不同 ──
//
// 白噪能量均匀、粉噪 -3dB/oct、棕噪 -6dB/oct。区分它们的是
// **高频占比**，过零率是它的廉价代理。排序必须是 white > pink > brown。
// 若三种做出来一个味儿，用户切 kind 会发现设置没反应。
console.log('\n── 噪声频谱（过零率越高越亮）──\n');

const zcr = {};
for (const kind of KINDS) {
  const s = renderBed(kind, RATE);
  let zc = 0;
  for (let i = 1; i < s.length; i++) if ((s[i - 1] < 0) !== (s[i] < 0)) zc++;
  zcr[kind] = Math.round(zc / (s.length / RATE));
  console.log(`  ${kind.padEnd(6)} 过零率 ${String(zcr[kind]).padStart(6)}`);
}
console.log('');

ok('白噪比粉噪亮', zcr.white > zcr.pink * 1.05, `${zcr.white} vs ${zcr.pink}`);
ok('粉噪比棕噪亮', zcr.pink > zcr.brown * 1.05, `${zcr.pink} vs ${zcr.brown}`);
ok('白噪/棕噪 ≥2×', zcr.white >= zcr.brown * 2, `${(zcr.white / zcr.brown).toFixed(1)}×`);

// ── 3. 三种床等响 ──
//
// 归一化到 -6dBFS 是刻意的：不等响的话用户切 kind 时听到的是
// "音量变了"而不是"音色变了"
console.log('');
for (const kind of KINDS) {
  const s = renderBed(kind, RATE);
  let peak = 0;
  for (let i = 0; i < s.length; i++) { const a = Math.abs(s[i]); if (a > peak) peak = a; }
  ok(`${kind} 峰值 -6dBFS`, Math.abs(peak - 0.5) < 0.005, `peak=${peak.toFixed(4)}`);
}

// ── 4. 没有无界漂移 ──
//
// ⚠️ 这一条**不能**测"样本均值接近 0"。粉噪和棕噪是 1/f 过程，
//    能量集中在低频；2 秒窗口里最低频还走不满一个周期，
//    样本均值本来就不可能接近零（实测 0.008~0.016，是信号本身
//    的最低频分量，不是 bug）。真正会出问题的是**泄漏写错**：
//    棕噪的 `last = (last + 0.02w)/1.02` 里那个 /1.02 如果漏掉，
//    积分就变成随机游走，方差随长度无界增长 —— 听感上从"噗"
//    逐渐变成低频晃动。
//
//    判别方法是看均值**随长度怎么变**：
//      平稳过程（有泄漏）→ 相关时间固定，Var(均值) ∝ 1/N，均值随长度收缩
//      随机游走（无泄漏）→ Var(均值) ∝ N，均值随长度放大 √N
//    两种情形在 8 倍长度上差一个数量级，躲不掉。
console.log('\n── 漂移（均值随长度的变化，收缩 = 有界，放大 = 随机游走）──\n');

const meanOf = (arr) => {
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[i];
  return sum / arr.length;
};

for (const kind of KINDS) {
  const short = renderBed(kind, RATE, 2);
  const long = renderBed(kind, RATE, 16);
  const mShort = Math.abs(meanOf(short));
  const mLong = Math.abs(meanOf(long));
  const growth = mLong / Math.max(1e-9, mShort);
  // 8 倍长度：平稳过程期望 ~0.35×（1/√8），随机游走期望 ~2.8×（√8）。
  // 取 1.5× 作分界，两边都有 4 倍以上的余量
  ok(`${kind} 均值不随长度放大`, growth < 1.5,
     `2s ${mShort.toFixed(5)} → 16s ${mLong.toFixed(5)}（${growth.toFixed(2)}×）`);
}

// 白噪是不相关的，均值应当服从 σ/√N —— 这个可以严格断言。
// 它是唯一一个"理论上就该接近 0"的 kind，也是其余三种的对照组
console.log('');
{
  const s = renderBed('white', RATE);
  let sumSq = 0, sum = 0;
  for (let i = 0; i < s.length; i++) { sum += s[i]; sumSq += s[i] * s[i]; }
  const rms = Math.sqrt(sumSq / s.length);
  const dc = sum / s.length;
  const expected = rms / Math.sqrt(s.length);
  ok('白噪均值在 σ/√N 量级', Math.abs(dc) < expected * 5,
     `dc=${dc.toFixed(6)}，σ/√N=${expected.toFixed(6)}`);
}

// ── 5. 到达间隔必须是泊松（指数分布）──
//
// ⚠️ 这是"像雨"和"像机关枪"的分水岭，也是整个 ambience 里
//    唯一无法靠肉眼审查代码发现的问题。
//    指数分布的变异系数 CV = 标准差/均值 = 1，恰好是 1。
//    固定间隔 CV = 0。做错了这里会立刻显形。
console.log('\n── 雨滴到达间隔分布 ──\n');

const RATE_TEST = 20;      // 每秒 20 滴
const N = 20000;
const samples = [];
for (let i = 0; i < N; i++) samples.push(poissonInterval(RATE_TEST));

const mean = samples.reduce((a, b) => a + b, 0) / N;
const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / N;
const cv = Math.sqrt(variance) / mean;

console.log(`  设定 ${RATE_TEST} 滴/秒，实测均值间隔 ${(mean * 1000).toFixed(2)}ms`);
console.log(`  理论均值 ${(1000 / RATE_TEST).toFixed(2)}ms，变异系数 CV=${cv.toFixed(3)}（指数分布应为 1）\n`);

ok('平均间隔符合设定速率', Math.abs(mean - 1 / RATE_TEST) < 1 / RATE_TEST * 0.05,
   `${(mean * 1000).toFixed(2)}ms vs ${(1000 / RATE_TEST).toFixed(2)}ms`);
ok('分布是指数型（CV≈1）', Math.abs(cv - 1) < 0.1, `CV=${cv.toFixed(3)}`);

// 固定间隔会给出 CV≈0，这一条专门用来抓"退化成等间隔"这个具体错误
ok('不是等间隔（CV 远离 0）', cv > 0.5, `CV=${cv.toFixed(3)}`);

// 间隔必须恒正。出现 0 或负数会让 while 循环空转 ——
// nextDropAt 不前进，一帧里排几千滴雨，直接爆音
let nonPositive = 0;
for (const v of samples) if (!(v > 0) || !Number.isFinite(v)) nonPositive++;
ok('间隔恒为正且有限', nonPositive === 0, nonPositive ? `${nonPositive} 个异常` : '');

// ── 6. 档位常量自洽 ──

console.log('');
const levels = Object.entries(AMB_LEVELS);
ok('档位都在 0..1', levels.every(([, v]) => v >= 0 && v <= 1));
ok('揭晓时完全安静', AMB_LEVELS.RESULT === 0, `RESULT=${AMB_LEVELS.RESULT}`);
ok('投掷时最响', AMB_LEVELS.THROWING === Math.max(...levels.map(([, v]) => v)));
ok('投掷比静置响', AMB_LEVELS.THROWING > AMB_LEVELS.IDLE);

console.log(fail ? `\n✗ ${fail} 项失败` : '\n✓ 全部通过');
process.exit(fail ? 1 : 0);
