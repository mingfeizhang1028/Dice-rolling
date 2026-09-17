/**
 * 虚按浮出的"颜色 ↔ 名字"对照表。松手即隐。
 *
 * 为什么名字平时不显示：主界面上挂着三个名字，用户的注意力会被名字
 * 抢走，骰子本身反而变成了背景。让骰子只有颜色 —— 颜色是直觉的，
 * 名字是概念的 —— 需要概念的时候按住看一眼，这就够了。
 *
 * 只在真的有名字或"代表某选项"时才浮出。两者皆无的时候按住什么都不发生，
 * 而不是弹一个空面板，那会让人觉得"按坏了"。
 */

import { on } from '../core/bus.js';

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
    // 有名字或"代表某选项"的骰子都值得浮出来看；两者皆无才忽略
    const meaningful = dice.filter((d) => d.name || d.option);
    if (!meaningful.length) return;

    el.replaceChildren();
    for (const d of dice) {
      const row = document.createElement('div');
      row.className = 'peek-row';

      const dot = document.createElement('span');
      dot.className = 'peek-dot';
      // 自定义色直接取材质的实际颜色（含覆盖），比按 slot 推色更准
      dot.style.background = '#' + d.bodyMesh.material.color.getHex().toString(16).padStart(6, '0');

      const name = document.createElement('span');
      name.className = 'peek-name';
      // 名字 + 代表的选项。名字和选项相同时不重复写（用户常把骰子按选项取名）
      const label = d.name || `第 ${d.slot + 1} 颗`;
      const suffix = d.option && d.option !== d.name ? ` · 代表：${d.option}` : '';
      name.textContent = label + suffix;

      // 名字和选项都没有的降一档显示，让有信息的更突出
      if (!d.name && !d.option) row.classList.add('unnamed');

      row.append(dot, name);
      el.appendChild(row);
    }

    void el.offsetWidth;
    el.classList.add('on');
  }

  return { show, hide };
}
