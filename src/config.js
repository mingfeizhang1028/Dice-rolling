/**
 * 唯一调参中心。所有默认值都在这里，别处不允许出现魔法数字。
 */

export const DEFAULTS = {
  // ── 外观 ──
  theme: 'darkroom',
  material: 'jade',

  // ── 决策 ──
  diceCount: 1,            // 1..12。选号/多数决时可手调；对决时被锁为参与选项数
  decisionMode: 'duel',   // 'duel' 对决（一骰一选项，点数高者胜）；'pick' 选号；'vote' 多数决（手动分配·比总和）
  options: [],            // 选项列表。对决时颗数 = 参与选项数（≤4）；选号/多数决时颗数独立
  names: ['', '', '', '', '', '', '', '', '', '', '', ''],   // 各颗骰子的名字。空字符串表示没起名
  colors: [],             // 各颗骰子的自定义色（hex 字符串）。空 = 用材质默认色盘
  assignment: [],         // 多数决：每颗骰子归属的选项索引。空 = 自动 i % 选项数

  // ── 输入 ──
  swipeOn: true,           // 滑动/点击投掷
  shakeOn: true,           // 摇晃投掷

  // ── 结果 ──
  yesMapping: 'high',    // 'high' = 点数 ≥4 为是；'oddEven' = 奇数为是
  pauseMs: 600,          // 落定后到出结果之间的停顿。节奏本身，别调太小

  // ── 声音 ──
  soundOn: true,
  sfxVolume: 0.8,
  ambienceOn: true,
  ambienceKind: 'rain',  // 'rain' | 'white' | 'pink' | 'brown'
  ambienceVolume: 0.5,

  // ── 触觉 ──
  hapticsOn: true,

  // ── 物理 ──
  gravityScale: 1,       // 只影响观感速度，不影响投掷力度语义
};

/**
 * 骰子按数量缩放的尺寸系数。托盘固定，骰子多了就缩小，让它们装得下：
 * 截面面积大致恒定（每颗约 1/N 个托盘），线性尺寸取 sqrt(4/N)，
 * 下限 0.5 保证单颗仍可辨；N≤4 时不缩（=1）。
 */
export function dieScaleFor(count) {
  return Math.max(0.5, Math.min(1, Math.sqrt(4 / count)));
}

/** 物理常量。改这些会显著改变手感，动手前先读注释。 */
export const PHYSICS = {
  // 不是 -9.8。真实重力只在所有参数物理一致时才有意义；
  // 高重力让骰子更快落定，观感反而更好。
  gravity: -50,

  dieHalf: 0.5,          // 骰子半边长。cannon 用半边长，three BoxGeometry 用全长
  dieMass: 1,            // ⚠️ 永远归一化。金属密度是木头的 13 倍，照实做金属骰子甩不动
  sleepTimeLimit: 0.1,
  sleepSpeedLimit: 0.12,

  // 投掷冲量。第二参数偏移质心 → 产生角速度
  impulseBase: 2.6,
  impulseRange: 4.2,
  impulseOffset: [0, 0, 0.2],

  // ⚠️ 水平分量占垂直分量的比例。这个值不是随便定的：
  //    调大到 0.7 时自测里约 8% 的投掷会让骰子斜靠在墙上停住
  //    （只有一个角贴地，不是平躺）。读点仍然对，但看起来邋遢。
  //    调到 0.45 之后这个比例降到可忽略。
  horizontalRatio: 0.45,

  // 骰子出生的高度。重力 -50 时冲量 5 只能抬升 v²/2g = 0.25 单位，
  // 所以"掷"的观感其实来自下落，不是上抛 —— 出生点必须够高。
  //
  // ⚠️ 但**最高的一颗必须低于挡墙**。约束是：
  //      spawnHeight + (MAX_DICE-1) * slotLift  <  wallHeight
  //    1.5 + 3*0.12 = 1.86 < 3.0 ✓（wallHeight 见下方 SCENE）
  //    早先写成 spawnHeight 1.9 + slot*0.35 时，第 3 颗出生在 y=2.6，
  //    直接从墙顶飞出去，越界救援每局都在捞它。
  spawnHeight: 1.5,
  slotLift: 0.12,
  spawnSpread: 0.55,

  // 落定看门狗
  settleTimeoutMs: 10000,
  forceStopAfterMs: 2000,

  // 碰撞音触发阈值。重力 -50 时速度普遍偏大，阈值不是 0.5
  impactMinSpeed: 1.5,
  impactDebounceMs: 25,

  // 强度分档的上界。法向速度超过这个值就是最重的一档。
  // 取 9 的依据：出生高度 1.5、重力 -50，自由落体落地约 12 m/s，
  // 但骰子几乎不会以全部动能正面砸地（多数是翻滚中的斜擦），
  // 实测碰撞速度集中在 2..7。定成 12 的话最重档几乎永不触发，
  // 三档退化成一档半
  impactMaxSpeed: 9,
};

/**
 * 场景常量。
 *
 * ⚠️ 相机是按**水平**视场角定义的，不是垂直。
 *    PerspectiveCamera.fov 是垂直视场角，而手机竖屏宽高比只有 0.46 左右 ——
 *    如果照搬横屏教程里的 34°，竖屏上水平视场角只剩约 16°，
 *    5.2 宽的托盘要放到 30 单位外才装得下，骰子小得看不见。
 *    所以这里写 hfovDeg，由 view.js 按宽高比反推 fov。
 *
 * 托盘半宽 2.6（全宽 5.2，骰子边长 1）—— 装 3 颗绰绰有余，
 * 托盘再大骰子在竖屏上就太小了。
 */
export const SCENE = {
  trayHalf: 2.6,

  // 挡墙高度。**这是一道看不见的物理挡板**，比画面里的托盘边框高得多，
  // 只被 world.js 用，不影响任何视觉。
  // ⚠️ 约束：spawnHeight + (MAX_DICE-1)*slotLift < wallHeight
  //    1.5 + 11*0.12 = 2.82 < 3.0 ✓（MAX_DICE 已提到 12）
  // 取 3.0 而不是刚好够用的 1.9：墙面有 0.55 的弹性，骰子撞墙会往上弹，
  // 矮墙会被直接弹出去。留足余量比事后调弹性省事。
  wallHeight: 3.0,

  // 水平视场角。这个值直接决定骰子在屏幕上的大小
  hfovDeg: 40,
  // 竖屏反推出来的 fov 会很大（80° 上下），钳一下防止超广角畸变
  minVfovDeg: 26,
  maxVfovDeg: 82,

  camHeight: 7.2,
  camDist: 7.6,
  camLookAt: [0, 0.25, 0],
};

/** 存储 */
export const STORE_KEY = 'dice-rolling';
export const STORE_VERSION = 1;
