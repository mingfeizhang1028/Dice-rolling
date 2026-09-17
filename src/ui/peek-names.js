/**
 * 长按标注：每颗骰子旁边一个标签，一条曲线引线连到那颗骰子。
 *
 * 之前是"屏幕中央一块面板列名字"—— 骰子多了分不清哪个名字归哪颗。
 * 改成侧边标签 + 曲线相连（类似示意图的标注），标签贴着骰子所在的一侧，
 * 曲线指向骰子中心，一眼就知道哪个标签是哪颗。
 *
 * 只在"真的有名字或代表某选项"时才浮出；两者皆无，按住什么都不发生。
 *
 * 相机是固定的、骰子在 IDLE/ARMING 下是静止的，所以打开时投影一次即可，
 * 不需要逐帧跟随。
 */

import { on } from '../core/bus.js';
import { getCamera } from '../scene/view.js';
import { Vector3 } from 'three';

const _v = new Vector3();
const SVG_NS = 'http://www.w3.org/2000/svg';

/** 标签尺寸。引线从这里出发；行距低于这个值会互相叠 */
const LABEL_W = 168;
const LABEL_H = 26;
const EDGE_PAD = 12;
const MIN_GAP = 28;

export function initPeekNames(el, { getDice }) {
  on('peek:start', show);
  on('peek:end', hide);
  // 投掷过程中如果还挂着标注，会跟结果卡打架
  on('flow:change', ({ to }) => {
    if (to !== 'IDLE' && to !== 'ARMING') hide();
  });

  function hide() {
    el.classList.remove('on');
    // 等淡出结束再清空，立刻清空会看到内容"啪"地消失
    setTimeout(() => {
      if (!el.classList.contains('on')) el.replaceChildren();
    }, 200);
  }

  function show() {
    const dice = getDice();
    const meaningful = dice.filter((d) => d.name || d.option);
    if (!meaningful.length) return;

    const cam = getCamera();
    if (!cam) return;

    const W = window.innerWidth;
    const H = window.innerHeight;

    // 每颗骰子的屏幕坐标。在相机后面（z>1）的跳过去
    const items = [];
    for (const d of meaningful) {
      _v.copy(d.group.position);
      _v.project(cam);
      if (_v.z > 1 || _v.z < -1) continue;
      items.push({
        d,
        sx: (_v.x * 0.5 + 0.5) * W,
        sy: (-_v.y * 0.5 + 0.5) * H,
      });
    }
    if (!items.length) return;

    el.replaceChildren();
    el.classList.remove('on');

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'peek-svg');
    svg.setAttribute('width', String(W));
    svg.setAttribute('height', String(H));

    // 左半边骰子 → 标签放左缘；右半边 → 右缘。各自按 y 排序防重叠
    const left = items.filter((i) => i.sx < W / 2).sort((a, b) => a.sy - b.sy);
    const right = items.filter((i) => i.sx >= W / 2).sort((a, b) => a.sy - b.sy);

    placeColumn(left, false, svg, W, H);
    placeColumn(right, true, svg, W, H);

    el.appendChild(svg);
    void el.offsetWidth;
    el.classList.add('on');
  }

  function placeColumn(col, isRight, svg, W, H) {
    let prevY = null;

    for (const it of col) {
      // y 先钳进可视区，再和上一个标签拉开最小间距
      let y = Math.max(EDGE_PAD + LABEL_H / 2, Math.min(H - EDGE_PAD - LABEL_H / 2, it.sy));
      if (prevY !== null && Math.abs(y - prevY) < MIN_GAP) {
        y = y >= prevY ? prevY + MIN_GAP : prevY - MIN_GAP;
      }
      prevY = y;

      // ── 标签 ──
      const label = document.createElement('div');
      label.className = 'peek-label';
      label.style.top = `${Math.round(y - LABEL_H / 2)}px`;
      label.style[isRight ? 'right' : 'left'] = `${EDGE_PAD}px`;

      const dot = document.createElement('span');
      dot.className = 'peek-dot';
      dot.style.background = '#' + it.d.bodyMesh.material.color.getHex().toString(16).padStart(6, '0');

      const text = document.createElement('span');
      text.className = 'peek-name';
      const labelTxt = it.d.name || `第 ${it.d.slot + 1} 颗`;
      const suffix = it.d.option && it.d.option !== it.d.name ? ` · 代表：${it.d.option}` : '';
      text.textContent = labelTxt + suffix;

      label.append(dot, text);
      el.appendChild(label);

      // ── 引线：从标签内缘到骰子中心，三次贝塞尔，中段轻微外凸 ──
      const x0 = isRight ? W - EDGE_PAD - LABEL_W : EDGE_PAD + LABEL_W;
      const x1 = it.sx;
      const y1 = it.sy;
      const cx = x0 + (x1 - x0) * 0.5;

      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('class', 'peek-curve');
      path.setAttribute('d', `M ${x0} ${y} C ${cx} ${y}, ${cx} ${y1}, ${x1} ${y1}`);

      // 骰子端的锚点小圆，用骰子颜色，让"曲线指着谁"更明确
      const anchor = document.createElementNS(SVG_NS, 'circle');
      anchor.setAttribute('class', 'peek-anchor');
      anchor.setAttribute('cx', String(x1));
      anchor.setAttribute('cy', String(y1));
      anchor.setAttribute('r', '4');
      anchor.setAttribute('fill', '#' + it.d.bodyMesh.material.color.getHex().toString(16).padStart(6, '0'));

      svg.append(path, anchor);
    }
  }

  return { show, hide };
}