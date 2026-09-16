/**
 * renderer / scene / camera + 画质档 + 尺寸自适应。
 */

import {
  WebGLRenderer, Scene, PerspectiveCamera,
  PCFShadowMap, ACESFilmicToneMapping, SRGBColorSpace,
} from 'three';
import { SCENE } from '../config.js';

const DEG = Math.PI / 180;

let renderer = null;
let scene = null;
let camera = null;

export function createView(canvasEl, tier = 'high') {
  renderer = new WebGLRenderer({
    canvas: canvasEl,
    antialias: tier !== 'low',
    powerPreference: 'high-performance',
    alpha: false,
    stencil: false,
  });

  // 高配也压到 2 倍。3 倍像素比在手机上换不来可见的清晰度，
  // 却要多填 2.25 倍的像素
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, tier === 'high' ? 2 : 1.5));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.shadowMap.enabled = tier !== 'low';
  // ⚠️ 不能用 PCFSoftShadowMap —— three 0.186 已经把它删了。
  //    写了不会报错，只会在控制台警告一句然后悄悄退回 PCFShadowMap，
  //    所以很容易以为"柔和阴影开了"。想要更软就调 lights.js 里的
  //    normalBias/阴影贴图尺寸，别指望这个常量
  renderer.shadowMap.type = PCFShadowMap;

  // 透射（玉石）会额外渲染一遍场景。半分辨率肉眼看不出差别，省一半
  if ('transmissionResolutionScale' in renderer) {
    renderer.transmissionResolutionScale = tier === 'high' ? 0.5 : 0.35;
  }

  scene = new Scene();
  camera = new PerspectiveCamera(60, 1, 0.5, 80);
  camera.position.set(0, SCENE.camHeight, SCENE.camDist);
  camera.lookAt(...SCENE.camLookAt);

  resize();
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', resize);

  return { renderer, scene, camera };
}

export function resize() {
  if (!renderer) return;
  const w = window.innerWidth;
  const h = window.innerHeight;

  renderer.setSize(w, h, false);

  const aspect = w / h;

  // ⚠️ 按水平视场角反推垂直 fov。竖屏下这个值会很大（75° 上下），
  //    是正常的 —— 想要骰子大，水平视场角就必须窄，两者是一回事。
  const hfov = SCENE.hfovDeg * DEG;
  const vfovDeg = (2 * Math.atan(Math.tan(hfov / 2) / aspect)) / DEG;

  camera.fov = Math.min(SCENE.maxVfovDeg, Math.max(SCENE.minVfovDeg, vfovDeg));
  camera.aspect = aspect;
  camera.updateProjectionMatrix();
}

export function render() {
  if (renderer) renderer.render(scene, camera);
}

export function getRenderer() {
  return renderer;
}

export function getScene() {
  return scene;
}

export function getCamera() {
  return camera;
}

/** 着色器预编译。不调这个，第一次投掷会卡 200-400ms */
export function precompile() {
  if (renderer) renderer.compile(scene, camera);
}

export function disposeView() {
  window.removeEventListener('resize', resize);
  window.removeEventListener('orientationchange', resize);
  renderer?.dispose();
  renderer = null;
  scene = null;
  camera = null;
}
