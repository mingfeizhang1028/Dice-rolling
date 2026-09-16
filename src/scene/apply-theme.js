/**
 * 主题应用：CSS 变量 + 灯光 + 环境 + 托盘 + 材质覆盖系数。
 *
 * ⚠️ 切换时的 dispose 时机。
 *    颜色/灯光/背景是瞬间换的，然后靠一层 DOM 覆盖层淡出制造交叉过渡。
 *    为什么不用补间灯光：补间期间场景处于"两个主题都不像"的中间态，
 *    金属会闪、玉石会发灰。用覆盖层盖住这一瞬简单得多，观感也更干净。
 *    旧资源必须等覆盖层淡完（450ms）才能 dispose —— 提前销毁会导致
 *    过渡期黑屏，这是这类切换最经典的 bug。
 */

import { Color, Fog } from 'three';
import { getTheme } from '../themes.js';
import { buildLights, buildEnvironment } from './lights.js';
import { buildBoard } from './board.js';
import { getScene, getRenderer } from './view.js';

const FADE_MS = 450;

let current = null;

/** CSS 变量。首屏在 WebGL 就绪之前就要调它，所以不能依赖任何 three 资源 */
export function applyCss(themeId) {
  const t = getTheme(themeId);
  const root = document.documentElement;

  root.dataset.theme = t.id;
  root.dataset.scheme = t.scheme;

  for (const [key, value] of Object.entries(t.css)) {
    root.style.setProperty(key, value);
  }

  // 移动端浏览器地址栏/状态栏的配色
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t.css['--bg']);
}

function buildSceneTheme(themeId, tier) {
  const t = getTheme(themeId);
  const renderer = getRenderer();

  return {
    id: themeId,
    cssBg: t.css['--bg'],
    desc: t.scene,
    lights: buildLights(t.scene, tier),
    env: buildEnvironment(renderer, t.scene.env),
    board: buildBoard(t.scene),
  };
}

function disposeBuilt(b) {
  if (!b) return;

  for (const L of b.lights.lights) {
    // 阴影贴图是 GPU 资源，光本身没了它不会自己释放
    if (L.shadow && L.shadow.map) L.shadow.map.dispose();
    L.dispose?.();
  }
  b.env?.dispose();
  b.board.dispose();

  b.lights.group.removeFromParent();
  b.board.group.removeFromParent();
}

/**
 * 应用一套主题。
 * @param {string} themeId
 * @param {'high'|'mid'|'low'} tier
 * @param {object} [opts]
 * @param {boolean} [opts.fade] 是否走交叉淡入。首次挂载不需要
 * @param {() => void} [opts.onSettled] 淡入结束、旧资源已释放后回调
 */
export function applySceneTheme(themeId, tier, { fade = true, onSettled } = {}) {
  const scene = getScene();
  const renderer = getRenderer();
  if (!scene || !renderer) return null;

  const previous = current;
  const next = buildSceneTheme(themeId, tier);

  // 覆盖层必须用旧主题的背景色。用新主题的颜色会让"切换"变成"闪白"
  let overlay = null;
  if (fade && previous) {
    overlay = document.createElement('div');
    overlay.className = 'theme-fade';
    overlay.style.background = previous.cssBg;
    document.body.appendChild(overlay);
  }

  // 先把旧的从场景里摘掉，再挂新的。反过来会有一帧两个托盘重叠
  if (previous) {
    scene.remove(previous.lights.group);
    scene.remove(previous.board.group);
  }

  scene.add(next.lights.group);
  scene.add(next.board.group);
  scene.environment = next.env;
  scene.background = new Color(next.desc.background);
  scene.fog = new Fog(next.desc.fog.color, next.desc.fog.near, next.desc.fog.far);
  renderer.toneMappingExposure = next.desc.toneMappingExposure;

  current = next;
  applyCss(themeId);

  const finish = () => {
    disposeBuilt(previous);
    onSettled?.();
  };

  if (overlay) {
    // 等一帧再开始淡出，确保新主题已经渲染过一次
    requestAnimationFrame(() => {
      overlay.style.opacity = '0';
      setTimeout(() => {
        overlay.remove();
        finish();
      }, FADE_MS);
    });
  } else {
    finish();
  }

  return next;
}

/**
 * 把主题的材质覆盖系数作用到骰子上。
 *
 * 这是让"4 主题 × 4 材质随便搭都好看"的机制 —— 比任何文案提示都有效。
 * 纯白主题下把金属的 envMapIntensity 提到 1.25，金属才会是"干净的亮银"
 * 而不是"发黑的铁"；暗室下压低曝光，玉才有"暗处透亮"的感觉。
 *
 * 系数是从 userData 里的基准值乘出来的，所以重复调用是幂等的 ——
 * 换材质和换主题都会调它，必须能安全地反复调。
 */
export function applyMaterialOverrides(themeId, dice) {
  const o = getTheme(themeId).scene.material;

  for (const die of dice) {
    const m = die.bodyMesh.material;
    const base = m.userData;
    if (!base) continue;

    m.envMapIntensity = base.baseEnvMapIntensity * o.envMapIntensity;
    m.clearcoat = Math.min(1, base.baseClearcoat + o.clearcoatBoost);

    if (base.baseTransmission > 0) {
      m.transmission = Math.min(1, base.baseTransmission * o.transmissionScale);
    }
    m.needsUpdate = true;
  }
}

export function getCurrentThemeId() {
  return current?.id ?? null;
}

/** 整页重建时用 */
export function disposeTheme() {
  disposeBuilt(current);
  current = null;
}
