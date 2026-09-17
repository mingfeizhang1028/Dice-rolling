/**
 * 全屏编辑页。
 *
 * 角落的圆点点开，一块全屏覆盖层，装两件事：
 *   上半是"决策的准备" —— 选项、命名；
 *   下半是"环境" —— 是与否映射、主题、声音、触觉、数据。
 *
 * ⚠️ 架构纪律：本模块不 import 任何业务层（physics/audio/haptics/flow），
 *    只 import 纯数据（themes/materials）取 label/swatch。
 *    所有改动通过写在 settings（同一个对象引用）上 + 回调交回 main.js，
 *    main.js 是装配点，认识所有人、负责真正生效。
 *
 * ⚠️ 用户输入的一律 textContent 写入，绝不 innerHTML。
 *
 * ⚠️ 布局是可滚动的独立容器，touch-action: auto —— 这里要能滑，
 *    不能像 #stage 一样把手势吃干净。
 */

import { THEME_IDS, getTheme } from '../themes.js';
import { MATERIAL_IDS, MATERIALS, dieColor, hexToCss } from '../materials.js';
import { exportJson, importJson, clear as clearStore } from '../store.js';

const AMB_KINDS = [
  { id: 'rain', label: '雨' },
  { id: 'white', label: '白噪' },
  { id: 'pink', label: '粉噪' },
  { id: 'brown', label: '棕噪' },
];

/** 选项列表的上限。骰子色盘只有 4 色，但选号玩法允许更多选项，取个够用的上限 */
const MAX_OPTIONS = 20;
const DUEL_PARTICIPANTS = 4;

/** 骰子自定义色的预设色带。给"想要什么色就什么色"的第一步选择 */
const COLOR_PRESETS = [
  '#e8e8ea', '#d94a3d', '#e8c33f', '#7fd6b5', '#3f7fd8', '#b98a54',
  '#c8cbd2', '#d8b46a', '#9a6b4a', '#5a5e66', '#2f7a58', '#d8c98a',
  '#e8f2ec', '#f2a2c8',
];

/** 判定规则 label，编辑页对应用户语言 */
const MODES = [
  { id: 'duel', label: '对决', blurb: '一骰一选项，点数高者胜' },
  { id: 'pick', label: '选号', blurb: '点数和数到第几个选谁' },
  { id: 'vote', label: '多数决', blurb: '骰子手动归属选项，比总和' },
];

export function initEditor(root, opts) {
  const { settings, caps } = opts;

  let outer = null;
  let bodyEl = null;
  let optionWrap = null;
  let dieWrap = null;
  let themeWrap = null;
  let soundRow = null;
  let hapticRow = null;

  /** 当前最多显示几行选项。决定"要不要给加号"。兼顾已存的选项与骰子数，并防止超上限 */
  let visibleOptions = Math.min(MAX_OPTIONS, Math.max(settings.diceCount, (settings.options || []).length, 1));

  function open() {
    if (outer) return;
    outer = document.createElement('div');
    outer.className = 'editor';

    const main = document.createElement('main');
    main.className = 'editor-inner';

    main.appendChild(buildHeader());
    main.appendChild(buildDecision());
    main.appendChild(buildSettings());
    if (caps.canVibrate) main.appendChild(buildHaptics());
    main.appendChild(buildData());

    outer.appendChild(main);
    root.appendChild(outer);

    document.body.classList.add('editing');
    requestAnimationFrame(() => outer.classList.add('on'));

    renderTheme();
  }

  function close() {
    if (!outer) return;
    document.body.classList.remove('editing');
    // 立刻让骰子对得上当前表单 —— 比如手动清空最后一个选项后直接关闭
    opts.onReline();
    outer.classList.remove('on');
    setTimeout(() => {
      outer?.remove();
      outer = null;
    }, 260);
  }

  function buildHeader() {
    const head = document.createElement('div');
    head.className = 'editor-head';

    const title = document.createElement('h2');
    title.textContent = '编辑';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'editor-close';
    closeBtn.setAttribute('aria-label', '完成');
    closeBtn.textContent = '完成';
    closeBtn.addEventListener('click', close);

    head.append(title, closeBtn);
    return head;
  }

  // ── 决策：判定规则 + 选项 + 骰子 ───────────────────────

  let modeHint = null;
  let optBtn = null;
  let optBody = null;
  let dieBtn = null;
  let dieBody = null;
  /** 选项 / 骰子两个折叠块各自是否展开。默认都收起，避免一打开就是满屏输入框 */
  let optionsOpen = false;
  let diceOpen = false;

  function buildDecision() {
    const sec = section('决策');

    // 判定规则：对决 / 选号 / 多数决
    const modeRow = document.createElement('div');
    modeRow.className = 'editor-field';

    const modeSeg = document.createElement('div');
    modeSeg.className = 'editor-seg';
    for (const m of MODES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'editor-seg-btn';
      b.classList.toggle('on', settings.decisionMode === m.id);
      b.textContent = m.label;
      b.setAttribute('data-blurb', m.blurb);
      b.addEventListener('click', () => {
        settings.decisionMode = m.id;
        opts.save();
        for (const s of modeSeg.querySelectorAll('.editor-seg-btn')) {
          s.classList.toggle('on', s === b);
        }
        renderModeHint();
        syncDiceCount();
        renderOptions();
        renderDice();
        opts.onReline();
      });
      modeSeg.appendChild(b);
    }
    modeRow.appendChild(modeSeg);

    modeHint = document.createElement('p');
    modeHint.className = 'editor-note';

    // ── 「选项」折叠块 ──
    optBtn = document.createElement('button');
    optBtn.type = 'button';
    optBtn.className = 'editor-collapse';
    optBtn.setAttribute('aria-expanded', 'false');
    optBtn.addEventListener('click', () => {
      optionsOpen = !optionsOpen;
      optBody.hidden = !optionsOpen;
      renderCollapse();
    });

    optBody = document.createElement('div');
    optBody.className = 'editor-collapse-body';
    optBody.hidden = true;

    optionWrap = document.createElement('div');
    optionWrap.className = 'editor-options';
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'editor-add';
    addBtn.textContent = '＋ 添加一个选项';
    addBtn.addEventListener('click', () => {
      if (visibleOptions >= MAX_OPTIONS) return;
      visibleOptions++;
      renderOptions();
    });
    optBody.append(optionWrap, addBtn);

    // ── 「骰子」折叠块：名字 + 颜色 + （多数决）归属 ──
    dieBtn = document.createElement('button');
    dieBtn.type = 'button';
    dieBtn.className = 'editor-collapse';
    dieBtn.setAttribute('aria-expanded', 'false');
    dieBtn.addEventListener('click', () => {
      diceOpen = !diceOpen;
      dieBody.hidden = !diceOpen;
      renderCollapse();
    });

    dieBody = document.createElement('div');
    dieBody.className = 'editor-collapse-body';
    dieBody.hidden = true;

    dieWrap = document.createElement('div');
    dieWrap.className = 'editor-names';
    dieBody.appendChild(dieWrap);

    sec.append(modeRow, modeHint, optBtn, optBody, dieBtn, dieBody);

    renderModeHint();
    renderOptions();
    renderDice();
    return sec;
  }

  /** 两个折叠按钮的文案：带计数，收起时也能一眼知道里面有货 */
  function renderCollapse() {
    if (optBtn) {
      const f = filledCount();
      optBtn.textContent = `选项${f ? `（${f}）` : ''} ${optionsOpen ? '▾' : '▸'}`;
      optBtn.setAttribute('aria-expanded', String(optionsOpen));
    }
    if (dieBtn) {
      dieBtn.textContent = `骰子（名字·颜色${settings.decisionMode === 'vote' && filledCount() > 0 ? '·分配' : ''}）${diceOpen ? '▾' : '▸'}`;
      dieBtn.setAttribute('aria-expanded', String(diceOpen));
    }
  }

  function filledCount() {
    return settings.options.filter((s) => (s || '').trim()).length;
  }

  /** 当前是否处于"对决 + 填了选项"——此时骰子数锁为参与选项数，名字被选项代管 */
  function isDuelOverriding() {
    return settings.decisionMode === 'duel' && filledCount() > 0;
  }

  function renderModeHint() {
    if (!modeHint) return;
    const mode = ['pick', 'vote', 'duel'].includes(settings.decisionMode)
      ? settings.decisionMode
      : 'duel';
    const f = filledCount();

    if (mode === 'pick') {
      modeHint.textContent = '选号玩法：把所有骰子点数加起来，从头循环数到第几个就选第几个';
    } else if (mode === 'vote') {
      if (f === 0) {
        modeHint.textContent = '多数决：每颗骰子归属一个选项，掷出后比各选项的点数总和，高者胜';
      } else {
        // 按当前分配统计各选项骰子数，不匀时提醒 —— 总和玩法下骰子多的选项天然占优
        const counts = new Array(f).fill(0);
        for (let i = 0; i < settings.diceCount; i++) counts[assignedOf(i, f)]++;
        const bal = counts.every((c) => c === counts[0]);
        const warn = bal ? '' : ` 当前 ${counts.map((c, k) => `${filledText(k)}×${c}`).join('、')}，骰子数不等会偏向骰子多的一方。`;
        modeHint.textContent = `多数决：骰子手动归属选项，掷出后比总和，高者胜。${warn}`;
      }
    } else if (f > DUEL_PARTICIPANTS) {
      modeHint.textContent = `对决只让前 ${DUEL_PARTICIPANTS} 个选项参加，其余会被忽略；更多选项请用选号`;
    } else {
      modeHint.textContent = '对决模式下每个选项一颗骰子，点数高者胜';
    }
  }

  /** 同步骰子颗数。对决：颗数锁为参与选项数；选号/多数决：不动，交给 chip 控制 */
  function syncDiceCount() {
    if (settings.decisionMode !== 'duel') return;
    const f = filledCount();
    if (f > 0) settings.diceCount = Math.max(1, Math.min(DUEL_PARTICIPANTS, f));
  }

  /** 对决且填了选项时，让骰子名字 = 选项名，长按能对照着看；其余场景不动 */
  function syncDuelNames() {
    if (!isDuelOverriding()) return;
    const f = Math.min(filledCount(), settings.options.length);
    for (let i = 0; i < f; i++) settings.names[i] = (settings.options[i] || '').trim();
  }

  function filledText(k) {
    const f = settings.options.map((s) => (s || '').trim()).filter(Boolean);
    return f[k] || `第 ${k + 1} 项`;
  }

  /** 第 i 颗骰子归属的选项索引。多数决读 assignment；缺省自动 i % N；对决固定 1:1 */
  function assignedOf(i, F) {
    if (settings.decisionMode === 'vote') {
      const a = Number(settings.assignment?.[i]);
      const idx = Number.isInteger(a) && a >= 0 ? a : i % F;
      return Math.max(0, Math.min(F - 1, idx));
    }
    return Math.min(F - 1, i);
  }

  function renderOptions() {
    if (!optionWrap) return;
    optionWrap.replaceChildren();

    for (let i = 0; i < visibleOptions; i++) {
      const row = document.createElement('div');
      row.className = 'editor-option-row';

      const dot = document.createElement('span');
      dot.className = 'editor-dot';
      // 颜色按槽位轮转：骰子色盘只有 4 色，超过就循环；对决时 i<4 恰好精确对应
      dot.style.background = hexToCss(dieColor(settings.material, i % DUEL_PARTICIPANTS));

      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 40;
      input.placeholder = '选项一、选项二……';
      input.value = settings.options[i] || '';
      input.addEventListener('input', () => {
        settings.options[i] = input.value;
        syncDiceCount();
        syncDuelNames();
        opts.save();
        renderDice();
        renderModeHint();
      });
      input.addEventListener('change', () => {
        settings.options[i] = input.value;
        syncDuelNames();
        opts.save();
        opts.onReline();
      });

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'editor-del';
      del.textContent = '删';
      del.setAttribute('aria-label', '删除该选项');
      del.disabled = visibleOptions <= 1;
      del.addEventListener('click', () => {
        settings.options.splice(i, 1);
        // 尾部留一个空占位，保证数组索引跟槽位一致
        while (settings.options.length < visibleOptions) settings.options.push('');
        if (visibleOptions > 1) visibleOptions--;
        syncDiceCount();
        syncDuelNames();
        opts.save();
        renderOptions();
        renderDice();
        renderModeHint();
        opts.onReline();
      });

      row.append(dot, input, del);
      optionWrap.appendChild(row);
    }

    renderCollapse();
  }

  /** 骰子折叠块：每颗 = 颜色(可自选) + 名字 + （多数决）归属选项 */
  function renderDice() {
    if (!dieWrap) return;
    dieWrap.replaceChildren();

    const note = document.createElement('p');
    note.className = 'editor-note';
    note.textContent = '给骰子起名字、选颜色；多数决里还能点「代表」换它所属的选项';
    dieWrap.appendChild(note);

    const F = filledCount();
    const vote = settings.decisionMode === 'vote' && F > 0;

    for (let i = 0; i < settings.diceCount; i++) {
      const row = document.createElement('div');
      row.className = 'editor-name-row';

      // ── 颜色：色点按钮 → 内联色板（预设 + 原生取色器 + 默认） ──
      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.className = 'editor-color-swatch';
      swatch.style.background = settings.colors[i] || hexToCss(dieColor(settings.material, i));
      swatch.setAttribute('aria-label', `第 ${i + 1} 颗颜色`);
      swatch.textContent = '';

      const picker = document.createElement('div');
      picker.className = 'editor-color-pop';
      picker.hidden = true;

      const strip = document.createElement('div');
      strip.className = 'editor-color-strip';
      for (const c of COLOR_PRESETS) {
        const p = document.createElement('button');
        p.type = 'button';
        p.className = 'editor-color-dot';
        p.style.background = c;
        p.addEventListener('click', () => {
          settings.colors[i] = c;
          opts.save();
          opts.onReline();
          renderDice();
        });
        strip.appendChild(p);
      }

      const native = document.createElement('input');
      native.type = 'color';
      native.className = 'editor-color-native';
      native.setAttribute('aria-label', '自定义颜色');
      native.value = settings.colors[i] || '#7fd6b5';
      native.addEventListener('input', () => {
        settings.colors[i] = native.value;
        opts.save();
        opts.onReline();
      });

      const reset = document.createElement('button');
      reset.type = 'button';
      reset.className = 'editor-color-reset';
      reset.textContent = '默认';
      reset.addEventListener('click', () => {
        settings.colors[i] = '';
        opts.save();
        opts.onReline();
        renderDice();
      });

      picker.append(strip, native, reset);
      swatch.addEventListener('click', () => {
        picker.hidden = !picker.hidden;
      });

      // ── 名字 ──
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 24;
      input.placeholder = `第 ${i + 1} 颗的名字`;
      input.value = settings.names[i] || '';
      input.addEventListener('input', () => {
        settings.names[i] = input.value;
        opts.save();
      });
      input.addEventListener('change', () => {
        settings.names[i] = input.value;
        opts.onReline();
      });

      row.append(swatch, input);

      // ── 多数决：归属选项，点一下切到下一项 ──
      if (vote) {
        const a = assignedOf(i, F);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'editor-assign';
        btn.textContent = `代表：${filledText(a)}`;
        btn.setAttribute('aria-label', `第 ${i + 1} 颗代表的选项，点击切换`);
        btn.addEventListener('click', () => {
          const next = (a + 1) % F;
          settings.assignment[i] = next;
          opts.save();
          opts.onReline();
          renderDice();
          renderModeHint();
        });
        row.append(btn);
      }

      dieWrap.appendChild(row);
      dieWrap.appendChild(picker);
    }

    renderCollapse();
  }

  // ── 设置：是与否 / 主题 / 声音 / 触觉 ─────────────────

  function buildSettings() {
    const sec = section('设置');

    sec.appendChild(buildYesMapping());

    themeWrap = document.createElement('div');
    themeWrap.className = 'editor-grid theme-grid';
    sec.appendChild(themeWrap);
    renderTheme();

    soundRow = document.createElement('div');
    soundRow.className = 'editor-sound';
    sec.appendChild(soundRow);
    renderSound();

    // ── 输入方式：滑动 / 摇晃 可各自关掉 ──
    const inputRow = document.createElement('div');
    inputRow.className = 'editor-sound';

    const swipe = toggle('滑动投掷', settings.swipeOn, (on) => {
      settings.swipeOn = on;
      opts.save();
    });
    inputRow.appendChild(swipe);

    const shake = toggle('摇晃投掷', settings.shakeOn, (on) => {
      settings.shakeOn = on;
      opts.save();
      opts.onShakeToggle?.(on);
    });
    inputRow.appendChild(shake);

    sec.appendChild(inputRow);

    return sec;
  }

  function buildYesMapping() {
    const group = document.createElement('div');
    group.className = 'editor-field';

    const label = document.createElement('label');
    label.className = 'editor-label';
    label.textContent = '单颗骰子的「是／否」';

    const seg = document.createElement('div');
    seg.className = 'editor-seg';
    const options = [
      { id: 'high', text: '点数 ≥ 4' },
      { id: 'oddEven', text: '奇数' },
    ];
    for (const o of options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'editor-seg-btn';
      b.classList.toggle('on', settings.yesMapping === o.id);
      b.textContent = o.text;
      b.addEventListener('click', () => {
        settings.yesMapping = o.id;
        opts.save();
        for (const s of seg.querySelectorAll('.editor-seg-btn')) {
          s.classList.toggle('on', s === b);
        }
      });
      seg.appendChild(b);
    }

    group.append(label, seg);
    return group;
  }

  function renderTheme() {
    if (!themeWrap) return;
    themeWrap.replaceChildren();
    for (const id of THEME_IDS) {
      const t = getTheme(id);
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'editor-theme';
      card.classList.toggle('on', settings.theme === id);
      const sw = document.createElement('span');
      sw.className = 'editor-theme-swatch';
      sw.style.background = t.css['--bg'];
      const name = document.createElement('span');
      name.textContent = t.label;
      card.append(sw, name);
      card.addEventListener('click', () => {
        settings.theme = id;
        opts.save();
        opts.onTheme(id);
        renderTheme();
      });
      themeWrap.appendChild(card);
    }
  }

  function renderSound() {
    if (!soundRow) return;
    soundRow.replaceChildren();

    const sound = toggle('声音', settings.soundOn, (on) => {
      settings.soundOn = on;
      opts.save();
      opts.onSenses();
      renderSound();
    });
    soundRow.appendChild(sound);

    if (settings.soundOn) {
      soundRow.appendChild(volume('音量', settings.sfxVolume, (v) => {
        settings.sfxVolume = v;
        opts.save();
        opts.onSenses();
      }));
    }

    const amb = toggle('环境音', settings.ambienceOn, (on) => {
      settings.ambienceOn = on;
      opts.save();
      opts.onSenses();
      renderSound();
    });
    soundRow.appendChild(amb);

    if (settings.soundOn && settings.ambienceOn) {
      const kindRow = document.createElement('div');
      kindRow.className = 'editor-field';

      const label = document.createElement('label');
      label.className = 'editor-label';
      label.textContent = '环境音类型';

      const seg = document.createElement('div');
      seg.className = 'editor-seg';
      for (const k of AMB_KINDS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'editor-seg-btn';
        b.classList.toggle('on', settings.ambienceKind === k.id);
        b.textContent = k.label;
        b.addEventListener('click', () => {
          settings.ambienceKind = k.id;
          opts.save();
          opts.onSenses();
          for (const s of seg.querySelectorAll('.editor-seg-btn')) {
            s.classList.toggle('on', s === b);
          }
        });
        seg.appendChild(b);
      }

      kindRow.append(label, seg);
      soundRow.appendChild(kindRow);

      soundRow.appendChild(volume('环境音量', settings.ambienceVolume, (v) => {
        settings.ambienceVolume = v;
        opts.save();
        opts.onSenses();
      }));
    }
  }

  function buildHaptics() {
    const sec = section('触觉');
    hapticRow = document.createElement('div');
    hapticRow.className = 'editor-haptics';
    const t = toggle('震动反馈', settings.hapticsOn, (on) => {
      settings.hapticsOn = on;
      opts.save();
      opts.onSenses();
    });
    hapticRow.appendChild(t);
    sec.appendChild(hapticRow);
    return sec;
  }

  function buildData() {
    const sec = section('数据');

    const btns = document.createElement('div');
    btns.className = 'editor-row-btns';

    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'editor-data-btn';
    exportBtn.textContent = '导出设置';
    exportBtn.addEventListener('click', () => downloadExport());

    const importBtn = document.createElement('button');
    importBtn.type = 'button';
    importBtn.className = 'editor-data-btn';
    importBtn.textContent = '导入设置';
    importBtn.addEventListener('click', () => promptImport());

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'editor-data-btn danger';
    clearBtn.textContent = '清除所有';
    clearBtn.addEventListener('click', () => {
      if (window.confirm('清除本机保存的骰子设置？')) {
        clearStore();
        location.reload();
      }
    });

    btns.append(exportBtn, importBtn, clearBtn);
    sec.appendChild(btns);
    return sec;
  }

  // ── 私有小构件 ────────────────────────────────────────

  function section(title) {
    const sec = document.createElement('section');
    sec.className = 'editor-section';
    const h = document.createElement('h3');
    h.className = 'editor-section-title';
    h.textContent = title;
    sec.appendChild(h);
    return sec;
  }

  function toggle(labelText, initial, onToggle) {
    const field = document.createElement('div');
    field.className = 'editor-field toggle-field';

    const label = document.createElement('span');
    label.textContent = labelText;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'editor-toggle';
    btn.setAttribute('role', 'switch');
    btn.setAttribute('aria-checked', String(initial));
    btn.classList.toggle('on', initial);
    btn.addEventListener('click', () => {
      const next = !btn.classList.contains('on');
      btn.classList.toggle('on', next);
      btn.setAttribute('aria-checked', String(next));
      onToggle(next);
    });

    field.append(label, btn);
    return field;
  }

  function volume(labelText, initial, onInput) {
    const field = document.createElement('div');
    field.className = 'editor-field vol-field';

    const label = document.createElement('span');
    label.className = 'editor-label';
    label.textContent = labelText;

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '1';
    slider.step = '0.05';
    slider.value = String(initial);
    slider.addEventListener('input', () => {
      onInput(Number(slider.value));
    });

    field.append(label, slider);
    return field;
  }

  function downloadExport() {
    const json = exportJson(settings);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'dice-settings.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function promptImport() {
    const text = window.prompt('粘贴之前导出的设置 JSON');
    if (!text) return;
    try {
      const next = importJson(text);
      Object.assign(settings, next);
      opts.save();
      opts.onTheme(settings.theme);
      opts.onReline();
      opts.onSenses();
      visibleOptions = Math.max(settings.diceCount, 1);
      location.reload();
    } catch (err) {
      window.alert('导入失败：' + (err?.message || err));
    }
  }

  return { open, close };
}