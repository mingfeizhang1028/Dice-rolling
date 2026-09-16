/**
 * 界面骨架。
 *
 * 主界面上只有三样东西：骰子、一条提示、角落一个圆点。
 * 材质和颗数的 chip 行在顶部，但它是低对比度的，不抢骰子。
 * 其余一律收进设置抽屉（P3）。
 *
 * ⚠️ 所有用户数据（名字、选项）一律用 textContent 写入，绝不用 innerHTML。
 *    innerHTML 在这里没有任何好处，却能把自己输的选项变成标签。
 */

export function buildShell(root, caps) {
  const ui = document.createElement('div');
  ui.className = 'ui';

  // 静态模板。这里面没有任何用户数据，用 innerHTML 是安全的
  ui.innerHTML = `
    <div class="ui-top">
      <div class="chips" id="chips"></div>
    </div>
    <div class="ui-bottom">
      <div class="result" id="result" aria-live="polite"></div>
      <p class="hint" id="hint"></p>
    </div>
    <div class="peek" id="peek" hidden></div>
    <button class="corner-btn" id="settings" type="button" aria-label="设置">
      <span class="corner-dot"></span>
    </button>
  `;

  root.appendChild(ui);

  const hint = ui.querySelector('#hint');
  // 提示文案按能力给。说了做不到的话，比不说更让人烦
  if (caps.isTouch && caps.canMotion) hint.textContent = '晃晃手机，或滑动投掷';
  else if (caps.isTouch) hint.textContent = '滑动投掷';
  else hint.textContent = '空格投掷';

  return {
    ui,
    chips: ui.querySelector('#chips'),
    result: ui.querySelector('#result'),
    hint,
    peek: ui.querySelector('#peek'),
    settingsBtn: ui.querySelector('#settings'),
    show() {
      ui.classList.add('ready');
    },
  };
}

export function destroyShell(root) {
  root.querySelector('.ui')?.remove();
}
