/**
 * 在 Node 里跑骰子自测，不用开浏览器。
 *
 *   node tools/selftest.mjs               # 1 颗，200 次
 *   node tools/selftest.mjs 3 200 jade    # 3 颗玉石骰子，200 次
 *   node tools/selftest.mjs 1 1200        # 加大样本看分布
 *
 * 退出码非 0 表示有失败项，可以直接挂到 CI 上。
 */

import { runSelfTest } from '../src/selftest.js';

const diceCount = Number(process.argv[2]) || 1;
const throws = Number(process.argv[3]) || 200;
const materialId = process.argv[4] || 'jade';

const result = runSelfTest({ throws, diceCount, materialId });

process.exit(result.ok ? 0 : 1);
