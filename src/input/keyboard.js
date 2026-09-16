/**
 * 桌面调试用。手机上永远走不到这里，但开发时省下的时间非常可观 ——
 * 不用每次拿起手机就能试一轮投掷。
 */

import { emit } from '../core/bus.js';

export function initKeyboard() {
  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;

    switch (e.key) {
      case ' ':
      case 'Enter':
        e.preventDefault();
        // 按住 Shift 加大力度，方便试大力度下的稳定性
        emit('intent:toss', {
          power: e.shiftKey ? 1 : 0.5,
          dirX: 0,
          dirZ: 0,
          source: 'keyboard',
        });
        break;

      case '1':
      case '2':
      case '3':
      case '4':
        emit('intent:count', { count: Number(e.key) });
        break;

      case 'Escape':
        emit('intent:escape');
        break;

      default:
        break;
    }
  });
}
