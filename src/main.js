/**
 * 启动序列。整个 app 的装配点。
 *
 * 顺序是有讲究的，不是随手排的：
 *
 *   t0  能力检测 → 读设置 → applyCss
 *       CSS 必须第一个生效。它在 WebGL 就绪之前就要把页面染成主题色，
 *       否则用户会看到一瞬白底 —— 在暗室主题下这一瞬格外刺眼。
 *
 *   t1  用户点"开始" → unlockSenses()
 *       音频上下文、震动探针、DeviceMotion 授权，三样一起拿
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
 * ⚠️ 为什么保留"开始"按钮：音频解锁、DeviceMotion 授权、
 *    navigator.vibrate 三者都要求用户手势，而且必须落在同一个同步栈里。
 *    甩动路径下投掷发生在 devicemotion 回调里 —— 那不是手势，只能靠
 *    sticky activation 撑住。一次点击同时拿齐三样，是最省事的做法。
 *    按钮的另一个作用是节奏：先静一下，再开始。
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
import { on } from './core/bus.js';
import { add as addRaf } from './core/raf.js';
import { PHYSICS, dieScaleFor } from './config.js';
import { MATERIAL_IDS } from './materials.js';

// ── 感官层 ──
import {
  unlock as unlockAudio,
  getContext,
  setSfxVolume,
  setAmbVolume,
  setMuted,
  getStats as audioStats,
} from './audio/engine.js';
import { warmup as warmupSfx, useMaterial as setSfxMaterial, clearVoices, getStats as sfxStats } from './audio/impact.js';
import { bakeIdle } from './audio/bake.js';
import { createAmbience, AMB_LEVELS } from './audio/ambience.js';
import {
  probe as probeHaptics,
  isAvailable as isHapticsAvailable,
  impact as hapticImpact,
  settle as hapticSettle,
  setEnabled as setHapticsEnabled,
  handleVisibility as hapticsVisibility,
  getStats as hapticStats,
} from './haptics.js';
import {
  enable as enableShake,
  disable as disableShake,
  suppress as suppressShake,
  isSupported as isShakeSupported,
  getStats as shakeStats,
} from './input/shake.js';
import { buildShell } from './ui/shell.js';
import { initChips } from './ui/chips.js';
import { initResultCard } from './ui/result-card.js';
import { initPeekNames } from './ui/peek-names.js';
import { initEditor } from './ui/editor.js';
import { initDebugPanel, attachDebugToggle } from './ui/debug-panel.js';
import { runSelfTest } from './selftest.js';

const params = new URLSearchParams(location.search);
const caps = detect();
const settings = load();

// 环境音的常开档位。用户要的是"开始就有、一直到关闭"，所以平时维持一个
// 稳定基线，不跟着甩动/投掷升高；只在揭晓一瞬间轻降一点留个性，不回 0。
const AMBIENCE_STEADY = 0.5;
const AMBIENCE_REVEAL_DIP = 0.2;

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

    // ⚠️ 必须在手势的**同步栈**里跑完，而且要在 start() 之前 ——
    //    start() 里的建场景、造骰子、预编译是几十到几百毫秒的同步计算，
    //    放在它后面的话手势激活可能已经被耗掉了。见 unlockSenses 的注释
    unlockSenses();
    start();
  }, { once: true });
}

/**
 * 三样只有用户手势才能拿到的东西：音频上下文、震动探针、运动授权。
 *
 * ⚠️ 它们必须落在**同一个同步栈**里，理由各不相同：
 *    ① AudioContext 在非手势栈里建会被某些浏览器建在 suspended 状态；
 *    ② navigator.vibrate 在部分 Android 上要求 sticky activation；
 *    ③ iOS 的 DeviceMotionEvent.requestPermission() 会拒绝非手势调用。
 *
 * ⚠️ 三步的顺序不能变：音频排第一。它的 create() + resume() 是这里
 *    唯一有真实耗时的（首次要建音频线程），放最后可能已经被前两步
 *    挤出激活窗口。震动和运动授权只是几十微秒的调用。
 *
 * 任何一步失败都**只降级**：没有声音就静音掷，没有马达就不震，
 * 运动被拒就只留滑动和点击。这条链上没有一个 return。
 */
function unlockSenses() {
  unlockAudio();

  // 探针。navigator.vibrate 存在 ≠ 真的会震（有些平板有 API 没马达），
  // 而"API 存在但一调就抛"的设备只有真调一次才知道
  if (settings.hapticsOn && caps.canVibrate) probeHaptics();

  // enable() 是 async，但 requestPermission() 落在第一个 await 之前，
  // 所以同步调它就等于在栈里发出请求。故意不 await ——
  // 等授权结果会把 start() 推到手势之外
  if (caps.canMotion && settings.shakeOn) {
    enableShake().catch(() => {
      /* enable 自己绝不 reject，这里是第二道保险 */
    });
  }
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

  // senses 要在 chips 之前拿到：换材质的回调里要用它
  const senses = createSenses();

  // 骰子飞在半空时重建会留下一地残影，所以只在静置状态接受改动。
  // chips 自己不禁用 —— 禁用了要等一局结束才生效，那更让人困惑
  const canChange = () => flow.state === 'IDLE' || flow.state === 'RESULT';

  // 编辑页里改选项/命名/颗数要重建骰子；若恰逢骰子在半空，先记下来，
  // 等回 IDLE/RESULT 再补重建 —— 否则 edits 会留下一地残影
  let relinePending = false;
  const requestReline = () => {
    if (canChange()) applyChange();
    else relinePending = true;
  };
  on('flow:change', ({ to }) => {
    if ((to === 'IDLE' || to === 'RESULT') && relinePending) {
      relinePending = false;
      applyChange();
    }
  });

  // 主题是跨场景的：CSS 变量（编辑页自己也算页面的一部分，得当场换肤）、
  // 灯光/托盘/环境、以及骰子材质的覆盖系数，三者一起换
  const applyTheme = (id) => {
    applyCss(id);
    applySceneTheme(id, caps.tier, { fade: true });
    applyMaterialOverrides(id, dice);
    save(settings);
  };

  const chips = initChips(shell.chips, {
    settings,
    onMaterial: (id) => {
      if (settings.material === id || !canChange()) return;
      settings.material = id;
      applyChange();
      // 换了材质，碰撞音要跟着换 —— 不然玉石的骰子会一直用塑料的声音
      senses.useMaterial(id);
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
  initInput(canvas, { getSwipeOn: () => settings.swipeOn });

  // 摇晃投掷开关：关掉就卸下 devicemotion 监听，省电也避免揣兜误触发；
  // 再开则重新启用（已授权则直接挂上，未授权重新请求）
  const applyShake = (on) => {
    if (!caps.canMotion) return;
    if (on) {
      if (!isShakeSupported()) {
        enableShake().catch(() => {
          /* enable 绝不 reject，这里是第二道保险 */
        });
      }
    } else {
      disableShake();
    }
  };

  const editor = initEditor(root, {
    settings,
    caps,
    save,
    onReline: requestReline,
    onTheme: applyTheme,
    onSenses: () => senses.applySettings(),
    onShakeToggle: applyShake,
  });
  shell.settingsBtn.addEventListener('click', () => editor.open());

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
        extra: formatSenses(senses.getStats()),
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

// ─────────────────────────────────────────────────────────────
// 感官层接线：声音、震动、甩动
//
// 这一段全是**策略**，不是机制。模块自己只管"怎么发声"、"怎么震"、
// "怎么从加速度里认出一次甩动"；"什么时候该发"在这里定。
// 写在 main.js 而不是某个模块里，是因为模块之间不许互相 import ——
// 它们只通过 bus 说话，装配点才认识所有人。
// ─────────────────────────────────────────────────────────────

function createSenses() {
  // 把设置里的初值套上。P3 的设置面板之后从这里改
  setSfxVolume(settings.sfxVolume);
  setAmbVolume(settings.ambienceVolume);
  setMuted(!settings.soundOn);
  // ⚠️ 震动开关取 `用户设置 && 探针结果`。用户开了但设备没马达时
  //    开关保持关闭 —— UI 据此决定要不要显示这一项
  setHapticsEnabled(settings.hapticsOn && isHapticsAvailable());

  const ctx = getContext();
  const wantSound = !!ctx && settings.soundOn;

  let ambience = null;
  if (wantSound) {
    // 当前材质的碰撞音**现在就得烘**，不能等第一次投掷 ——
    // 烘一份要几十毫秒，那段时间里掷出去的骰子是哑的
    warmupSfx(settings.material, ctx).catch((err) => {
      console.warn('[main] 碰撞音烘焙失败，本次会话无声', err);
    });
    // 其余材质交给空闲时间。用户切到哪种，哪种已经是热的
    bakeIdle(MATERIAL_IDS, ctx);

    if (settings.ambienceOn) {
      ambience = createAmbience();
      if (ambience) {
        ambience.setKind(settings.ambienceKind);
        ambience.start();
        // 从 0 升上来，不是"啪"地开始。用户刚点完"开始"，
        // 雨该像慢慢下起来，而不是被开关拨亮
        ambience.fadeTo(AMB_LEVELS.IDLE, 1200);
      }
    }
  }

  // ── 碰撞 ──

  // 碰撞音由 impact.js 自己订阅 'impact'（它 init() 过了），
  // 这里只接震动 —— 所以不要在这里再 init 一次，那会双重订阅
  on('impact', (e) => {
    // 强度归一化成 0..1 再交给触觉：震动模块不认 m/s 这种单位，
    // 它只要"这一下有多重"。不减去 impactMinSpeed —— 低于那个阈值的
    // 碰撞根本不会发出来，所以起点本来就不在 0
    hapticImpact(e.materialId, clamp(e.speed / PHYSICS.impactMaxSpeed, 0, 1));
  });

  // ── 投掷 ──

  on('throw:start', ({ source }) => {
    // 上一局的余音不该混进这一局
    clearVoices();
    // 点击/滑动掷完之后手还没停稳，那点晃动不该再触发一次甩动
    if (source !== 'shake') suppressShake();
  });

  // ── 状态机 → 环境音 ──

  on('flow:change', ({ to }) => {
    if (!ambience) return;
    // 环境音常开：平时维持一个稳定基线。揭晓一瞬间轻降(不静音)留一点
    // 节奏，揭晓完回 IDLE 时再回到基线。甩动/投掷不再加油量。
    // 斜坡长度取 pauseMs：轻降正好落在结果浮出那一刻四周。
    const reveal = to === 'SETTLING' || to === 'RESULT';
    ambience.start(); // 幂等；这是切后台回前台之后的恢复点
    ambience.fadeTo(reveal ? AMBIENCE_REVEAL_DIP : AMBIENCE_STEADY, reveal ? settings.pauseMs : 320);
  });

  // ── 落定 → 触觉签名 ──

  on('dice:settled', () => {
    // 三连脉冲。用户不看屏幕也知道结果出来了
    hapticSettle(settings.material);
  });

  // ── 甩动 ──

  on('shake:arming', () => flow.go('ARMING'));
  on('shake:disarm', () => flow.go('IDLE'));
  on('shake:throw', ({ power }) => {
    // 甩动没有屏幕方向可言，dirX/dirZ 留 0（力全部落在竖直面上）
    flow.toss({ power, dirX: 0, dirZ: 0, source: 'shake' });
  });

  // 环境音的落定回弹：切到后台停、回到前台靠 flow:change 补 start()（见下）。
  // 注意：这里**故意不再接 shake:energy**。雨声不该跟着甩动升高 ——
  // 否则甩一下就只有"雨声变亮"这一种声音，骰子材质的撞击音反被盖住，
  // 用户会觉得"晃动的声音跟材质对不上"。甩动的意思是掷骰，掷出来的
  // 是材质撞击音，而不是环境的雨。环境音保持平稳即可。

  // 手机揣兜里不该还一震一震的 —— 用户会以为程序出问题了
  document.addEventListener('visibilitychange', hapticsVisibility);

  return {
    /**
     * 换材质。碰撞音要跟着换，不然玉石的骰子会一直用塑料的声音。
     * 烘是异步的，烘好之前 impact.js 会静默跳过 —— 那是对的：
     * 补一声迟到的闷响比不响更糟。
     */
    useMaterial(id) {
      if (!ctx) return;
      setSfxMaterial(id);
      warmupSfx(id, ctx).catch(() => {});
    },

    /**
     * 编辑页改设置后即时生效。只做"要不要开、开哪种、开多响"，
     * 不重建骰子 —— 那些走 onReline。
     */
    applySettings() {
      setSfxVolume(settings.sfxVolume);
      setAmbVolume(settings.ambienceVolume);
      setMuted(!settings.soundOn);
      setHapticsEnabled(settings.hapticsOn && isHapticsAvailable());

      const want = settings.soundOn && settings.ambienceOn;
      if (want && !ambience) {
        const a = createAmbience();
        if (a) {
          ambience = a;
          a.setKind(settings.ambienceKind);
          a.start();
          // 当场补上当前状态应该有的档位，别从 0 干等状态机来推
          const st = flow?.state;
          a.fadeTo((st === 'SETTLING' || st === 'RESULT') ? AMBIENCE_REVEAL_DIP : AMBIENCE_STEADY, 220);
        }
      } else if (!want && ambience) {
        ambience.stop();
        ambience = null;
      } else if (ambience) {
        ambience.setKind(settings.ambienceKind);
      }
    },

    getStats() {
      return {
        ...audioStats(),
        ...sfxStats(),
        ...hapticStats(),
        shake: shakeStats(),
        amb: ambience?.getStats(),
      };
    },
  };
}

/**
 * `?debug=1` 里感官层那两行。
 *
 * 压成两行是有意的：这个面板贴在小屏手机上，多一行就盖住一颗骰子。
 * 每个字段都是**光看界面看不出来**的东西 —— 声部的并发数（泄漏时
 * 会一直涨）、环境音的实际增益对目标增益（斜坡卡住时两者不收敛）、
 * 震动是不是被限流或退避了、甩动停在哪个状态。
 */
function formatSenses(st) {
  const a = st.amb;
  const amb = a ? `${a.kind} ${a.gain}/${a.target} ${a.liveDrops}滴` : '环境音关';
  const hap = st.available ? (st.enabled ? `震${st.calls}` : '震关') : '无马达';
  const sh = st.shake;
  // 上下文状态排在最前：声音不出来时第一个要问的就是这个 ——
  // 是 ctx 没跑（suspended），还是跑了但增益是 0，两者处理完全不同。
  // 后面 `p` 是累计播放数（见 impact.js 的 playedTotal），"未烘"是
  // 波形还没造好 —— 这个状态下 impact 是静默跳过的
  const sfx = `${st.live}/${st.max} p${st.played}${st.ready ? '' : ' 未烘'}`;
  return `音 ${st.state} · sfx ${sfx} · ${amb}\n${hap} · 甩 ${sh.state} ${sh.permission} e${sh.energy} l${sh.level}`;
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

  // 骰子多了就整体缩小，让固定托盘装得下（N≤4 不缩，=1）
  const size = dieScaleFor(settings.diceCount);

  // 每颗骰子代表的选项：对决 = 第 i 颗对第 i 项；多数决 = assignment 或自动 i % N
  const filled = (settings.options || []).map((s) => (s || '').trim()).filter(Boolean);
  const F = filled.length;
  const assignedIdx = (i) => {
    if (!F) return -1;
    if (settings.decisionMode === 'vote') {
      const a = Number(settings.assignment?.[i]);
      const idx = Number.isInteger(a) && a >= 0 ? a : i % F;
      return Math.max(0, Math.min(F - 1, idx));
    }
    return Math.min(F - 1, i);   // duel：一骰一选项
  };

  for (let i = 0; i < settings.diceCount; i++) {
    const idx = assignedIdx(i);
    const d = createDie({
      materialId: settings.material,
      slot: i,
      world,
      size,
      name: (settings.names[i] || '').trim(),
      option: idx >= 0 ? filled[idx] : '',
      color: settings.colors?.[i] || '',
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
 * ⚠️ 间距必须大于骰子边长。1–4 颗用下面的固定摆法（骰子此时不缩放，边长 1），
 *    5–12 颗骰子缩小了（dieScaleFor），改用网格铺开，同样保证不漏空不重叠。
 */
const LAYOUT = {
  1: [[0, 0]],
  2: [[-0.8, 0], [0.8, 0]],
  3: [[-1.35, 0], [0, 0], [1.35, 0]],
  4: [[-0.72, -0.72], [0.72, -0.72], [-0.72, 0.72], [0.72, 0.72]],
};

/** 5+ 颗：正方形网格，居中铺在托盘里（保持间距 = 边长×1.05） */
function gridSpots(N, half) {
  const cols = Math.ceil(Math.sqrt(N));
  const spacing = half * 2 * 1.05;
  const rows = Math.ceil(N / cols);
  const offX = ((cols - 1) * spacing) / 2;
  const offZ = ((rows - 1) * spacing) / 2;
  const spots = [];
  for (let i = 0; i < N; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    spots.push([c * spacing - offX, r * spacing - offZ]);
  }
  return spots;
}

function restDice() {
  const n = dice.length;
  const half = PHYSICS.dieHalf * dieScaleFor(n);
  const fixed = LAYOUT[n];
  const spots = fixed || gridSpots(n, half);

  for (let i = 0; i < n; i++) {
    const b = dice[i].body;
    const [x, z] = spots[i];

    b.position.set(x, half, z);
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
