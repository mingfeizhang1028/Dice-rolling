/**
 * 虚按浮出的"颜色 ↔ 名字"对照表。松手即隐。
 *
 * 为什么名字平时不显示：主界面上挂着三个名字，用户的注意力会被名字
 * 抢走，骰子本身反而变成了背景。让骰子只有颜色 —— 颜色是直觉的，
 * 名字是概念的 —— 需要概念的时候按住看一眼，这就够了。
 *
 * 只在真的有名字时才浮出。没起名的时候按住什么都不发生，
 * 而不是弹一个空面板，那会让人觉得"按坏了"。
 */

import { on } from '../core/bus.js';
import { dieColor, hexToCss } from '../materials.js';

export function initPeekNames(el, { getDice }) {
  on('peek:start', show);
  on('peek:end', hide);
  // 投掷过程中如果还挂着对照表，会跟结果卡打架
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
    const named = dice.filter((d) => d.name);

    // 都没起名就什么都不做
    if (!named.length) return;

    el.replaceChildren();
    for (const d of dice) {
      const row = document.createElement('div');
      row.className = 'peek-row';

      const dot = document.createElement('span');
      dot.className = 'peek-dot';
      dot.style.background = hexToCss(dieColor(d.materialId, d.slot));

      const name = document.createElement('span');
      name.className = 'peek-name';
      name.textContent = d.name || `第 ${d.slot + 1} 颗`;

      // 没起名的那些降一档显示，让起了名的更突出
      if (!d.name) row.classList.add('unnamed');

      row.append(dot, name);
      el.appendChild(row);
    }

    void el.offsetWidth;
    el.classList.add('on');
  }

  return { show, hide };
}
