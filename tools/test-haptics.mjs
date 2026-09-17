/**
 * 触觉自测。
 *
 * ⚠️ 这里测的全是**逻辑**，不是"到底震没震" —— 后者在桌面无法验证，
 *    只能真机确认。而逻辑恰恰是最容易出错的部分：
 *    限流写错会让连续碰撞只震零星的几下、退避写错会让某个设备
 *    每次撞击都抛一个异常刷满控制台，这两样在真机上都被理解为
 *    "震动时好时坏"，几乎无从复现。
 *
 * 用 stub 顶替 navigator.vibrate，用可注入的时钟顶替 performance.now，
 * 于是"32ms 内连撞两次"这种时序问题可以瞬时、确定性地测。
 */

import {
  probe, impact, settle, tick, setEnabled, cancel,
  isAvailable, isEnabled, getStats, handleVisibility, __resetForTest,
} from '../src/haptics.js';
import { MATERIALS } from '../src/materials.js';

let fail = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) fail++;
  console.log(`${cond ? '✓' : '✗'} ${label}${detail ? '  ' + detail : ''}`);
};

// ── 可注入的时钟 ──
let now = 1000;
const realNow = performance.now;
performance.now = () => now;
const advance = (ms) => { now += ms; };

// ── stub navigator / document ──
//
// ⚠️ Node 24 的 globalThis.navigator 是只有 getter 的属性，直接赋值
//    会抛 TypeError。必须用 defineProperty 覆盖。
const define = (name, value) =>
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });

let calls = [];
function stubVibrate(behavior = 'ok') {
  calls = [];
  define('navigator', {
    vibrate(pattern) {
      calls.push(pattern);
      if (behavior === 'throw') throw new Error('stub: 设备拒绝');
      if (behavior === 'false') return false;
      return true;
    },
  });
}
function stubNoApi() {
  calls = [];
  define('navigator', {});
}

/** 每段用例之间必须完全重置 —— 模块状态是共享的 */
function fresh(behavior) {
  __resetForTest();
  calls = [];
  now = 1000;
  if (behavior === 'none') stubNoApi(); else stubVibrate(behavior);
}

// ── 1. 能力探测：三种设备 ──
console.log('── 能力探测 ──\n');

fresh('none');
ok('没有 API → available=false', probe() === false && !isAvailable());
ok('没有 API → isEnabled=false', !isEnabled());
impact('jade', 0.5);
ok('没有 API 时不产生调用', calls.length === 0);
ok('没有 API 时计数进 skippedOff', getStats().skippedOff === 1);

fresh('ok');
ok('有 API → available=true', probe() === true && isAvailable());
ok('探测本身震了 1ms（用户感觉不到的强度）',
   calls.length === 1 && calls[0] === 1, JSON.stringify(calls));

// 有 API 但调用抛异常的设备（部分 Android 定制浏览器）。只有真调一次才知道
fresh('throw');
ok('调用抛异常 → available=false', probe() === false && !isAvailable());
impact('jade', 0.5);
ok('探测失败后续调用不再试', calls.length === 1, `calls=${JSON.stringify(calls)}`);

// ── 2. 限流 ──
//
// ⚠️ 这条是必需而不是优化：navigator.vibrate 每次调用都会取消上一个，
//    且马达有 20–50ms 启动时间。不限流的话，密集碰撞里每一次调用都
//    掐掉上一次，用户感觉到的震动**比实际碰撞次数少得多**。
console.log('\n── 限流 ──\n');

fresh('ok');
probe();
calls = [];
impact('jade', 0.6);
const afterFirst = calls.length;
advance(10);                 // 10ms < MIN_GAP_MS(32)
impact('jade', 0.6);
const afterSecond = calls.length;
ok('第一次撞击震', afterFirst === 1, `calls=${afterFirst}`);
ok('32ms 内的第二次被丢弃', afterSecond === 1, `calls=${afterSecond}`);
ok('被丢弃的计进 skippedRate', getStats().skippedRate === 1);

advance(40);                 // 越过限流窗口
impact('jade', 0.6);
ok('越过窗口后恢复震动', calls.length === 2, `calls=${calls.length}`);

// 丢弃必须是真的丢弃，不能攒起来补发 —— 攒起来就是"迟到的震动"，
// 比不震更让人困惑
advance(5);
impact('jade', 0.6);
advance(5);
impact('jade', 0.6);
advance(5);
impact('jade', 0.6);
advance(100);
ok('丢弃的不补发', calls.length === 2, `calls=${calls.length}`);

// ── 3. 退避 ──
console.log('\n── 退避 ──\n');

// ⚠️ 桩必须在 probe() **之前**装好。probe 里会做
//    `api = navigator.vibrate.bind(navigator)`，之后再把
//    navigator.vibrate 换掉是不生效的 —— api 已经指向旧函数了。
//    所以这里用一个闭包里的开关模拟"用着用着坏了"。
fresh('ok');
let throwNow = false;
define('navigator', {
  vibrate(p) {
    calls.push(p);
    if (throwNow) throw new Error('stub: 中途开始抛');
    return true;
  },
});
probe();
ok('探测成功（此时还没开始抛）', isAvailable());
throwNow = true;
for (let i = 0; i < 5; i++) { advance(100); impact('jade', 0.5); }
const s = getStats();
ok('连续失败后停用', s.disabledByFailure === true, `disabled=${s.disabledByFailure}`);
ok('停用后 isEnabled=false', !isEnabled());
const callsAtDisable = calls.length;
advance(100);
impact('jade', 0.5);
ok('停用后不再调用 API', calls.length === callsAtDisable, `calls=${calls.length}`);
// 抛 3 次才停用，所以前 3 次是白抛的；第 4 次开始就不碰 API 了。
// 精确断言次数，避免"多抛了几次也没关系"这种宽松通过
ok('恰好抛满 FAIL_LIMIT 次就停', callsAtDisable === 1 + 3, `探测 1 次 + 撞击 ${callsAtDisable - 1} 次`);

// ── 4. 开关 ──
console.log('\n── 开关 ──\n');

fresh('ok');
probe();
calls = [];
advance(100);
impact('jade', 0.5);
ok('开着时震', calls.length === 1);
setEnabled(false);
ok('关掉时取消正在进行的震动（vibrate(0)）', calls[calls.length - 1] === 0,
   `最后一条是 ${JSON.stringify(calls[calls.length - 1])}`);
advance(100);
impact('jade', 0.5);
ok('关掉后不再震', calls.filter((c) => c !== 0).length === 1);

setEnabled(true);
advance(100);
impact('jade', 0.5);
ok('重新打开后恢复', calls.filter((c) => c !== 0).length === 2);

// ── 5. 材质影响脉冲长度 ──
//
// 金属比塑料震得久、震得实，这和它的物理阻尼是一套语言。
// 若四种材质震感一样，"材质"这个设置就丢了一半意义。
console.log('\n── 材质分级 ──\n');

const pulseFor = (matId, strength) => {
  fresh('ok');
  probe();
  calls = [];
  advance(100);
  impact(matId, strength);
  return calls[0]?.[0] ?? 0;
};

const pMetal = pulseFor('metal', 0.5);
const pPlastic = pulseFor('plastic', 0.5);
const pJade = pulseFor('jade', 0.5);
console.log(`  金属 ${pMetal}ms  玉石 ${pJade}ms  塑料 ${pPlastic}ms\n`);
ok('金属比塑料震得久', pMetal > pPlastic, `${pMetal} vs ${pPlastic}`);
ok('都达到可感下限', Math.min(pMetal, pJade, pPlastic) >= 8);

// 同一材质，撞得重震得久
const soft = pulseFor('metal', 0);
const hard = pulseFor('metal', 1);
ok('撞得重震得久', hard > soft, `${soft}ms → ${hard}ms`);
// 但轻撞不能缩到 0 —— 完全没有震动会让人觉得"这次没生效"
ok('轻撞也有可感脉冲', soft >= 8, `${soft}ms`);

// ── 6. 落定的三连脉冲 ──
console.log('');
fresh('ok');
probe();
calls = [];
advance(100);
settle('jade');
ok('落定是脉冲序列不是单次', Array.isArray(calls[0]) && calls[0].length >= 3,
   JSON.stringify(calls[0]));
ok('序列用的是材质的 settle 参数',
   JSON.stringify(calls[0]) === JSON.stringify(MATERIALS.jade.haptic.settle),
   `${JSON.stringify(calls[0])} vs ${JSON.stringify(MATERIALS.jade.haptic.settle)}`);

// ── 7. 切后台必须停 ──
//
// 手机在兜里还一震一震的，用户会以为程序出问题了
console.log('');
fresh('ok');
probe();
calls = [];
define('document', { hidden: true });
handleVisibility();
ok('切后台时取消震动', calls[calls.length - 1] === 0, `calls=${JSON.stringify(calls)}`);

// ── 8. 返回 false 不算设备故障 ──
//
// 规范允许 vibrate 在页面不可见时返回 false。把它当故障的话，
// 用户切一次后台就会永久失去震动
console.log('');
fresh('false');
probe();
for (let i = 0; i < 5; i++) { advance(100); impact('jade', 0.5); }
ok('返回 false 不触发退避', getStats().disabledByFailure === false);

performance.now = realNow;
console.log(fail ? `\n✗ ${fail} 项失败` : '\n✓ 全部通过');
process.exit(fail ? 1 : 0);
