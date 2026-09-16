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

// 选项数对不上颗数 → 退回 multi
check('选项数不匹配 → multi', computeResult([5,5], {options:['甲','乙','丙']}, dice(2)).kind, 'multi');

// 空选项字符串应当被忽略
check('选项有空串 → multi', computeResult([5,5], {options:['甲','']}, dice(2)).kind, 'multi');

// 名字只在起了的时候出现
const d = dice(1); d[0].name = '要不要搬家';
check('名字带进结果', computeResult([4], {options:[]}, d).name, '要不要搬家');

console.log(fail ? `\n✗ ${fail} 项失败` : '\n✓ 全部通过');
process.exit(fail ? 1 : 0);
