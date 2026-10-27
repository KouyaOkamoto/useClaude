// Kenney のモデル（CC0）を読み込んで、使うたびに複製する。
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import * as SkeletonUtils from "three/addons/utils/SkeletonUtils.js";

const MODELS = {
  td: [
    "tile", "tile-straight", "tile-corner-round", "tile-split", "tile-crossing", "tile-spawn",
    "tile-tree", "tile-tree-double", "tile-rock", "tile-crystal", "detail-tree", "detail-rocks",
    "tower-round-bottom-a", "tower-round-middle-a", "tower-round-top-a",
    "tower-square-bottom-b", "tower-square-middle-b", "tower-square-top-b",
    "tower-round-bottom-c", "tower-round-middle-c", "tower-round-top-c",
    "weapon-ballista", "weapon-cannon", "weapon-catapult",
    "weapon-ammo-arrow", "weapon-ammo-cannonball", "weapon-ammo-boulder", "weapon-ammo-bullet",
    "enemy-ufo-a", "enemy-ufo-a-weapon", "enemy-ufo-b-weapon", "enemy-ufo-beam", "selection-a",
  ],
  dungeon: [
    "character-orc", "character-human", "coin", "potion",
    "weapon-spear", "weapon-sword", "shield-round", "shield-rectangle",
  ],
  castle: [
    "wall-doorway", "tower-square-roof",
    "tower-hexagon-base", "tower-hexagon-mid", "tower-hexagon-roof", "flag",
  ],
};

const templates = new Map();   // 名前 → { scene, animations, size }

export async function loadAssets(onProgress) {
  const loader = new GLTFLoader();
  const list = Object.entries(MODELS).flatMap(([kit, names]) => names.map(name => ({ kit, name })));
  let done = 0;
  await Promise.all(list.map(async ({ kit, name }) => {
    const gltf = await loader.loadAsync(`assets/${kit}/${name}.glb`);
    gltf.scene.traverse(o => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    const box = new THREE.Box3().setFromObject(gltf.scene);
    templates.set(name, { scene: gltf.scene, animations: gltf.animations, box });
    onProgress?.(++done / list.length);
  }));
}

// 複製を作る。骨組みのある（動く）モデルは骨ごと複製する
export function make(name) {
  const t = templates.get(name);
  if (!t) throw new Error(`モデルがありません: ${name}`);
  return t.animations.length ? SkeletonUtils.clone(t.scene) : t.scene.clone();
}

export const animationsOf = name => templates.get(name).animations;
export const heightOf = name => templates.get(name).box.max.y;
