/**
 * 托盘：地板 + 一圈低矮的边 + 中央一圈柔光。
 *
 * 中央柔光不是装饰。暗室主题下托盘本身是深灰的，骰子落在哪全靠明暗对比
 * 判断；加一圈几乎看不见的暖光，视线会自己收到中间，用户会觉得
 * "这里是我该看的地方"。纯白主题下 opacity 设成 0，不留痕迹。
 */

import {
  Group, Mesh, PlaneGeometry, MeshStandardMaterial, MeshBasicMaterial,
  CanvasTexture, AdditiveBlending, LinearFilter,
} from 'three';
import { SCENE } from '../config.js';

let glowTexture = null;

function getGlowTexture() {
  if (glowTexture) return glowTexture;

  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;

  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  // 多停几档，让边缘落得慢一点 —— 两档的线性渐变能看出明显的圆环边界
  g.addColorStop(0.00, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.70, 'rgba(255,255,255,0.16)');
  g.addColorStop(1.00, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);

  glowTexture = new CanvasTexture(canvas);
  glowTexture.minFilter = LinearFilter;
  glowTexture.magFilter = LinearFilter;
  return glowTexture;
}

export function buildBoard(themeScene) {
  const half = SCENE.trayHalf;
  const b = themeScene.board;
  const group = new Group();
  const disposables = [];

  // ── 地板 ──
  const floorGeo = new PlaneGeometry(half * 2, half * 2);
  const floorMat = new MeshStandardMaterial({
    color: b.color,
    roughness: b.roughness,
    metalness: b.metalness,
  });
  const floor = new Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  group.add(floor);
  disposables.push(floorGeo, floorMat);

  // ── 中央柔光 ──
  let glow = null;
  if (b.glow && b.glow.opacity > 0) {
    const glowGeo = new PlaneGeometry(b.glow.radius * 2, b.glow.radius * 2);
    const glowMat = new MeshBasicMaterial({
      map: getGlowTexture(),
      color: b.glow.color,
      transparent: true,
      opacity: b.glow.opacity,
      blending: AdditiveBlending,
      depthWrite: false,     // 不写深度，否则会挡住骰子的阴影
      toneMapped: false,     // 柔光是"光线"不是"物体"，不该被色调映射压暗
    });
    glow = new Mesh(glowGeo, glowMat);
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = 0.004;   // 抬高一点，避免与地板 z-fighting
    glow.renderOrder = 1;
    group.add(glow);
    disposables.push(glowGeo, glowMat);
  }

  // ── 四边矮框 ──
  // 只是视觉边界。挡骰子的物理墙高 2.0，比这个高得多，也看不见
  const rimH = 0.09;
  const rimT = 0.08;
  const rimMat = new MeshStandardMaterial({
    color: b.wall,
    roughness: 0.65,
    metalness: 0.1,
  });
  const rimGeoLong = new PlaneGeometry(half * 2 + rimT * 2, rimH);
  const rimGeoSide = new PlaneGeometry(half * 2 + rimT * 2, rimH);

  const rimDefs = [
    { pos: [0, rimH / 2, half + rimT], rotY: 0 },
    { pos: [0, rimH / 2, -half - rimT], rotY: Math.PI },
    { pos: [half + rimT, rimH / 2, 0], rotY: Math.PI / 2 },
    { pos: [-half - rimT, rimH / 2, 0], rotY: -Math.PI / 2 },
  ];

  const rims = [];
  for (let i = 0; i < rimDefs.length; i++) {
    const d = rimDefs[i];
    const m = new Mesh(i < 2 ? rimGeoLong : rimGeoSide, rimMat);
    m.position.set(...d.pos);
    m.rotation.y = d.rotY;
    m.receiveShadow = true;
    group.add(m);
    rims.push(m);
  }
  disposables.push(rimGeoLong, rimGeoSide, rimMat);

  return {
    group,
    floor,
    glow,
    rims,
    dispose() {
      for (const d of disposables) d.dispose();
      group.removeFromParent();
    },
  };
}

/** 整页重建时才调。贴图是跨主题共享的，不该每次换主题都重造 */
export function disposeGlowTexture() {
  glowTexture?.dispose();
  glowTexture = null;
}
