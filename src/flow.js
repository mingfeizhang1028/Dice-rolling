/**
 * 决策流程状态机。
 *
 *   BOOT → IDLE ⇄ ARMING → THROWING → SETTLING → RESULT → IDLE
 *                    ↘ SETTINGS ↗
 *
 * ⚠️ 没有提问环节。整条链路上没有任何一步在问"你更想要哪个"。
 *    理由在计划里写清楚了：偏好是自己浮现的，工具的本分是把掷骰子
 *    这件事做得足够郑重，让那个偏好来得及浮出来。
 *
 *    SETTLING 的 pauseMs（默认 600ms）就是节奏本身 —— 骰子停下、
 *    声音散尽、结果浮现。这段时间零动效、零文字变化。
 */

import { emit, on } from './core/bus.js';
import { placeDie, tossDie } from './physics/throw.js';
import { createSettleWatcher } from './physics/settle.js';
import { readAll } from './dice/face-reader.js';
import { dieColor, hexToCss } from './materials.js';

/** 骰子颗数上限。骰子多了会按 dieScaleFor 缩小装进固定托盘。 */
export const MAX_DICE = 12;

/**
 * 点数 → 结果。纯函数，不碰场景也不碰 DOM，所以能单独测。
 *
 * 三种决策路子（编辑页里可切）：
 *   对决（duel）：每个选项一颗骰子，点数高者胜；并列时明确告诉"撞上了"。
 *   选号（pick）：选项不限数量，把所有骰子点数加起来、从头循环数到第几个。
 *   多数决（vote）：每颗骰子手动归属一个选项，各选项取自己骰子的点数总和，高者胜。
 *   没有填选项时：单颗 = 点数 + 是与否；多颗 = 只是点数列表。
 */
export function computeResult(values, settings, dice) {
  const filled = (settings.options || []).map((s) => (s || '').trim()).filter((s) => s !== '');
  const N = filled.length;
  const n = values.length;
  const mode = ['pick', 'vote', 'duel'].includes(settings.decisionMode)
    ? settings.decisionMode
    : 'duel';

  // ── 选号：多颗骰合计，取模选一个选项 ──
  if (mode === 'pick' && N > 0) {
    const total = values.reduce((a, b) => a + b, 0);
    // total ≥ n ≥ 1，所以 (total-1) % N 不会为负；再兜一层 +N 防手滑
    const idx = ((total - 1) % N + N) % N;
    const d0 = dice[0];
    return {
      kind: 'pick',
      values,
      total,
      optionIndex: idx,
      option: filled[idx],
      optionCount: N,
      color: d0 ? hexToCss(dieColor(d0.materialId, 0)) : null,
    };
  }

  // ── 多数决：手动分配 · 比总和 ──
  // 每颗骰子归属一个选项（settings.assignment[i]，缺省自动 i % N），
  // 各选项把自己的骰子点数相加，总和最大者胜；并列则并列。
  // 骰子数不匀时，骰子多的选项天然占优 —— 编辑页负责提示，这里只管算。
  if (mode === 'vote' && N > 0) {
    const assn = (settings.assignment || []).map((a) => Number(a));
    const sums = new Array(N).fill(0);
    const assigned = [];
    for (let i = 0; i < n; i++) {
      // 整数才认作手动分配，否则自动 i % N；统一钳到 [0, N-1]
      let a = Number.isInteger(assn[i]) ? assn[i] : i % N;
      a = Math.max(0, Math.min(N - 1, a));
      sums[a] += values[i];
      assigned.push(a);
    }

    let max = 0;
    for (const s of sums) if (s > max) max = s;

    const winners = [];
    for (let i = 0; i < N; i++) if (sums[i] === max) winners.push(i);

    return {
      kind: 'vote',
      values,
      sums,
      max,
      winner: winners.length === 1 ? winners[0] : null,
      tied: winners.length > 1 ? winners : [],
      optionCount: N,
      slots: dice.map((d, i) => ({
        slot: i,
        name: d.name || '',
        option: filled[assigned[i]] || '',
        assigned: assigned[i],
        value: values[i],
        color: hexToCss(dieColor(d.materialId, i)),
      })),
    };
  }

  // ── 对决：一骰一选项，点数高者胜 ──
  // ⚠️ 只有当骰子数正好等于"参与选项数"才算对决；不符就退化成多骰点数。
  //    参与选项数 = min(选项数, 骰子数)。选项超过 4 时只让前 4 个参加，
  //    n 恒等于 min(N, MAX_DICE)，所以守卫写成 n === min(N, 4)。
  if (mode === 'duel' && N > 0 && n === Math.min(N, 4)) {
    const active = filled.slice(0, n);
    let max = -1;
    for (const v of values) if (v > max) max = v;

    const winners = [];
    for (let i = 0; i < n; i++) if (values[i] === max) winners.push(i);

    return {
      kind: 'choice',
      values,
      max,
      // 并列不是故障，是机会。UI 要把它写成"点数撞上了，你更想选哪一颗"
      winner: winners.length === 1 ? winners[0] : null,
      tied: winners.length > 1 ? winners : [],
      slots: dice.map((d, i) => ({
        slot: i,
        name: d.name || '',
        option: active[i] || '',
        value: values[i],
        color: hexToCss(dieColor(d.materialId, i)),
      })),
    };
  }

  if (n === 1) {
    const v = values[0];
    const yes = settings.yesMapping === 'oddEven' ? v % 2 === 1 : v >= 4;
    return {
      kind: 'single',
      values,
      value: v,
      yes,
      color: hexToCss(dieColor(dice[0].materialId, 0)),
      name: dice[0].name || '',
    };
  }

  return {
    kind: 'multi',
    values,
    sum: values.reduce((a, b) => a + b, 0),
    slots: dice.map((d, i) => ({
      slot: i,
      name: d.name || '',
      value: values[i],
      color: hexToCss(dieColor(d.materialId, i)),
    })),
  };
}

export function createFlow({ getDice, settings }) {
  const settler = createSettleWatcher();

  let state = 'BOOT';
  let settleAt = 0;
  let lastResult = null;
  let lastSettle = null;

  function go(next, extra) {
    if (state === next) return;
    const from = state;
    state = next;
    emit('flow:change', { from, to: next, ...(extra || {}) });
  }

  function toss({ power = 0.5, dirX = 0, dirZ = 0, source = 'unknown' } = {}) {
    // ARMING 也能投 —— 按下之后再松手投掷走的就是这条路
    if (state !== 'IDLE' && state !== 'ARMING' && state !== 'RESULT') return false;

    const dice = getDice();
    if (!dice.length) return false;

    go('THROWING', { power, source });

    // 先把所有骰子摆好再统一施力。混在一起做的话，
    // 后摆的骰子会撞上已经飞起来的前一颗
    for (let i = 0; i < dice.length; i++) placeDie(dice[i].body, i, dice.length);
    for (let i = 0; i < dice.length; i++) {
      tossDie(dice[i].body, { power, dirX, dirZ });
    }

    settler.begin(dice);
    emit('throw:start', { power, dirX, dirZ, source, count: dice.length });
    return true;
  }

  function update(dt, now) {
    const dice = getDice();

    // 同步显示对象。无论什么状态都要做 —— 骰子在 RESULT 状态下
    // 仍然可能有微小抖动，不同步会看到僵硬的一帧
    for (const d of dice) d.sync();

    switch (state) {
      case 'THROWING': {
        const r = settler.update(now);
        if (r) {
          settleAt = now;
          lastSettle = r;
          go('SETTLING', { forced: r.forced });
          emit('dice:settled', {
            forced: r.forced,
            elapsedMs: r.elapsedMs,
            count: dice.length,
          });
        }
        break;
      }

      case 'SETTLING': {
        if (now - settleAt >= settings.pauseMs) resolve();
        break;
      }

      default:
        break;
    }
  }

  function resolve() {
    const dice = getDice();
    if (!dice.length) {
      go('IDLE');
      return null;
    }

    const values = readAll(dice);
    const result = computeResult(values, settings, dice);
    lastResult = result;

    go('RESULT', { result });
    emit('result', result);
    return result;
  }

  // ── 输入订阅 ──
  on('intent:toss', (payload) => toss(payload));

  on('intent:arm', () => {
    if (state === 'IDLE' || state === 'RESULT') go('ARMING');
  });

  // 长按看名字时退出 ARMING —— 否则手势过后会卡在待投状态
  on('intent:disarm', () => {
    if (state === 'ARMING') go('IDLE');
  });

  on('intent:escape', () => {
    if (state === 'RESULT') go('IDLE');
    else if (state === 'ARMING') go('IDLE');
  });

  return {
    toss,
    update,
    resolve,
    go,
    get state() {
      return state;
    },
    get lastResult() {
      return lastResult;
    },
    get lastSettle() {
      return lastSettle;
    },
  };
}
