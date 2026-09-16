/**
 * 极简事件总线。
 *
 * 架构纪律：ui/ 不被任何下层 import。下层往上发事件，上层订阅。
 * 这样状态机能脱离 DOM 单跑测试。
 */

const map = new Map();

export function on(type, fn) {
  let set = map.get(type);
  if (!set) map.set(type, (set = new Set()));
  set.add(fn);
  return () => off(type, fn);
}

export function once(type, fn) {
  const dispose = on(type, (payload) => {
    dispose();
    fn(payload);
  });
  return dispose;
}

export function off(type, fn) {
  map.get(type)?.delete(fn);
}

export function emit(type, payload) {
  const set = map.get(type);
  if (!set) return;
  // 复制一份再遍历：处理器里可能会 off 掉自己
  for (const fn of [...set]) {
    try {
      fn(payload);
    } catch (err) {
      console.error(`[bus] handler for "${type}" threw:`, err);
    }
  }
}

export function clear() {
  map.clear();
}
