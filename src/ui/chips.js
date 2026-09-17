/**
 * 顶部的材质 + 颗数控制。
 *
 * 刻意做得低对比度：它是可调的，但用户是来做决定的，不是来调设置的。
 * 让它一眼看得见、但不抢骰子，靠的是"存在但不亮"—— 描边比填充多，
 * 尺寸比正文小一档。
 */

import { MATERIALS, MATERIAL_IDS } from '../materials.js';
import { MAX_DICE } from '../flow.js';

export function initChips(el, { settings, onMaterial, onCount }) {
  // ── 材质 ──
  const matRow = document.createElement('div');
  matRow.className = 'chip-row';

  const matChips = new Map();
  for (const id of MATERIAL_IDS) {
    const m = MATERIALS[id];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip';
    btn.dataset.material = id;
    btn.setAttribute('aria-label', m.label);

    const dot = document.createElement('span');
    dot.className = 'chip-dot';
    dot.style.background = m.swatch;

    const label = document.createElement('span');
    label.textContent = m.label;

    btn.append(dot, label);
    btn.addEventListener('click', () => onMaterial(id));

    matRow.appendChild(btn);
    matChips.set(id, btn);
  }

  // ── 颗数 ──
  const countRow = document.createElement('div');
  countRow.className = 'chip-row count-row';

  const minus = makeStep('−', '减少一颗');
  const countLabel = document.createElement('span');
  countLabel.className = 'count-label';
  const plus = makeStep('+', '增加一颗');

  minus.addEventListener('click', () => onCount(-1));
  plus.addEventListener('click', () => onCount(1));

  countRow.append(minus, countLabel, plus);

  el.append(matRow, countRow);

  function makeStep(text, aria) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip step';
    b.textContent = text;
    b.setAttribute('aria-label', aria);
    return b;
  }

  function render() {
    for (const [id, btn] of matChips) {
      btn.classList.toggle('on', id === settings.material);
    }

    const n = settings.diceCount;
    countLabel.textContent = `${n} 颗`;
    minus.disabled = n <= 1;
    plus.disabled = n >= MAX_DICE;

    // 对决时颗数 = 参与选项数，不让手动改 —— 改了就对上不号了。
    // 选号（pick）时选项只是清单，颗数独立，仍可自由加减。
    const inDuel = settings.decisionMode !== 'pick';
    const lockedByOptions = inDuel && (settings.options || []).filter((s) => s.trim()).length > 0;
    countRow.classList.toggle('locked', lockedByOptions);
    minus.disabled = minus.disabled || lockedByOptions;
    plus.disabled = plus.disabled || lockedByOptions;
    if (lockedByOptions) countLabel.textContent = `${n} 颗 · 对决`;
  }

  render();
  return { render };
}
