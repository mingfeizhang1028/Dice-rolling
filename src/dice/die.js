/**
 * 一颗骰子 = three 的显示对象 + cannon 的刚体。
 *
 * 显示对象是个 Group：本体 mesh 做子节点，点数 mesh 挂在本体下面。
 * 点数几何体本来就是按本体局部坐标造的（原点在骰子中心），
 * 所以作为子节点时保持单位变换即可，不需要额外补偿。
 *
 * 材质缓存分两层：
 *   本体材质 按 (材质, slot) 缓存 —— 同一材质不同颗要用 colorAlt 区分色
 *   点数材质 按 材质 缓存     —— 同材质所有颗的点数长得一样
 */

import { Group, Mesh, MeshPhysicalMaterial } from 'three';
import { getBodyGeometry, getPipGeometry } from './geometry.js';
import { getMaterial, dieColor } from '../materials.js';
import { createDieBody } from '../physics/world.js';

const bodyMaterialCache = new Map();   // `${materialId}:${slot}`
const pipMaterialCache = new Map();    // materialId

export function getBodyMaterial(materialId, slot) {
  const key = `${materialId}:${slot}`;
  const cached = bodyMaterialCache.get(key);
  if (cached) return cached;

  const v = getMaterial(materialId).visual;
  const mat = new MeshPhysicalMaterial({
    color: dieColor(materialId, slot),
    metalness: v.metalness,
    roughness: v.roughness,
    ior: v.ior,
    clearcoat: v.clearcoat,
    clearcoatRoughness: v.clearcoatRoughness,
    envMapIntensity: v.envMapIntensity,
  });

  // transmission 相关参数只在真的开透射时才设。
  // 恒为 0 的材质带上这些参数会让 three 认为它是透射材质，白白多一遍渲染
  if (v.transmission > 0) {
    mat.transmission = v.transmission;
    mat.thickness = v.thickness;
    mat.attenuationColor.setHex(v.attenuationColor);
    mat.attenuationDistance = v.attenuationDistance;
  }

  // 主题切换靠乘系数改这两个值，所以必须记住基准，否则会越乘越小
  mat.userData.baseEnvMapIntensity = v.envMapIntensity;
  mat.userData.baseClearcoat = v.clearcoat;
  mat.userData.baseTransmission = v.transmission;

  bodyMaterialCache.set(key, mat);
  return mat;
}

export function getPipMaterial(materialId) {
  const cached = pipMaterialCache.get(materialId);
  if (cached) return cached;

  const pip = getMaterial(materialId).pip;
  // 点数一律非金属、偏哑光。凹坑和涂层都是"不怎么反光"的，
  // 只有让它们哑光，才会读成"刻进去的"而不是"贴上去的亮片"
  const mat = new MeshPhysicalMaterial({
    color: pip.color,
    metalness: 0.0,
    roughness: pip.roughness ?? 0.5,
    clearcoat: 0.0,
  });

  pipMaterialCache.set(materialId, mat);
  return mat;
}

/**
 * 造一颗骰子。
 *
 * @param {object} opts
 * @param {string} opts.materialId
 * @param {number} opts.slot      0..2，决定区分色
 * @param {CANNON.World} opts.world
 * @param {string} [opts.name]    名字。平时不显示，虚按时才浮出来
 */
export function createDie({ materialId, slot, world, name = '' }) {
  const group = new Group();

  const bodyMesh = new Mesh(getBodyGeometry(), getBodyMaterial(materialId, slot));
  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = true;
  group.add(bodyMesh);

  const pipMesh = new Mesh(getPipGeometry(materialId), getPipMaterial(materialId));
  // 点数不投影：它们嵌在本体轮廓内部，投影只会白白增加阴影贴图负担
  pipMesh.castShadow = false;
  pipMesh.receiveShadow = true;
  bodyMesh.add(pipMesh);

  // slot 要传下去：碰撞事件靠它认出是哪一颗，声音才能按材质分，
  // 声场定位也才能对上屏幕上那颗骰子
  const body = createDieBody(materialId, slot);
  world.addBody(body);

  const die = {
    slot,
    materialId,
    name,
    group,
    bodyMesh,
    pipMesh,
    body,

    /** 把物理状态同步到显示对象。每帧调用 */
    sync() {
      group.position.copy(body.position);
      group.quaternion.copy(body.quaternion);
    },

    /** 换材质（P3 设置里用）。物理和外观一起换，不用重建刚体 */
    setMaterial(nextId, nextSlot = slot) {
      die.materialId = nextId;
      die.slot = nextSlot;
      bodyMesh.material = getBodyMaterial(nextId, nextSlot);
      // 点数几何体是按材质造的（半径/凸出量不同），所以几何体和材质都要换
      pipMesh.geometry = getPipGeometry(nextId);
      pipMesh.material = getPipMaterial(nextId);
    },

    dispose() {
      world.removeBody(body);
      group.removeFromParent();
    },
  };

  die.sync();
  return die;
}

/** 一批骰子全扔了。几何体/材质是共享缓存的，不在这里释放 */
export function disposeDice(dice, world) {
  for (const d of dice) d.dispose();
  dice.length = 0;
}

/** 释放共享材质缓存。只在整页重建时用（P3 的主题 dispose 纪律） */
export function disposeDieMaterials() {
  for (const m of bodyMaterialCache.values()) m.dispose();
  for (const m of pipMaterialCache.values()) m.dispose();
  bodyMaterialCache.clear();
  pipMaterialCache.clear();
}
