/**
 * 主题描述符 → three 灯光 + 环境贴图。
 *
 * ⚠️ 这个文件里有一个必须写对的换算，见下面 resolveIntensity()。
 *    漏了它，从旧教程抄来的灯光数值会让场景黑成一片，而且不报任何错。
 */

import {
  Group, SpotLight, DirectionalLight, HemisphereLight, Vector3,
  CanvasTexture, EquirectangularReflectionMapping, PMREMGenerator,
  LinearFilter, LinearSRGBColorSpace,
} from 'three';

/**
 * 现代 three（r155+）的点光/聚光是**物理单位**，强度按 1/d² 衰减。
 * 描述符里的 intensity 是按"照度意图"写的（相当于旧版的非物理值），
 * 引用时必须乘上到目标的距离²，才能还原成同样的观感亮度。
 *
 * 平行光没有距离衰减，半球光是环境项，两者都不能乘。
 */
function resolveIntensity(desc) {
  if (desc.type === 'hemisphere' || desc.type === 'directional') {
    return desc.intensity;
  }
  const target = desc.target || [0, 0, 0];
  const dist = new Vector3(...desc.position).distanceTo(new Vector3(...target));
  return desc.intensity * Math.max(1, dist * dist);
}

const shadowMaps = { high: 1024, mid: 1024, low: 512 };

export function buildLights(themeScene, tier = 'high') {
  const group = new Group();
  const lights = [];
  const canShadow = tier !== 'low';

  for (const desc of themeScene.lights) {
    const intensity = resolveIntensity(desc);
    let light;

    if (desc.type === 'hemisphere') {
      light = new HemisphereLight(desc.sky, desc.ground, intensity);
    } else if (desc.type === 'directional') {
      light = new DirectionalLight(desc.color, intensity);
      light.position.set(...desc.position);
      const target = desc.target || [0, 0, 0];
      light.target.position.set(...target);
      group.add(light.target);
    } else {
      // SpotLight(color, intensity, distance, angle, penumbra, decay)
      // distance 传 0 = 不额外截断，只靠 decay 的物理衰减
      light = new SpotLight(
        desc.color, intensity, 0, desc.angle, desc.penumbra, desc.decay ?? 2,
      );
      light.position.set(...desc.position);
      const target = desc.target || [0, 0, 0];
      light.target.position.set(...target);
      group.add(light.target);
    }

    if (desc.castShadow && canShadow) {
      light.castShadow = true;
      const size = shadowMaps[tier] || 1024;
      light.shadow.mapSize.set(size, size);
      light.shadow.camera.near = 1;
      light.shadow.camera.far = 40;
      // bias 不调的话骰子圆角处会出现条纹状自阴影；
      // normalBias 对付曲面，bias 对付平面，两个都要
      light.shadow.bias = -0.0012;
      light.shadow.normalBias = 0.022;
      light.shadow.radius = 3;
    }

    group.add(light);
    lights.push(light);
  }

  return { group, lights };
}

/**
 * 程序化生成环境贴图。
 *
 * 不加载任何外部 HDR —— 一个 HDR 文件就是几百 KB，而且离线时是额外的失败点。
 * 竖向渐变足够让金属有反射、让玉石有通透感，反正骰子不会映出具体景物。
 */
export function buildEnvironment(renderer, envDesc) {
  const canvas = document.createElement('canvas');
  canvas.width = 64;      // PMREM 会自己模糊，源图不需要大
  canvas.height = 32;

  const ctx = canvas.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 32);
  grad.addColorStop(0.0, cssOf(envDesc.top));
  grad.addColorStop(0.45, cssOf(envDesc.top));
  grad.addColorStop(1.0, cssOf(envDesc.bottom));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 32);

  const tex = new CanvasTexture(canvas);
  tex.mapping = EquirectangularReflectionMapping;
  tex.colorSpace = LinearSRGBColorSpace;
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;

  const pmrem = new PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const rt = pmrem.fromEquirectangular(tex);

  tex.dispose();
  pmrem.dispose();

  return rt.texture;   // 调用方负责在换主题时 dispose
}

function cssOf(hex) {
  return '#' + hex.toString(16).padStart(6, '0');
}
