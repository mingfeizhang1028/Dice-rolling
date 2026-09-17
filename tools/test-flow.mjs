import { computeResult } from '../src/flow.js';

const dice = (n, mat='jade') => Array.from({length:n}, (_,i)=>({slot:i, materialId:mat, name:''}));

let fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok?'✓':'✗'} ${label}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`);
};

// 1 颗无选项
check('单颗 6 → 是', computeResult([6], {yesMapping:'high', options:[]}, dice(1)).yes, true);
check('单颗 3 → 否', computeResult([3], {yesMapping:'high', options:[]}, dice(1)).yes, false);
check('单颗 3 奇偶 → 是', computeResult([3], {yesMapping:'oddEven', options:[]}, dice(1)).yes, true);

// 多颗无选项
const m = computeResult([2,5,1], {options:[]}, dice(3));
check('多颗 kind', m.kind, 'multi');
check('多颗 sum', m.sum, 8);

// 有选项，明确胜出
const c = computeResult([2,5,1], {options:['甲','乙','丙']}, dice(3));
check('选项 kind', c.kind, 'choice');
check('选项 winner', c.winner, 1);
check('选项 winner 文案', c.slots[c.winner].option, '乙');

// 有选项但并列
const t = computeResult([5,5,1], {options:['甲','乙','丙']}, dice(3));
check('并列 winner 为 null', t.winner, null);
check('并列 tied', t.tied, [0,1]);

// ⚠️ 并列必须是"所有等于最大值的都收进来"，不是"找到两个就停"。
//    3 颗骰子全相同的概率是 6/216，和两两并列 51/216 加起来约 26% ——
//    不是罕见到可以不测的情况。三路并列若只列出前两个，
//    用户会看到一张漏了一颗的结果卡，而且完全没有报错
const t3 = computeResult([4,4,4], {options:['甲','乙','丙']}, dice(3));
check('三路并列 winner 为 null', t3.winner, null);
check('三路并列 tied 三个都列出', t3.tied, [0,1,2]);

// 并列的两颗不相邻时，下标不能错位
const t2 = computeResult([4,1,4], {options:['甲','乙','丙']}, dice(3));
check('不相邻并列 tied', t2.tied, [0,2]);
check('不相邻并列项文案', t2.tied.map(i=>t2.slots[i].option), ['甲','丙']);

// 每颗的区分色必须按 slot 取，不能所有并列项都拿同一个色
const cols = t3.tied.map(i=>t3.slots[i].color);
check('三路并列三色各不相同', new Set(cols).size, 3);

// 选项数对不上颗数 → 退回 multi
check('选项数不匹配 → multi', computeResult([5,5], {options:['甲','乙','丙']}, dice(2)).kind, 'multi');

// 空选项字符串应当被忽略
check('选项有空串 → multi', computeResult([5,5], {options:['甲','']}, dice(2)).kind, 'multi');

// 名字只在起了的时候出现
const d = dice(1); d[0].name = '要不要搬家';
check('名字带进结果', computeResult([4], {options:[]}, d).name, '要不要搬家');

// ── 多数决（vote）：手动分配 · 比总和 ──
// 2 选项、3 骰：assignment [0,1,0] → 甲取 values[0]+values[2]，乙取 values[1]
const v = computeResult([2,6,5], {decisionMode:'vote', options:['甲','乙'], assignment:[0,1,0]}, dice(3));
check('多数决 kind', v.kind, 'vote');
check('多数决 sums', v.sums, [7,6]);
check('多数决 winner', v.winner, 0);

// 未提供 assignment → 自动 i % N（3 骰 2 选项 → 甲,乙,甲）
const vAuto = computeResult([2,6,5], {decisionMode:'vote', options:['甲','乙']}, dice(3));
check('多数决 自动分配 sums', vAuto.sums, [7,6]);

// 越界 assignment 钳制：5 → 钳到 1（选项2），-3 → 钳到 0（选项1）
const vClamp = computeResult([1,6], {decisionMode:'vote', options:['甲','乙'], assignment:[5,-3]}, dice(2));
check('多数决 钳制 sums', vClamp.sums, [6,1]);

// 并列
const vt = computeResult([4,4], {decisionMode:'vote', options:['甲','乙'], assignment:[0,1]}, dice(2));
check('多数决并列 winner null', vt.winner, null);
check('多数决并列 tied', vt.tied, [0,1]);
check('多数决并列 sums', vt.sums, [4,4]);

console.log(fail ? `\n✗ ${fail} 项失败` : '\n✓ 全部通过');
process.exit(fail ? 1 : 0);
