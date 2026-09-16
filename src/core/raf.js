/**
 * 唯一的主循环。
 *
 * 架构纪律：只有这个文件能调 requestAnimationFrame，其他模块注册回调。
 * 好处是帧率上限、dt 钳制、后台暂停只需要在一个地方处理。
 */

const callbacks = new Set();
let rafId = 0;
let lastTime = 0;
let running = false;

function tick(now) {
  rafId = requestAnimationFrame(tick);

  // dt 钳制：标签页切回前台时 now-lastTime 可能是几十秒，
  // 不钳制的话物理会瞬移、音频会一次性调度几百个节点
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;

  if (dt <= 0) return;
  for (const cb of callbacks) {
    try {
      cb(dt, now);
    } catch (err) {
      console.error('[raf] callback threw:', err);
    }
  }
}

export function add(fn) {
  callbacks.add(fn);
  start();
  return () => callbacks.delete(fn);
}

export function start() {
  if (running) return;
  running = true;
  lastTime = performance.now();
  rafId = requestAnimationFrame(tick);
}

export function stop() {
  if (!running) return;
  running = false;
  cancelAnimationFrame(rafId);
  rafId = 0;
}

// 后台时停掉主循环省电；回前台重置时间基准避免大跳
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stop();
  else start();
});

// 供外部查询：切主题/重建资源时可能想暂停
export function isRunning() {
  return running;
}
