/**
 * 用 CDP 驱动本机 Edge，把页面真正跑起来看一眼。
 *
 * 为什么不用 playwright：这个机器上没装 playwright 的 npm 包，
 * 但 Edge 是有的，而 node 24 自带 WebSocket —— 直接用 CDP 零依赖。
 *
 * 用法：
 *   node tools/shot.mjs                      # 首页，点开始，截图
 *   node tools/shot.mjs '?selftest=1&dice=3' # 跑自测并抓输出
 *   node tools/shot.mjs '' 3000 swipe 3      # 滑一把，等结果，截 3 颗的图
 */

import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9333;
const BASE = 'http://localhost:5173/';

const query = process.argv[2] ?? '';
const waitMs = Number(process.argv[3] || 3000);
const outName = process.argv[4] || 'shot';
const gesture = process.argv[5] || '';   // '' | 'swipe' | 'tap' | 'peek'
const diceCount = process.argv[6] || ''; // 投掷前把颗数调上去
const seedRaw = process.argv[7] || '';   // JSON，预置到 localStorage 的设置

let seed = null;
if (seedRaw) {
  try {
    seed = JSON.parse(seedRaw);
  } catch (err) {
    console.error('第 7 个参数不是合法 JSON：', err.message);
    process.exit(2);
  }
}

const profile = `${process.env.TEMP || '/tmp'}/dice-cdp-profile`;

const child = spawn(EDGE, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--hide-scrollbars',
  // 无头环境没有 GPU，WebGL 走 SwiftShader 软渲染。
  // 不开这两个开关的话 canvas 会直接是黑的
  '--enable-unsafe-swiftshader',
  '--use-angle=swiftshader',
  'about:blank',
], { stdio: 'ignore' });

let ws = null;

try {
  const target = await findTarget();
  ws = new WebSocket(target);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });

  const logs = [];
  const errors = [];
  let msgId = 0;
  const pending = new Map();

  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);

    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
      return;
    }

    if (m.method === 'Runtime.consoleAPICalled') {
      const text = (m.params.args || [])
        .map((a) => a.value ?? a.description ?? a.type)
        .join(' ');
      logs.push(`[${m.params.type}] ${text}`);
    }

    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      errors.push(d.exception?.description || d.text);
    }

    if (m.method === 'Log.entryAdded') {
      const e = m.params.entry;
      if (e.level === 'error') errors.push(`${e.text} ${e.url || ''}`);
    }
  });

  const send = (method, params = {}) => new Promise((res) => {
    const id = ++msgId;
    pending.set(id, (m) => res(m.result ?? m.error));
    ws.send(JSON.stringify({ id, method, params }));
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');

  // 预置设置。选项和骰子名字的 UI 在 P3 才有，在那之前只能这样测到
  // 那些分支 —— 否则"有选项"和"并列"这两条路在浏览器里根本走不到
  if (seed) {
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `localStorage.setItem('dice-rolling', ${JSON.stringify(JSON.stringify(seed))})`,
    });
  }

  // 竖屏手机尺寸
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  });

  // ⚠️ 光设尺寸不够。setDeviceMetricsOverride 不会改 navigator.maxTouchPoints，
  //    而 capability.js 的 isTouch 看的正是它 —— 少了这一句，整个测试环境
  //    会以"桌面"身份跑，提示文案写成"空格投掷"这种真机上做不到的话。
  //    （故意不开 setEmitTouchEventsForMouse：那会把下面的鼠标事件改写成
  //     触摸事件，手势链路就变了。这里只要 maxTouchPoints 对就行）
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

  await send('Page.navigate', { url: BASE + query });
  await sleep(waitMs);

  // 首页要点一下"开始"。自测页没有 gate，点不到就算了
  if (!query) {
    await send('Runtime.evaluate', {
      expression: `document.getElementById('start')?.click()`,
    });
    await sleep(2600);
  }

  if (diceCount) {
    // 第 6 个参数是"调到几颗"，不是点几下。从标签读当前值再算差值，
    // 否则预置了 diceCount 的场景会点过头
    await send('Runtime.evaluate', {
      expression: `(() => {
        const want = ${Number(diceCount)};
        const label = document.querySelector('.count-label')?.textContent || '';
        const cur = parseInt(label, 10) || 1;
        const steps = document.querySelectorAll('.chip.step');
        const btn = want > cur ? steps[1] : steps[0];
        for (let i = 0; i < Math.abs(want - cur); i++) btn?.click();
      })()`,
    });
    await sleep(600);
  }

  if (gesture === 'tie') {
    await huntTie(send);
  } else if (gesture === 'tieforce') {
    await forceTie(send);
  } else if (gesture) {
    await doGesture(send, gesture);
  }

  // 把状态机的状态也捞出来，光看图不知道是"投掷失败"还是"结果还没出"
  const st = await send('Runtime.evaluate', {
    expression: `document.querySelector('.result')?.innerText || '(结果卡是空的)'`,
    returnByValue: true,
  });
  console.log('\n── 结果卡 ──');
  console.log(st?.result?.value || '(空)');

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (shot?.data) {
    mkdirSync('tools/out', { recursive: true });
    const file = `tools/out/${outName}.png`;
    writeFileSync(file, Buffer.from(shot.data, 'base64'));
    console.log(`截图 → ${file}`);
  } else {
    console.log('截图失败：', shot);
  }

  // 把页面上的文字也捞出来，图看不清的细节靠这个
  const text = await send('Runtime.evaluate', {
    expression: `document.body.innerText`,
    returnByValue: true,
  });
  console.log('\n── 页面文字 ──');
  console.log(text?.result?.value || '(空)');

  if (logs.length) {
    console.log('\n── console ──');
    for (const l of logs.slice(-25)) console.log(l);
  }

  if (errors.length) {
    console.log('\n── ✗ 错误 ──');
    for (const e of errors.slice(0, 10)) console.log(e);
    process.exitCode = 1;
  } else {
    console.log('\n✓ 无错误');
  }
} finally {
  ws?.close();
  child.kill();
}

/**
 * 用 CDP 合成一次手势。
 *
 * 为什么用 Input.dispatchMouseEvent 而不是直接 evaluate 里 emit 事件：
 * 那样就绕过了 pointer.js，测的就不是真实链路了。这里合成的
 * 是浏览器级输入，会正常派发出 pointerdown/move/up。
 *
 * ⚠️ 步骤之间必须有真实的时间间隔。pointer.js 是按 performance.now()
 *    算末段速度的 —— 一口气把 move 全发完，速度会算成无穷大或零。
 */
async function doGesture(send, kind) {
  const x = 195;

  // 虚按：按住不动 600ms（长按阈值 380ms），面板浮出后截图。
  // 这条路径最容易出的 bug 是"松手时把骰子投出去了"，
  // 所以这里按住不放，截图时手指还在屏幕上
  if (kind === 'peek') {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y: 560, button: 'left', clickCount: 1, buttons: 1 });
    await sleep(900);
    return;
  }

  if (kind === 'tap') {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y: 560, button: 'left', clickCount: 1, buttons: 1 });
    await sleep(60);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y: 560, button: 'left', clickCount: 1, buttons: 0 });
    await sleep(5000);
    return;
  }

  await swipe(send);

  await sleep(Number(process.env.SETTLE_WAIT || 6000));   // 投掷 + 落定 + 停顿
}

/**
 * 反复投掷直到出现并列，然后停下截图。
 *
 * 3 颗骰子最高点并列的概率是 51/216 ≈ 24%，单投一次撞上的机会不大，
 * 但每次单开一个浏览器要等 13 秒落定 —— 一轮轮开根本试不起。
 * 在同一个会话里连投，才能在一分钟内走到这条分支。
 *
 * 每次投完读结果卡的文字判断，不靠猜。
 */
async function huntTie(send) {
  const maxTries = Number(process.env.TIE_TRIES || 12);
  const settle = Number(process.env.SETTLE_WAIT || 6000);

  for (let i = 1; i <= maxTries; i++) {
    await swipe(send);
    await sleep(settle);

    const r = await send('Runtime.evaluate', {
      expression: `document.querySelector('.result')?.innerText || ''`,
      returnByValue: true,
    });
    const text = r?.result?.value || '';

    if (text.includes('撞上了')) {
      console.log(`第 ${i} 次投掷撞上了并列`);
      return;
    }
    console.log(`第 ${i} 次：${text.replace(/\n/g, ' / ') || '(空)'}`);
  }

  console.log(`⚠️ 投了 ${maxTries} 次都没出现并列 —— 要么运气，要么并列分支根本没接上`);
}

/**
 * 确定性地造一个并列出来。
 *
 * 为什么不靠连投：3 颗骰子最高点并列概率 24%，撞上要碰运气；
 * 而每次都要等落定，试错成本很高。
 *
 * 做法是把骰子**摆成合法的平贴姿态**（某个面正好朝上、骰身躺平），
 * 这样物理不会来推翻它；然后**在同一个同步块里**调 flow.resolve()。
 * 中间没有 rAF，物理一步都没走 —— 所以读到的就是我摆的那个点数。
 *
 * 走的是完整真实链路：face-reader 读点数 → computeResult 判并列 →
 * 发 result 事件 → result-card 渲染。不是手搓一个结果对象喂给渲染层。
 *
 * 依赖 main.js 里 import.meta.env.DEV 保护下的 window.__dice
 */
async function forceTie(send) {
  const r = await send('Runtime.evaluate', {
    awaitPromise: true,
    returnByValue: true,
    expression: `(async () => {
      const D = window.__dice;
      if (!D) return { err: '没有 window.__dice —— 是不是跑了生产构建？' };
      if (D.dice.length < 3) return { err: '需要 3 颗骰子，当前 ' + D.dice.length };

      const geo = await import('/src/dice/geometry.js');

      // 把 f 面转到 +Y 所需的最小旋转。轴 = n × ŷ，角 = acos(n·ŷ)
      const orientUp = (body, value) => {
        const face = geo.FACES.find((f) => f.value === value);
        if (!face) throw new Error('没有点数为 ' + value + ' 的面');
        const [nx, ny, nz] = face.normal;

        const dot = Math.max(-1, Math.min(1, ny));
        const angle = Math.acos(dot);

        // n × (0,1,0) = (-nz, 0, nx)
        let ax = -nz, ay = 0, az = nx;
        const len = Math.hypot(ax, ay, az);

        let qx = 0, qy = 0, qz = 0, qw = 1;
        if (len < 1e-9) {
          // n 已经和 ±Y 共线。同向就是单位四元数；
          // 反向要转 180°，轴随便挑一个水平的
          if (dot < 0) { qx = 1; qy = 0; qz = 0; qw = 0; }
        } else {
          ax /= len; az /= len;
          const s = Math.sin(angle / 2);
          qx = ax * s; qy = ay * s; qz = az * s; qw = Math.cos(angle / 2);
        }

        body.quaternion.set(qx, qy, qz, qw);
        body.velocity.setZero();
        body.angularVelocity.setZero();
        body.force.setZero();
        body.torque.setZero();
        body.sleep();
      };

      const want = [4, 4, 2];        // 前两颗并列最高，第三颗低
      D.dice.forEach((d, i) => orientUp(d.body, want[i]));

      // ★ 同一个同步块里立刻结算。中间没有 rAF，物理一步都没走
      const result = D.flow.resolve();

      return {
        want,
        kind: result?.kind,
        winner: result?.winner,
        tied: result?.tied,
        values: result?.slots?.map((s) => s.value),
      };
    })()`,
  });

  const v = r?.result?.value;
  if (v?.err) {
    console.log('✗ ' + v.err);
  } else {
    console.log('摆位 →', JSON.stringify(v?.want));
    console.log('结算 →', JSON.stringify({
      kind: v?.kind, winner: v?.winner, tied: v?.tied, values: v?.values,
    }));
    if (v?.winner !== null) console.log('⚠️ winner 不是 null，并列分支没走到');
  }
  await sleep(1200);   // 等结果卡淡入
}

/**
 * 从下往上 240px 的滑动，分 8 步走 160ms。
 * 末段 90ms 大约覆盖 135px → 1.5px/ms，接近满力
 */
async function swipe(send) {
  const x = 195;
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y: 640, button: 'left', clickCount: 1, buttons: 1 });
  for (let i = 1; i <= 8; i++) {
    await sleep(20);
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x, y: 640 - i * 30, button: 'left', buttons: 1,
    });
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y: 400, button: 'left', clickCount: 1, buttons: 0 });
}

async function findTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  throw new Error('Edge 没能在 15 秒内起来');
}
