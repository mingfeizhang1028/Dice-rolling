/**
 * 启动序列。整个 app 的装配点。
 *
 * 顺序是有讲究的，不是随手排的：
 *
 *   t0  能力检测 → 读设置 → applyCss
 *       CSS 必须第一个生效。它在 WebGL 就绪之前就要把页面染成主题色，
 *       否则用户会看到一瞬白底 —— 在暗室主题下这一瞬格外刺眼。
 *
 *   t1  用户点"开始"
 *
 *   t2  createView → createWorld → 造骰子 → 挂主题
 *       骰子要在挂主题之前造好，applyMaterialOverrides 才有东西可作用
 *
 *   t3  precompile()
 *       着色器预编译。不调这个，第一次投掷会卡 200-400ms ——
 *       而那恰恰是用户最专注的一刻
 *
 *   t4  flow.go('IDLE') + 显示 UI
 *
 * ⚠️ 为什么保留"开始"按钮：P2 的音频解锁、DeviceMotion 授权、
 *    navigator.vibrate 三者都要求用户手势，而且必须落在同一个同步栈里。
 *    甩动路径下投掷发生在 devicemotion 回调里 —— 那不是手势，只能靠
 *    sticky activation 撑住。一次点击同时拿齐三样，是最省事的做法。
 *    现在还没有音频，按钮的另一个作用是节奏：先静一下，再开始。
 *
 * ⚠️ 任何一步失败都只降级、不阻断。这个文件里没有一条路径会导致白屏。
 */

import { detect } from './capability.js';
import { load, save, isPersistent } from './store.js';
import { applyCss, applySceneTheme, applyMaterialOverrides } from './scene/apply-theme.js';
import { createView, render, precompile, getScene } from './scene/view.js';
import { createWorld, stepWorld, getWorld } from './physics/world.js';
import { createDie, disposeDice } from './dice/die.js';
import { createFlow, MAX_DICE } from './flow.js';
import { initInput } from './input/index.js';
import { add as addRaf } from './core/raf.js';
import { buildShell } from './ui/shell.js';
import { initChips } from './ui/chips.js';
import { initResultCard } from './ui/result-card.js';
import { initPeekNames } from './ui/peek-names.js';
import { initDebugPanel, attachDebugToggle } from './ui/debug-panel.js';
import { runSelfTest } from './selftest.js';

const params = new URLSearchParams(location.search);
const caps = detect();
const settings = load();

const canvas = document.getElementById('stage');
const root = document.body;

let dice = [];
let flow = null;

// ─────────────────────────────────────────────────────────────
// 出错时不要白屏。
// 一个纯黑页面什么都不说，用户只能以为"坏了"；一句人话至少能自救
// ─────────────────────────────────────────────────────────────
function fatal(err) {
  console.error('[main] 启动失败', err);

  const box = document.createElement('div');
  box.className = 'fatal';

  const title = document.createElement('p');
  title.textContent = '骰子没能启动';

  const detail = document.createElement('pre');
  detail.textContent = String(err?.message || err);

  const reload = document.createElement('button');
  reload.type = 'button';
  reload.textContent = '重试';
  reload.addEventListener('click', () => location.reload());

  box.append(title, detail, reload);
  root.appendChild(box);
}

// 启动完成之后再出错就别弹面板了 —— 那多半是某一帧的小问题，
// 弹出来反而把正在看的骰子盖住
window.addEventListener('error', (e) => {
  if (flow) return;
  // 资源加载失败（图片、字体）也走这个事件，但 e.error 和 e.message 都是空的。
  // 不判一下就会弹出一个写着 "undefined" 的致命面板
  const detail = e.error || (e.message ? `${e.message}${e.filename ? ` @ ${e.filename}:${e.lineno}` : ''}` : null);
  if (detail) fatal(detail);
});
window.addEventListener('unhandledrejection', (e) => {
  if (!flow && e.reason) fatal(e.reason);
});

// ─────────────────────────────────────────────────────────────

if (params.has('selftest')) {
  runBrowserSelfTest();
} else {
  applyCss(settings.theme);   // 必须最先生效，早于任何 await
  wireGate();
}

/**
 * ⚠️ boot 是同步的，所以这里必须 try/catch，不能写成 boot().catch()。
 *    同步函数返回 undefined，.catch 会在**启动成功之后**抛 TypeError ——
 *    一个「一切正常却每次都报错」的 bug，特别容易被忽略过去。
 */
function start() {
  try {
    boot();
  } catch (err) {
    fatal(err);
  }
}

function wireGate() {
  const gate = document.getElementById('gate');
  const btn = document.getElementById('start');

  // 没有 gate（改过的 HTML、或者以后去掉）就直接进
  if (!gate || !btn) {
    start();
    return;
  }

  btn.addEventListener('click', () => {
    gate.classList.add('gone');
    // 淡出之后再移除，否则按钮会"啪"地消失
    setTimeout(() => gate.remove(), 600);
    start();
  }, { once: true });
}

function boot() {
  createView(canvas, caps.tier);
  createWorld();

  rebuildDice();               // 先有骰子，applyMaterialOverrides 才有对象
  applySceneTheme(settings.theme, caps.tier, { fade: false });
  applyMaterialOverrides(settings.theme, dice);

  // 预编译要在骰子和主题都进场景之后调，否则编不到骰子的着色器
  precompile();

  flow = createFlow({ getDice: () => dice, settings });

  const shell = buildShell(root, caps);

  const applyChange = () => {
    rebuildDice();
    applyMaterialOverrides(settings.theme, dice);
    chips.render();
    save(settings);
  };

  // 骰子飞在半空时重建会留下一地残影，所以只在静置状态接受改动。
  // chips 自己不禁用 —— 禁用了要等一局结束才生效，那更让人困惑
  const canChange = () => flow.state === 'IDLE' || flow.state === 'RESULT';

  const chips = initChips(shell.chips, {
    settings,
    onMaterial: (id) => {
      if (settings.material === id || !canChange()) return;
      settings.material = id;
      applyChange();
    },
    onCount: (delta) => {
      const next = clamp(settings.diceCount + delta, 1, MAX_DICE);
      if (next === settings.diceCount || !canChange()) return;
      settings.diceCount = next;
      applyChange();
    },
  });

  initResultCard(shell.result);
  initPeekNames(shell.peek, { getDice: () => dice });
  initInput(canvas);

  // 存储不可用时说一声。悄悄不保存是最让人恼火的失败方式
  if (!isPersistent()) {
    const warn = document.createElement('p');
    warn.className = 'hint storage-warn';
    warn.textContent = '本次改动不会被保存';
    shell.ui.querySelector('.ui-bottom').appendChild(warn);
  }

  if (params.has('debug')) {
    const panel = initDebugPanel(root, {
      getState: () => ({
        flow: flow.state,
        dice: dice.length,
        physMs: lastPhysMs,
      }),
    });
    attachDebugToggle(panel.el);
  }

  addRaf((dt, now) => {
    const a = performance.now();
    stepWorld(dt);
    lastPhysMs = performance.now() - a;

    flow.update(dt, now);
    render();
  });

  shell.show();
  flow.go('IDLE');

  /**
   * 开发期调试钩子。**生产构建里整段会被摇掉** —— import.meta.env.DEV
   * 在 build 时是常量 false，条件恒假。
   *
   * 存在的理由：有几条分支光靠点界面走不到。并列要掷出两个相同的最高点，
   * 而选项输入和命名界面要到 P3 才有 —— 在那之前，"有选项"和"并列"
   * 这两条路在浏览器里根本进不去，只能靠预置 localStorage 绕。
   * 有了这个钩子就能把骰子直接摆成想要的点数，再调 flow.resolve()
   * 走完整条真实链路，而不是手搓一个结果对象喂给渲染层。
   *
   * dice 用 getter 取：rebuildDice() 会整个换掉数组，
   * 存一份引用的话改颗数之后就指向旧骰子了。
   */
  if (import.meta.env.DEV) {
    window.__dice = {
      get flow() { return flow; },
      get dice() { return dice; },
      settings,
    };
  }

  console.log(`[main] 就绪 · tier=${caps.tier} · ${caps.canVibrate ? '可震动' : '无震动'}`);
}

let lastPhysMs = 0;

/**
 * 重建全部骰子。
 *
 * 改颗数、改材质、改名字都走这里。共用的几何体和材质是缓存过的
 * （见 die.js），所以重建的代价只有新建刚体和 mesh 本身。
 */
function rebuildDice() {
  const scene = getScene();
  const world = getWorld();

  disposeDice(dice);
  dice = [];

  if (!world) return;

  for (let i = 0; i < settings.diceCount; i++) {
    const d = createDie({
      materialId: settings.material,
      slot: i,
      world,
      name: (settings.names[i] || '').trim(),
    });
    if (scene) scene.add(d.group);
    dice.push(d);
  }

  restDice();
}

/**
 * 开局的静置摆位。
 *
 * 两个目的：① 不要从出生高度掉下来 —— 开局"啪"掉几颗骰子会把静气打散；
 * ② 彼此不能重叠。
 *
 * ⚠️ 间距必须大于骰子边长（1.0）。早先用 `t * 0.8` 沿一条线排，
 *    四颗时相邻距离只有 0.96 —— 比骰子还窄，开局是几颗互相插在一起的
 *    骰子，物理一启动就"砰"地弹开。这种错误在静态截图里不明显，
 *    但用户第一眼就会看到。
 *
 * 三颗排成一行、四颗排成 2×2：都是"一副骰子"的自然摆法，
 * 而且最小间距 1.35 / 1.44 都留出了肉眼可见的缝。
 */
const LAYOUT = {
  1: [[0, 0]],
  2: [[-0.8, 0], [0.8, 0]],
  3: [[-1.35, 0], [0, 0], [1.35, 0]],
  4: [[-0.72, -0.72], [0.72, -0.72], [-0.72, 0.72], [0.72, 0.72]],
};

function restDice() {
  const spots = LAYOUT[dice.length];
  if (!spots) return;

  for (let i = 0; i < dice.length; i++) {
    const b = dice[i].body;
    const [x, z] = spots[i];

    b.position.set(x, 0.5, z);
    b.velocity.setZero();
    b.angularVelocity.setZero();
    b.force.setZero();
    b.torque.setZero();

    // 绕竖轴随机转，保证还是有一个面正好朝上（不然骰子开局是歪的）
    b.quaternion.setFromEuler(0, Math.random() * Math.PI * 2, 0);
    b.wakeUp();
    dice[i].sync();
  }
}

// ─────────────────────────────────────────────────────────────

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// ─────────────────────────────────────────────────────────────
// 浏览器内的自测。?selftest=1
// 只跑测试，不建场景 —— runSelfTest 自己另开一个物理世界
// ─────────────────────────────────────────────────────────────

function runBrowserSelfTest() {
  const out = document.createElement('pre');
  out.className = 'selftest-out';
  document.body.appendChild(out);

  const lines = [];
  const log = (s) => {
    lines.push(String(s));
    out.textContent = lines.join('\n');
    out.scrollTop = out.scrollHeight;
  };

  const throws = Number(params.get('throws')) || 200;
  const diceCount = Number(params.get('dice')) || Number(settings.diceCount) || 1;
  const materialId = params.get('material') || settings.material;

  // 让出两帧，先把"正在跑"画出来。同步跑 200 次投掷要几百毫秒，
  // 不这么做用户看到的是白屏而不是进度
  requestAnimationFrame(() => requestAnimationFrame(() => {
    let result;
    try {
      result = runSelfTest({ throws, diceCount, materialId, log });
    } catch (err) {
      log(`\n✗ 自测抛出异常：${err?.message || err}`);
      console.error(err);
      document.title = '✗ 自测异常';
      return;
    }
    document.title = result.ok ? '✓ 自测通过' : '✗ 自测失败';
  }));
}
