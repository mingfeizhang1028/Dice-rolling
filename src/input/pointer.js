/**
 * 指针输入：滑动投掷 / 点击投掷 / 虚按看名字。
 *
 * ⚠️ 三种手势共用一次 pointerdown，判据必须互斥，否则会出现
 *    "想按住看名字，结果骰子飞了"。规则：
 *
 *      pointerdown 起 380ms 计时器
 *        期间移动超过 8px  → 取消长按，进入"滑动"分支
 *        计时器触发        → 进入"虚按"，此后抬指绝不投掷
 *      pointerup
 *        在虚按中          → 只发 peek:end
 *        位移 < 12px 且 < 250ms → 点击投掷，力度固定 0.35
 *        否则              → 滑动投掷，力度 = 末段速度归一化
 *
 *    "虚按中抬指不投掷"这条是硬规则。少写这一条，用户每次看名字都会投一次。
 */

import { emit } from '../core/bus.js';

const LONG_PRESS_MS = 380;
const MOVE_TOLERANCE = 8;      // px，超过就不算长按了
const TAP_MAX_MS = 250;
const TAP_MAX_DIST = 12;       // px
const TAP_POWER = 0.35;
const VELOCITY_WINDOW_MS = 90; // 只取最后这段的位移算速度，早先的慢速拖拽不算数
const MAX_SPEED = 1.7;         // px/ms，约 1700px/s。到达这个速度就是满力

let tracking = false;
let peeking = false;
let longPressTimer = 0;
let startX = 0;
let startY = 0;
let startT = 0;
let samples = [];

export function initPointer(target) {
  target.addEventListener('pointerdown', onDown, { passive: true });
  target.addEventListener('pointermove', onMove, { passive: true });
  target.addEventListener('pointerup', onUp, { passive: true });
  target.addEventListener('pointercancel', onCancel, { passive: true });
  // 浏览器原生长按菜单/选中会打断虚按
  target.addEventListener('contextmenu', (e) => e.preventDefault());
}

function onDown(e) {
  if (tracking) return;
  tracking = true;
  peeking = false;
  startX = e.clientX;
  startY = e.clientY;
  startT = performance.now();
  samples = [{ x: e.clientX, y: e.clientY, t: startT }];

  // 先退出待投状态再浮出名字。顺序反了的话，松手时状态机还停在 ARMING，
  // 会走投掷分支
  emit('intent:arm');

  longPressTimer = window.setTimeout(() => {
    if (!tracking) return;
    peeking = true;
    emit('intent:disarm');
    emit('peek:start');
  }, LONG_PRESS_MS);
}

function onMove(e) {
  if (!tracking) return;

  const now = performance.now();
  samples.push({ x: e.clientX, y: e.clientY, t: now });
  // 只留最近一小段，防止长滑把数组撑大
  while (samples.length > 2 && now - samples[0].t > VELOCITY_WINDOW_MS) {
    samples.shift();
  }

  if (!peeking) {
    const moved = Math.hypot(e.clientX - startX, e.clientY - startY);
    if (moved > MOVE_TOLERANCE) {
      clearTimeout(longPressTimer);
      longPressTimer = 0;
    }
  }
}

function onUp(e) {
  if (!tracking) return;
  tracking = false;
  clearTimeout(longPressTimer);
  longPressTimer = 0;

  // 硬规则：虚按之后抬指，只结束虚按，绝不投掷
  if (peeking) {
    peeking = false;
    emit('peek:end');
    emit('intent:disarm');
    return;
  }

  const dt = performance.now() - startT;
  const dist = Math.hypot(e.clientX - startX, e.clientY - startY);

  if (dist < TAP_MAX_DIST && dt < TAP_MAX_MS) {
    emit('intent:toss', { power: TAP_POWER, dirX: 0, dirZ: 0, source: 'tap' });
    return;
  }

  // 滑动：用最后一段的速度。用全程平均速度的话，
  // "慢慢拖出去再甩一下"会被判成很小的力度，手感很闷
  const { dx, dy, speed } = tailVelocity();
  const power = Math.max(0.15, Math.min(1, speed / MAX_SPEED));

  // 屏幕坐标 → 世界方向。
  // 屏幕右 → 世界 +X；屏幕下 → 世界 +Z（朝观察者）。
  // throw.js 里的冲量是 (-hx, +vy, -hz)，所以这里取负号抵消
  const len = Math.hypot(dx, dy) || 1;
  emit('intent:toss', {
    power,
    dirX: -(dx / len),
    dirZ: -(dy / len),
    source: 'swipe',
  });
}

function onCancel() {
  tracking = false;
  clearTimeout(longPressTimer);
  longPressTimer = 0;
  if (peeking) {
    peeking = false;
    emit('peek:end');
  }
  emit('intent:disarm');
}

function tailVelocity() {
  if (samples.length < 2) return { dx: 0, dy: 0, speed: 0 };

  const last = samples[samples.length - 1];
  // 找到窗口里第一个样本
  let first = samples[0];
  for (const s of samples) {
    if (last.t - s.t <= VELOCITY_WINDOW_MS) {
      first = s;
      break;
    }
  }

  const dx = last.x - first.x;
  const dy = last.y - first.y;
  const dt = Math.max(1, last.t - first.t);
  return { dx, dy, speed: Math.hypot(dx, dy) / dt };
}

export function isPeeking() {
  return peeking;
}

/** 状态机进入 THROWING 时调一下，防止在投掷过程中残留虚按状态 */
export function cancelPeek() {
  if (!peeking) return;
  peeking = false;
  emit('peek:end');
}
