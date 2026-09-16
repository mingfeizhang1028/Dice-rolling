/**
 * 结果卡。
 *
 * 三条分支对应 flow.js 里 computeResult 的三种返回值，
 * 但文案是在这里定的 —— 状态机只管算，不管怎么说。
 *
 * 并列的处理是这块最需要用心的地方。「点数撞上了」不是错误提示，
 * 它是一个真实的信号：你对这几个选项确实没有偏好，那就再掷一次，
 * 或者干脆承认还需要再想想。所以文案写成机会，不写成故障。
 *
 * ⚠️ 选项和名字是用户自己输的，一律 textContent。
 */

import { on } from '../core/bus.js';

export function initResultCard(el) {
  on('result', show);

  // 骰子还在飞的时候，上一轮的结果必须先消失。
  // 不消失的话用户会看着旧结果等新结果，整个揭晓瞬间就废了
  on('flow:change', ({ to }) => {
    if (to === 'THROWING' || to === 'IDLE' || to === 'ARMING') hide();
  });

  function hide() {
    el.classList.remove('on');
    el.replaceChildren();
  }

  function show(result) {
    el.replaceChildren();

    switch (result.kind) {
      case 'single':
        renderSingle(result);
        break;
      case 'choice':
        renderChoice(result);
        break;
      default:
        renderMulti(result);
        break;
    }

    // 强制回流，保证过渡动画每一轮都重新播
    void el.offsetWidth;
    el.classList.add('on');
  }

  function renderSingle(r) {
    const value = document.createElement('div');
    value.className = 'result-value';
    value.textContent = String(r.value);
    if (r.color) value.style.color = r.color;

    const verdict = document.createElement('div');
    verdict.className = 'result-verdict';
    verdict.textContent = r.yes ? '是' : '否';

    el.append(value, verdict);
  }

  function renderChoice(r) {
    if (r.winner === null) {
      // 并列
      const title = document.createElement('div');
      title.className = 'result-title';
      title.textContent = '点数撞上了';

      const list = document.createElement('div');
      list.className = 'result-tie';
      for (const idx of r.tied) {
        const s = r.slots[idx];
        list.appendChild(tieRow(s));
      }

      const hint = document.createElement('div');
      hint.className = 'result-sub';
      hint.textContent = '你更想选哪一颗？';

      el.append(title, list, hint);
      return;
    }

    const w = r.slots[r.winner];

    const opt = document.createElement('div');
    opt.className = 'result-option';
    opt.textContent = w.option || `第 ${w.slot + 1} 颗`;

    const meta = document.createElement('div');
    meta.className = 'result-meta';

    const dot = document.createElement('span');
    dot.className = 'result-dot';
    dot.style.background = w.color;

    const label = document.createElement('span');
    // 名字只在用户起过的时候才显示。
    // ⚠️ 名字和选项相同时不重复写一遍 —— 用户很自然会把骰子
    //    按选项取名（三颗叫"搬家/留下/再等等"），那时上面一行
    //    已经写了"留下"，下面再来一次"留下 · 3 点"就成了废话
    label.textContent = w.name && w.name !== w.option
      ? `${w.name} · ${w.value} 点`
      : `${w.value} 点`;

    meta.append(dot, label);
    el.append(opt, meta);
  }

  function tieRow(s) {
    const row = document.createElement('div');
    row.className = 'tie-row';

    const dot = document.createElement('span');
    dot.className = 'result-dot';
    dot.style.background = s.color;

    const text = document.createElement('span');
    text.textContent = s.name && s.name !== s.option ? `${s.option} · ${s.name}` : s.option;

    const val = document.createElement('span');
    val.className = 'tie-value';
    val.textContent = `${s.value} 点`;

    row.append(dot, text, val);
    return row;
  }

  function renderMulti(r) {
    const row = document.createElement('div');
    row.className = 'result-row';

    for (const s of r.slots) {
      const cell = document.createElement('div');
      cell.className = 'result-cell';

      const dot = document.createElement('span');
      dot.className = 'result-dot';
      dot.style.background = s.color;

      const val = document.createElement('span');
      val.className = 'cell-value';
      val.textContent = String(s.value);

      cell.append(dot, val);
      row.appendChild(cell);
    }

    const sum = document.createElement('div');
    sum.className = 'result-sub';
    sum.textContent = `共 ${r.sum} 点`;

    el.append(row, sum);
  }

  return { hide };
}
