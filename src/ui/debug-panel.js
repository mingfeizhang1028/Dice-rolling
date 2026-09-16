/**
 * `?debug=1` 的性能面板。
 *
 * 存在的理由很具体：计划里的验收标准是"中端 Android 上 3 颗骰子稳定 55+"，
 * 没有这个面板就只能靠感觉说"好像还行"。draw calls 和几何体计数同时也是
 * 主题 dispose 纪律的度量 —— 来回切主题 20 次后这两个数应该回到基线。
 *
 * 只读，不参与任何决策。关掉它 app 的行为一模一样。
 */

import { add } from '../core/raf.js';
import { getRenderer } from '../scene/view.js';

/** 帧率用指数滑动平均。逐帧显示原始值会抖得看不清 */
const EMA = 0.08;
/** 物理耗时保留最近多少帧。够看出均值，又不至于把卡顿抹平 */
const PHYS_SAMPLES = 120;

export function initDebugPanel(root, { getState } = {}) {
  const el = document.createElement('div');
  el.className = 'debug';
  root.appendChild(el);

  let fps = 60;
  const physSamples = [];
  let worstMs = 0;

  add((dt) => {
    if (dt > 0) fps += (1 / dt - fps) * EMA;

    const s = getState ? getState() : {};

    if (Number.isFinite(s.physMs)) {
      physSamples.push(s.physMs);
      if (physSamples.length > PHYS_SAMPLES) physSamples.shift();
      if (s.physMs > worstMs) worstMs = s.physMs;
    }

    const r = getRenderer();
    const info = r?.info;

    const avgPhys = physSamples.length
      ? physSamples.reduce((a, b) => a + b, 0) / physSamples.length
      : 0;

    const lines = [
      `${fps.toFixed(0)} fps`,
      `draw ${info ? info.render.calls : '-'}`,
      `tri ${info ? formatK(info.render.triangles) : '-'}`,
      `geo ${info ? info.memory.geometries : '-'} · tex ${info ? info.memory.textures : '-'}`,
      `prog ${info ? info.programs?.length ?? '-' : '-'}`,
      `phys ${avgPhys.toFixed(2)}ms (峰值 ${worstMs.toFixed(1)})`,
      `${s.flow ?? '-'} · ${s.dice ?? 0} 颗`,
    ];

    if (s.extra) lines.push(s.extra);

    el.textContent = lines.join('\n');
    el.dataset.fps = fps.toFixed(0);
  });

  return {
    el,
    resetPeak() {
      worstMs = 0;
      physSamples.length = 0;
    },
  };
}

function formatK(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** 面板要占地方，点一下折起来 */
export function attachDebugToggle(el) {
  el.addEventListener('click', () => el.classList.toggle('folded'));
}
