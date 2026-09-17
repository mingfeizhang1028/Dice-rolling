/**
 * 设置持久化。
 *
 * ⚠️ 每一处 localStorage 访问都必须 try/catch。
 *    无痕模式、配额满、企业策略禁用 —— 三种情况下 getItem/setItem 都会直接抛，
 *    不兜住就是启动白屏。用户存的是"我的选项"和"骰子的名字"，
 *    丢了比闪退更让人恼火，所以宁可退化成内存模式也要跑起来。
 *
 * ⚠️ 根对象带 v 字段 + 迁移函数表。PWA 会自动更新，
 *    下次打开就是新版本代码带旧数据，这是必然会遇到的情况。
 */

import { DEFAULTS, STORE_KEY, STORE_VERSION } from './config.js';

let persistent = true;
let memory = null;

/**
 * 迁移函数表：key 是目标版本号，值接收旧数据返回新数据。
 * 加字段不需要迁移（下面会自动补默认值），只有"改语义/换结构"才要写。
 */
const MIGRATIONS = {
  // 2: (d) => ({ ...d, newField: ..., }),
};

export function load() {
  let raw = null;
  try {
    raw = localStorage.getItem(STORE_KEY);
  } catch (err) {
    persistent = false;
    console.warn('[store] localStorage 不可用，本次改动不会被保存', err);
    return { ...DEFAULTS };
  }

  if (!raw) return { ...DEFAULTS };

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    console.warn('[store] 存档解析失败，已重置', err);
    return { ...DEFAULTS };
  }

  return migrate(data);
}

function migrate(data) {
  if (!data || typeof data !== 'object') return { ...DEFAULTS };

  let version = Number(data.v) || 0;
  let working = data;

  while (version < STORE_VERSION) {
    const step = MIGRATIONS[version + 1];
    if (!step) break;
    try {
      working = step(working);
    } catch (err) {
      console.warn(`[store] 迁移到 v${version + 1} 失败，已重置`, err);
      return { ...DEFAULTS };
    }
    version++;
  }

  // 白名单式取值：只认 DEFAULTS 里有的键。
  // 直接展开旧数据的话，改版删掉的字段会一直飘在设置对象里
  const out = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (key in working) out[key] = working[key];
  }

  // 数组字段要单独校验长度，否则改版后可能拿到越界的旧值
  const NAMES = 12; // 骰子上限
  if (!Array.isArray(out.names) || out.names.length < NAMES) {
    out.names = [...DEFAULTS.names];
    if (Array.isArray(working.names)) {
      for (let i = 0; i < NAMES; i++) out.names[i] = working.names[i] ?? '';
    }
  }
  if (!Array.isArray(out.options)) out.options = [];

  // 自定义颜色：只收合法 hex 字符串，缺的补空（空 = 用材质默认）
  if (!Array.isArray(out.colors)) out.colors = [];
  out.colors = out.colors.map((c) => (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c) ? c : ''));

  // 多数决归属：只收 0..选项数-1 的整数，越界钳制；缺的补 -1（-1 = 自动）
  if (!Array.isArray(out.assignment)) out.assignment = [];
  const optN = out.options.filter((s) => (s || '').trim()).length;
  out.assignment = out.assignment.map((a) => {
    const n = Number(a);
    if (!Number.isInteger(n)) return -1;
    return optN > 0 ? Math.max(0, Math.min(optN - 1, n)) : -1;
  });

  return out;
}

export function save(settings) {
  memory = { ...settings, v: STORE_VERSION };
  if (!persistent) return false;

  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(memory));
    return true;
  } catch (err) {
    // 配额满了或者被策略拦了。降级成内存模式，本次会话照常用
    persistent = false;
    console.warn('[store] 写入失败，已降级为内存模式', err);
    return false;
  }
}

/** 设置能不能落盘。不能的话 UI 要提示"本次改动不会被保存" */
export function isPersistent() {
  return persistent;
}

// ── 导出 / 导入（P3 设置面板用） ──

export function exportJson(settings) {
  return JSON.stringify({ ...settings, v: STORE_VERSION }, null, 2);
}

export function importJson(text) {
  const data = JSON.parse(text);
  return migrate(data);
}

export function clear() {
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    /* 无痕模式下本来就没存 */
  }
  memory = null;
  persistent = true;
}
