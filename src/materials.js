/**
 * 四种材质 = 四套参数的唯一真相源。
 *
 * ⚠️ 架构纪律：本文件不允许出现任何 three / cannon / WebAudio 调用，
 *    只有对象字面量。解释器（scene/ dice/ audio/ haptics）负责把数据变成资源。
 *    这条让"4 主题 × 4 材质"不需要写 16 份代码。
 *
 * 数据分五段，各自只被一个解释器读：
 *   physics → physics/world.js    visual → dice/die.js
 *   pip     → dice/geometry.js    sound  → audio/bake.js    haptic → haptics.js
 *
 * colorAlt 同时承担两个职责：同一材质多颗骰子时的区分色，以及虚按浮出
 * 名字对照时显示的色值。所以这 4 个色相变体必须肉眼可辨。
 */

export const MATERIALS = {
  jade: {
    id: 'jade',
    label: '玉石',
    swatch: '#4f9e7d',

    physics: {
      restitution: 0.40,
      friction: 0.35,
      angularDamping: 0.10,
      linearDamping: 0.02,
      contact: { stiffness: 1e7, relaxation: 3 },
    },

    visual: {
      // 翡翠绿。用户反馈"太轻"—— 薄荷绿(0x7fd6b5)和中绿(0x69bd95)都偏浅，
      // 压到深一点的青绿，配合透射衰减才是"玉"
      color: 0x4f9e7d,
      // 白玉 / 碧玉 / 黄玉。早先三个都是薄荷绿，在 11px 的色点上
      // 最小色差只有 40，等于没区分 —— 详见 tools/palette.mjs
      colorAlt: [0xe8f2ec, 0x2f7a58, 0xd8c98a],
      metalness: 0.0,
      // 微涩 → 蜡质光泽。0.15 太滑，会往玻璃/塑料那边走
      roughness: 0.18,
      // transmission 双倍渲染量，view.js 里按档位调分辨率
      // ⚠️ 半透明是玉的核心：0.30 太"实"，像上了漆的木头
      transmission: 0.55,
      // 光在体内的穿透距离更长 → "透光而不透明"的深度感
      thickness: 1.8,
      ior: 1.60,
      clearcoat: 1.0,
      // 蜡感的光泽：不锐利，是柔润的漫反射高光
      clearcoatRoughness: 0.16,
      attenuationColor: 0x2f7d66,
      // 衰减慢一点，让深处的绿透出来，而不是一下就变灰
      attenuationDistance: 1.6,
      envMapIntensity: 1.3,
    },

    // 玉的点数是镶嵌进去的深绿小圆珠，明显凸出、有光泽
    pip: { style: 'inlay', color: 0x0d3b2e, radius: 0.078, raise: 0.006, depth: 0.014, roughness: 0.25 },

    sound: {
      // 玉石 = 敲石头的"叮"：清脆、短、干净。
      // ⚠️ 不能像金属那样高亮长余韵 —— 两种会听不出差别。压到 1750Hz、
      //    缩短余韵、加点"喳"的撞击瞬态，才有石头的质感
      kind: 'modal',
      baseHz: 1750,
      hzJitter: 0.05,
      partials: [1, 2.4, 4.3, 6.9],
      partialGains: [1, 0.5, 0.22, 0.09],
      partialDecay: [1, 0.7, 0.5, 0.3],
      decayMs: 260,
      decayJitter: 0.12,
      noiseMix: 0.35,
      noiseLpfHz: 5200,
      noiseQ: 24,
      gain: 0.55,
    },

    haptic: { impactMs: 12, settle: [10, 30, 25], gain: 0.8 },
  },

  plastic: {
    id: 'plastic',
    label: '塑料',
    swatch: '#e8e8ea',

    physics: {
      restitution: 0.55,      // 上限。再高会弹太久，用户干等
      friction: 0.28,
      angularDamping: 0.06,   // 还会滚两下
      linearDamping: 0.01,
      contact: { stiffness: 1e7, relaxation: 3 },
    },

    visual: {
      color: 0xf2f2f4,
      // 塑料骰子本来就是彩色的。用真的骰子色：红 / 蓝 / 黄
      colorAlt: [0xd94a3d, 0x3f7fd8, 0xe8c33f],
      metalness: 0.0,
      roughness: 0.28,
      transmission: 0.0,
      thickness: 0,
      ior: 1.46,
      clearcoat: 0.7,
      clearcoatRoughness: 0.18,
      attenuationColor: 0xffffff,
      attenuationDistance: 1,
      envMapIntensity: 1.0,
    },

    // 塑料点数是涂上去的，几乎与面齐平
    pip: { style: 'painted', color: 0x1a1a1e, radius: 0.076, raise: 0.0015, depth: 0.008, roughness: 0.35 },

    sound: {
      // 塑料 = 干"啪"：几乎没余韵，主体是噪声瞬态。
      // 略微加一点身体(110ms)、降一点频，避免像纯鼠标点击声
      kind: 'modal',
      baseHz: 1350,
      hzJitter: 0.10,
      partials: [1, 2.1, 3.4, 5.1],
      partialGains: [1, 0.45, 0.20, 0.08],
      partialDecay: [1, 0.85, 0.7, 0.5],
      decayMs: 95,            // "啪"，干
      decayJitter: 0.20,
      noiseMix: 0.70,
      noiseLpfHz: 1800,
      noiseQ: 10,
      gain: 0.45,
    },

    haptic: { impactMs: 8, settle: [8, 20, 16], gain: 0.6 },
  },

  metal: {
    id: 'metal',
    label: '金属',
    swatch: '#c8cbd2',

    physics: {
      restitution: 0.25,
      friction: 0.20,         // 最滑
      angularDamping: 0.02,   // 转个不停
      linearDamping: 0.005,
      contact: { stiffness: 1e7, relaxation: 3 },
    },

    visual: {
      color: 0xc8cbd2,
      // 金 / 古铜 / 黑钛
      colorAlt: [0xd8b46a, 0x9a6b4a, 0x5a5e66],
      metalness: 1.0,
      // 抛光面。0.22 是拉丝/哑光钢，读起来不"金属"
      roughness: 0.08,
      transmission: 0.0,
      thickness: 0,
      ior: 2.5,
      // 清漆高光，让高光点更锐
      clearcoat: 1.0,
      clearcoatRoughness: 0.06,
      attenuationColor: 0xffffff,
      attenuationDistance: 1,
      // 金属全靠环境贴图撑，1.3 偏暗，提到 1.7 才有"亮的金属"而不是"发黑的铁"
      envMapIntensity: 1.7,
    },

    // 金属点数是刻进去的凹坑。凹坑是"不反光的洞"，所以用哑光深色冒充，
    // 而不是真的往下挖 —— 本体不透明，挖下去就看不见了
    pip: { style: 'engraved', color: 0x2e3138, radius: 0.080, raise: 0.002, depth: 0.010, roughness: 0.68 },

    sound: {
      // 金属 = 敲金属块的"嗡——"：长、亮、近乎等音高。
      // 保持长余韵是它的招牌，再拉长一点、加一点点撞击瞬态
      kind: 'modal',
      baseHz: 3000,
      hzJitter: 0.04,
      partials: [1, 1.41, 2.13, 2.87, 3.92, 5.11],   // 分音最多
      partialGains: [1, 0.72, 0.50, 0.34, 0.22, 0.13],
      partialDecay: [1, 0.95, 0.9, 0.85, 0.8, 0.75],
      decayMs: 1150,          // 长余韵
      decayJitter: 0.08,
      noiseMix: 0.12,         // 噪声极少
      noiseLpfHz: 8000,
      noiseQ: 18,
      gain: 0.42,
    },

    haptic: { impactMs: 14, settle: [8, 24, 20], gain: 0.9 },
  },

  wood: {
    id: 'wood',
    label: '木头',
    swatch: '#b98a54',

    physics: {
      restitution: 0.30,
      friction: 0.52,         // 最涩
      angularDamping: 0.22,   // "啪"一下就停。区分手感最有效的旋钮就是它
      linearDamping: 0.04,
      contact: { stiffness: 1e7, relaxation: 3 },
    },

    visual: {
      color: 0xb98a54,
      // 松木 / 胡桃 / 红木
      colorAlt: [0xe8caa0, 0x6b4423, 0xa8452f],
      metalness: 0.0,
      roughness: 0.62,
      transmission: 0.0,
      thickness: 0,
      ior: 1.5,
      clearcoat: 0.25,
      clearcoatRoughness: 0.4,
      attenuationColor: 0x8a5f33,
      attenuationDistance: 0.6,
      envMapIntensity: 0.85,
    },

    // 木头点数是烧烙上去的，边缘焦、面微凹
    pip: { style: 'burned', color: 0x2a1a0c, radius: 0.077, raise: 0.0015, depth: 0.008, roughness: 0.72 },

    sound: {
      // 木头 = 闷钝的"咚"：主体是低通噪声，几乎没有余韵音调。
      // 正弦分音只垫一层很低的身体，频率压到 620，噪声占大头
      kind: 'modal',
      baseHz: 620,
      hzJitter: 0.12,
      partials: [1, 1.72, 2.94, 4.35],
      partialGains: [1, 0.5, 0.24, 0.10],
      partialDecay: [1, 0.75, 0.55, 0.35],
      decayMs: 160,
      decayJitter: 0.16,
      noiseMix: 0.72,          // 闷响为主
      noiseLpfHz: 750,         // 闷
      noiseQ: 6,
      gain: 0.5,
    },

    haptic: { impactMs: 10, settle: [8, 22, 18], gain: 0.7 },
  },
};

export const MATERIAL_IDS = Object.keys(MATERIALS);

/** 取材质数据；未知 id 回退到玉石，绝不返回 undefined */
export function getMaterial(id) {
  return MATERIALS[id] || MATERIALS.jade;
}

/**
 * 混搭骰子（不同材质互撞）也要建 ContactMaterial，
 * 否则走 defaultContactMaterial，手感失真。
 * 取两者参数的中间值 —— 不做"更硬的一方赢"这种规则，用户感知不到。
 */
export function blendContact(a, b) {
  const A = getMaterial(a).physics;
  const B = getMaterial(b).physics;
  const mid = (x, y) => (x + y) / 2;
  return {
    friction: mid(A.friction, B.friction),
    restitution: mid(A.restitution, B.restitution),
    contact: {
      stiffness: Math.min(A.contact.stiffness, B.contact.stiffness),
      relaxation: mid(A.contact.relaxation, B.contact.relaxation),
    },
  };
}

/**
 * 第 slot 颗骰子的区分色。
 *
 * 色盘 = 主色 + 3 个 colorAlt，共 4 色，按 slot 循环取用。
 * ⚠️ 之前写成「slot 0 固定主色、其余只在 3 个 colorAlt 里轮转」，骰子多了之后
 *    主色永远只落在第 1 颗上 —— 总有一个颜色只有一颗骰子。4 色一起循环，
 *    任何颗数下各色都尽量均匀。
 */
export function dieColor(materialId, slot) {
  const m = getMaterial(materialId);
  const palette = [m.visual.color, ...m.visual.colorAlt];
  return palette[slot % palette.length];
}

/** 十六进制色 → CSS 字符串，虚按对照表要用 */
export function hexToCss(hex) {
  return '#' + hex.toString(16).padStart(6, '0');
}
