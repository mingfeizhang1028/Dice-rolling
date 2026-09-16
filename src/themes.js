/**
 * 四套主题 = 唯一真相源。同样只有纯数据。
 *
 * 每套主题含 css（→ CSS 变量）和 scene（→ three 灯光/环境/桌面/曝光）两段。
 *
 * ⚠️ 灯光 intensity 按"照度意图"写，不是 three 的物理值。
 *    现代 three（r155+）点光/聚光是 candela、带 1/d² 衰减；
 *    apply-theme.js 会按到目标的距离² 换算。不换算的话场景会黑成一片。
 *
 * material 段是材质覆盖系数。这是让"自由混搭也好看"的机制：
 * 换主题时按系数缩放所有骰子材质，比任何文案提示都有效。
 * 只要光照对了，跨维度混搭就不违和 —— 所以主题和材质不绑定。
 */

export const THEMES = {
  darkroom: {
    id: 'darkroom',
    label: '暗室静谧',
    scheme: 'dark',
    blurb: '一个人，一盏灯',

    scene: {
      background: 0x0d0d0f,
      // 相机到托盘约 10.5。near 必须大于这个数，否则托盘整片被推进背景色
      fog: { color: 0x0d0d0f, near: 11.5, far: 30 },
      toneMappingExposure: 1.05,

      lights: [
        // 主光：右上方一盏暖灯，斜切过骰子
        { type: 'spot', intensity: 2.2, position: [2.2, 6.2, 2.0], target: [0, 0, 0],
          angle: 0.62, penumbra: 0.85, decay: 2, color: 0xffe9d0, castShadow: true },
        // 补光：左后一盏冷光，压住阴影不让它死黑
        { type: 'spot', intensity: 0.8, position: [-3.4, 3.4, -2.6], target: [0, 0, 0],
          angle: 0.9, penumbra: 1.0, decay: 2, color: 0x9fc4ff, castShadow: false },
        // 环境：极暗的天顶光，只为了给金属一点方向
        { type: 'hemisphere', intensity: 0.72, sky: 0x2a2f3a, ground: 0x0a0a0c },
      ],

      // 环境贴图由 PMREM 从这张程序化渐变生成，不加载任何外部 HDR
      env: { kind: 'gradient', top: 0x2b3340, bottom: 0x07070a, intensity: 0.9 },

      board: {
        color: 0x1a1a1f,
        roughness: 0.55,
        metalness: 0.05,
        // 中央一小圈柔光，把视线收在骰子上
        glow: { color: 0xffe0b8, opacity: 0.10, radius: 3.2 },
        wall: 0x14141a,
      },

      // 暗室里玉骰子要透亮，纯白主题下金属要呈"干净的亮银"而不是"发黑的铁"
      material: { envMapIntensity: 1.00, clearcoatBoost: 0.0, transmissionScale: 1.00 },
    },

    css: {
      '--bg': '#0d0d0f',
      '--ink': '#e8e6e1',
      '--ink-dim': '#8a8780',
      '--ink-faint': '#4a4844',
      '--surface': 'rgba(28,28,33,0.72)',
      '--surface-solid': '#1c1c21',
      '--line': 'rgba(232,230,225,0.12)',
      '--accent': '#d8b98a',
      '--shadow': '0 12px 40px rgba(0,0,0,0.6)',
    },
  },

  warmwood: {
    id: 'warmwood',
    label: '暖木桌面',
    scheme: 'dark',
    blurb: '老桌游的下午',

    scene: {
      background: 0x241a12,
      fog: { color: 0x241a12, near: 12.5, far: 32 },
      toneMappingExposure: 1.0,

      lights: [
        { type: 'spot', intensity: 2.6, position: [0.8, 6.8, 3.2], target: [0, 0, 0],
          angle: 0.75, penumbra: 0.9, decay: 2, color: 0xffd9a0, castShadow: true },
        { type: 'spot', intensity: 0.7, position: [-4.0, 3.0, -1.0], target: [0, 0, 0],
          angle: 1.0, penumbra: 1.0, decay: 2, color: 0xffb870, castShadow: false },
        { type: 'hemisphere', intensity: 0.9, sky: 0x4a3a2c, ground: 0x1a1008 },
      ],

      env: { kind: 'gradient', top: 0x6a5038, bottom: 0x140d07, intensity: 1.0 },

      board: {
        color: 0x5a3f28,
        roughness: 0.72,
        metalness: 0.0,
        glow: { color: 0xffcf94, opacity: 0.12, radius: 3.4 },
        wall: 0x3a2718,
      },

      material: { envMapIntensity: 1.10, clearcoatBoost: 0.05, transmissionScale: 0.85 },
    },

    css: {
      '--bg': '#241a12',
      '--ink': '#f0e3d2',
      '--ink-dim': '#a89076',
      '--ink-faint': '#5e4a37',
      '--surface': 'rgba(58,39,24,0.78)',
      '--surface-solid': '#3a2718',
      '--line': 'rgba(240,227,210,0.14)',
      '--accent': '#e0a860',
      '--shadow': '0 12px 40px rgba(0,0,0,0.55)',
    },
  },

  paperwhite: {
    id: 'paperwhite',
    label: '极简纯白',
    scheme: 'light',
    blurb: '无印良品的展台',

    scene: {
      background: 0xf4f4f2,
      // 浅色主题的雾容易看出来（背景亮，远处发白很明显），所以推得更远
      fog: { color: 0xf4f4f2, near: 15, far: 38 },
      toneMappingExposure: 0.92,

      lights: [
        // 白光环境里主光要软、要宽，硬阴影会立刻显得廉价
        { type: 'spot', intensity: 2.0, position: [2.6, 7.0, 3.0], target: [0, 0, 0],
          angle: 1.0, penumbra: 1.0, decay: 2, color: 0xffffff, castShadow: true },
        { type: 'spot', intensity: 1.4, position: [-3.0, 4.6, -2.4], target: [0, 0, 0],
          angle: 1.1, penumbra: 1.0, decay: 2, color: 0xf0f4ff, castShadow: false },
        { type: 'hemisphere', intensity: 2.4, sky: 0xffffff, ground: 0xdcdcd8 },
      ],

      env: { kind: 'gradient', top: 0xffffff, bottom: 0xc8c8c4, intensity: 1.35 },

      board: {
        color: 0xe9e9e6,
        roughness: 0.68,
        metalness: 0.0,
        glow: { color: 0xffffff, opacity: 0.0, radius: 3.0 },
        wall: 0xd6d6d2,
      },

      // 纯白下金属必须靠环境反射撑起来，否则就是一块发黑的铁
      material: { envMapIntensity: 1.25, clearcoatBoost: 0.10, transmissionScale: 0.80 },
    },

    css: {
      '--bg': '#f4f4f2',
      '--ink': '#1a1a1a',
      '--ink-dim': '#6e6e6a',
      '--ink-faint': '#b4b4b0',
      '--surface': 'rgba(255,255,255,0.82)',
      '--surface-solid': '#ffffff',
      '--line': 'rgba(26,26,26,0.12)',
      '--accent': '#8a8a86',
      '--shadow': '0 12px 40px rgba(0,0,0,0.10)',
    },
  },

  xuanpaper: {
    id: 'xuanpaper',
    label: '宣纸',
    scheme: 'light',
    blurb: '案头清供',

    scene: {
      background: 0xe8dfcc,
      fog: { color: 0xe8dfcc, near: 14, far: 36 },
      toneMappingExposure: 0.96,

      lights: [
        // 暖白漫射。塑料在这个主题下会看起来像"上了釉的白瓷"
        { type: 'spot', intensity: 1.7, position: [1.8, 6.4, 2.6], target: [0, 0, 0],
          angle: 1.0, penumbra: 1.0, decay: 2, color: 0xfff2dc, castShadow: true },
        { type: 'spot', intensity: 0.9, position: [-3.2, 3.8, -2.0], target: [0, 0, 0],
          angle: 1.0, penumbra: 1.0, decay: 2, color: 0xd8e0c8, castShadow: false },
        { type: 'hemisphere', intensity: 1.9, sky: 0xfaf0dc, ground: 0xc4b8a0 },
      ],

      env: { kind: 'gradient', top: 0xfaf2e0, bottom: 0xb0a488, intensity: 1.15 },

      board: {
        color: 0xd8ccb4,
        roughness: 0.82,
        metalness: 0.0,
        glow: { color: 0xfff4dc, opacity: 0.06, radius: 3.3 },
        wall: 0xc0b49c,
      },

      material: { envMapIntensity: 1.05, clearcoatBoost: 0.0, transmissionScale: 1.10 },
    },

    css: {
      '--bg': '#e8dfcc',
      '--ink': '#2e2820',
      '--ink-dim': '#6e6250',
      '--ink-faint': '#a89c88',
      '--surface': 'rgba(248,242,228,0.84)',
      '--surface-solid': '#f8f2e4',
      '--line': 'rgba(46,40,32,0.14)',
      '--accent': '#96703c',
      '--shadow': '0 12px 40px rgba(70,58,40,0.14)',
      // 宣纸主题才加载中文衬线子集；其他主题留空走系统字体
      '--font-serif': '"NotoSerifSC-subset", "Songti SC", "STSong", serif',
    },
  },
};

export const THEME_IDS = Object.keys(THEMES);

export function getTheme(id) {
  return THEMES[id] || THEMES.darkroom;
}
