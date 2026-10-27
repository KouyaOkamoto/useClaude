// 惑星の景色を three.js で描く: 地面・海・空・植物。
// 地面はカメラのまわりに「近いほど細かい」格子を何重にも置き、高さはシェーダーで地形のテクスチャから読む。

import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js";
import { hsl, mix, rng } from "./planet.js";

export const WORLD = 12000;     // 地形の一辺 (m)

const GRID = 64;                // 1段の格子のマス数
const LEVELS = 8;
const BASE_CELL = 2;            // 一番細かい段のマスの大きさ (m)

// 地形の高さ（テクスチャから4点を読んで補間）と、簡単なノイズ
const COMMON = /* glsl */ `
  uniform sampler2D uHeight;
  uniform float uN;
  uniform float uWorld;
  uniform vec3 uCam;
  float heightAt(vec2 p) {
    vec2 t = clamp((p / uWorld + 0.5) * (uN - 1.0), vec2(0.0), vec2(uN - 1.001));
    ivec2 i = ivec2(floor(t));
    vec2 f = t - vec2(i);
    float a = texelFetch(uHeight, i, 0).r, b = texelFetch(uHeight, i + ivec2(1, 0), 0).r;
    float c = texelFetch(uHeight, i + ivec2(0, 1), 0).r, d = texelFetch(uHeight, i + ivec2(1, 1), 0).r;
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }
`;

// 遠くほど大気の色に霞む。太陽の方を見ると霞が明るく色づく
const FOG = /* glsl */ `
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  vec3 applyFog(vec3 col, vec3 world) {
    vec3 d = world - uCam;
    float dist = length(d);
    float f = 1.0 - exp(-pow(dist * uFogDensity, 2.0));
    float sun = pow(max(dot(d / dist, uSunDir), 0.0), 8.0);
    return mix(col, uFogColor + uSunColor * sun * 0.25, f);
  }
`;

const LIGHT = /* glsl */ `
  uniform vec3 uSunLight;
  uniform vec3 uAmbient;
`;

export function createWorld(scene) {
  // 惑星ごとに入れ替える値（すべてのシェーダーで同じオブジェクトを共有する）
  const shared = {
    uHeight: { value: null },
    uN: { value: 2 },
    uWorld: { value: WORLD },
    uCam: { value: new THREE.Vector3() },
    uFogColor: { value: new THREE.Color() },
    uFogDensity: { value: 0.0002 },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color() },
    uSunLight: { value: new THREE.Color() },
    uAmbient: { value: new THREE.Color() },
    uTime: { value: 0 },
  };

  // --- 地面 ---
  const terrainUniforms = {
    ...shared,
    uMap: { value: null },
    uGround: { value: new THREE.Color() },
    uGround2: { value: new THREE.Color() },
    uRock: { value: new THREE.Color() },
    uSand: { value: new THREE.Color() },
    uSnow: { value: new THREE.Color() },
    uWater: { value: 0 },
    uSnowH: { value: 1e5 },
  };
  const terrainVertex = /* glsl */ `
    ${COMMON}
    attribute vec2 grid;
    uniform float uCell;
    uniform float uLevelHalf;
    uniform float uMorph;
    uniform vec2 uCenter;
    varying vec3 vWorld;
    void main() {
      vec2 p = uCenter + grid * uCell;
      // 外側に近い頂点は、一段粗い格子の位置へ寄せて、段の境目をつなぐ
      float d = max(abs(p.x - uCam.x), abs(p.y - uCam.z)) / uLevelHalf;
      p -= mod(grid, 2.0) * uCell * uMorph * smoothstep(0.62, 0.85, d);
      float h = heightAt(p);
      // 近くには細かい凹凸を足す（地形の格子より細かい起伏）
      float near = 1.0 - smoothstep(150.0, 450.0, length(p - uCam.xz));
      h += ((vnoise(p * 0.12) - 0.5) * 2.4 + (vnoise(p * 0.45) - 0.5) * 0.7) * near;
      vWorld = vec3(p.x, h, p.y);
      gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
    }
  `;
  const terrainFragment = /* glsl */ `
    ${COMMON}
    ${FOG}
    ${LIGHT}
    uniform sampler2D uMap;
    uniform vec3 uGround, uGround2, uRock, uSand, uSnow;
    uniform float uWater, uSnowH;
    varying vec3 vWorld;
    void main() {
      vec2 p = vWorld.xz;
      vec4 m = texture2D(uMap, ((p / uWorld + 0.5) * (uN - 1.0) + 0.5) / uN);
      vec2 nxz = m.rg * 2.0 - 1.0;
      vec3 n = normalize(vec3(nxz.x, sqrt(max(0.0, 1.0 - dot(nxz, nxz))), nxz.y));
      float flow = m.b;
      float slope = 1.0 - n.y;
      float n1 = vnoise(p * 0.004), n2 = vnoise(p * 0.03), n3 = vnoise(p * 0.3);

      vec3 col = mix(uGround, uGround2, smoothstep(0.3, 0.7, n1));
      col = mix(col, uGround * 0.72, smoothstep(0.15, 0.7, flow));          // 水の集まる谷は濃く
      float rock = smoothstep(0.2, 0.34, slope + (n2 - 0.5) * 0.12);
      col = mix(col, uRock * (0.8 + 0.4 * n2), rock);
      float beach = 1.0 - smoothstep(uWater + 1.0, uWater + 5.0 + n2 * 6.0, vWorld.y);
      col = mix(col, uSand, beach * (1.0 - rock * 0.6));
      float snow = smoothstep(uSnowH - 30.0, uSnowH + 15.0, vWorld.y + (n1 - 0.5) * 90.0) * (1.0 - smoothstep(0.32, 0.55, slope));
      col = mix(col, uSnow, snow);
      col *= 0.86 + 0.28 * n3;

      float diff = max(dot(n, uSunDir), 0.0);
      col *= uSunLight * diff + uAmbient * (0.55 + 0.45 * n.y);
      gl_FragColor = vec4(applyFog(col, vWorld), 1.0);
    }
  `;

  // 段ごとの格子。2段目からは真ん中に穴を開ける（内側は一段細かい格子が受け持つ）
  function gridGeometry(hole) {
    const half = GRID / 2;
    const verts = [];
    for (let j = -half; j <= half; j++) for (let i = -half; i <= half; i++) verts.push(i, j);
    const index = [];
    const at = (i, j) => (j + half) * (GRID + 1) + (i + half);
    const inner = GRID / 4 - 1;
    for (let j = -half; j < half; j++) {
      for (let i = -half; i < half; i++) {
        if (hole && i >= -inner && i + 1 <= inner && j >= -inner && j + 1 <= inner) continue;
        index.push(at(i, j), at(i, j + 1), at(i + 1, j), at(i + 1, j), at(i, j + 1), at(i + 1, j + 1));
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("grid", new THREE.Float32BufferAttribute(verts, 2));
    // three.js が位置を要求するので、形だけの position を入れておく（実際の位置はシェーダーで決める）
    geo.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(verts.length * 1.5), 3));
    geo.setIndex(index);
    return geo;
  }
  const fullGrid = gridGeometry(false), ringGrid = gridGeometry(true);
  const levels = [];
  for (let l = 0; l < LEVELS; l++) {
    const cell = BASE_CELL * 2 ** l;
    const material = new THREE.ShaderMaterial({
      uniforms: {
        ...terrainUniforms,
        uCell: { value: cell },
        uLevelHalf: { value: (GRID / 2) * cell },
        uMorph: { value: l < LEVELS - 1 ? 1 : 0 },
        uCenter: { value: new THREE.Vector2() },
      },
      vertexShader: terrainVertex,
      fragmentShader: terrainFragment,
    });
    const mesh = new THREE.Mesh(l === 0 ? fullGrid : ringGrid, material);
    mesh.frustumCulled = false;
    scene.add(mesh);
    levels.push({ cell, mesh });
  }

  // --- 海 ---
  const waterUniforms = {
    ...shared,
    uWater: terrainUniforms.uWater,
    uShallow: { value: new THREE.Color() },
    uDeep: { value: new THREE.Color() },
    uZenith: { value: new THREE.Color() },
    uHorizon: { value: new THREE.Color() },
    uFrozen: { value: 0 },
  };
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(80000, 80000).rotateX(-Math.PI / 2),
    new THREE.ShaderMaterial({
      uniforms: waterUniforms,
      transparent: true,
      depthWrite: false,
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        void main() {
          vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
          gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        ${COMMON}
        ${FOG}
        ${LIGHT}
        uniform float uWater, uFrozen, uTime;
        uniform vec3 uShallow, uDeep, uZenith, uHorizon;
        varying vec3 vWorld;
        void main() {
          vec2 q = vWorld.xz;
          float t = uTime;
          float depth = uWater - heightAt(q);
          float dist = length(uCam - vWorld);
          // 波: 向きの違う波を重ね、遠くでは弱めてちらつきを抑える
          float k = (1.0 - uFrozen) / (1.0 + dist / 400.0);
          vec3 n = normalize(vec3(
            (sin(q.x * 0.07 + t * 1.1) * 0.5 + sin(q.x * 0.21 + q.y * 0.13 + t * 1.7) * 0.3 + (vnoise(q * 0.4 + t) - 0.5) * 0.4) * k,
            4.0,
            (sin(q.y * 0.09 - t * 1.3) * 0.5 + sin(q.y * 0.23 - q.x * 0.11 + t * 2.1) * 0.3 + (vnoise(q.yx * 0.4 - t) - 0.5) * 0.4) * k));
          vec3 view = normalize(uCam - vWorld);
          float fres = 0.02 + 0.98 * pow(1.0 - max(dot(n, view), 0.0), 5.0);
          vec3 r = reflect(-view, n);
          vec3 sky = mix(uHorizon, uZenith, pow(clamp(r.y, 0.0, 1.0), 0.5));
          vec3 base = mix(uShallow, uDeep, smoothstep(0.0, 30.0, depth)) * (uAmbient + uSunLight * max(uSunDir.y, 0.0));
          vec3 col = mix(base, sky, fres * mix(0.9, 0.35, uFrozen));
          col += uSunLight * pow(max(dot(r, uSunDir), 0.0), 250.0) * 2.5 * (1.0 - uFrozen);
          float foam = (1.0 - smoothstep(0.0, 1.6, depth)) * smoothstep(0.45, 0.6, vnoise(q * 0.5 + t * 0.4)) * (1.0 - uFrozen);
          col = mix(col, (uAmbient + uSunLight) * 0.95, foam * 0.7);
          float alpha = uFrozen > 0.5 ? 1.0 : mix(0.35, 0.95, smoothstep(0.0, 7.0, depth));
          gl_FragColor = vec4(applyFog(col, vWorld), alpha);
        }
      `,
    }),
  );
  water.frustumCulled = false;
  water.renderOrder = 1;
  scene.add(water);

  // --- 空 ---
  const skyUniforms = {
    ...shared,
    uZenith: waterUniforms.uZenith,
    uHorizon: waterUniforms.uHorizon,
    uSunSize: { value: 0.03 },
    uNight: { value: 0 },
    uMoonDir: { value: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] },
    uMoonColor: { value: [new THREE.Color(), new THREE.Color(), new THREE.Color()] },
    uMoonSize: { value: [0, 0, 0] },
    uMoonCount: { value: 0 },
    uRingOn: { value: 0 },
    uRingNormal: { value: new THREE.Vector3(0, 0, 1) },
    uRingColor: { value: new THREE.Color() },
    uRingRadii: { value: new THREE.Vector2(1.5, 2.5) },
  };
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(40000, 32, 16),
    new THREE.ShaderMaterial({
      uniforms: skyUniforms,
      side: THREE.BackSide,
      depthWrite: false,
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        void main() {
          vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
          gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        ${COMMON}
        uniform vec3 uZenith, uHorizon, uSunDir, uSunColor;
        uniform float uSunSize, uNight;
        uniform vec3 uMoonDir[3];
        uniform vec3 uMoonColor[3];
        uniform float uMoonSize[3];
        uniform int uMoonCount;
        uniform float uRingOn;
        uniform vec3 uRingNormal, uRingColor;
        uniform vec2 uRingRadii;
        varying vec3 vWorld;
        void main() {
          vec3 dir = normalize(vWorld - uCam);
          vec3 col = mix(uHorizon, uZenith, pow(clamp(dir.y, 0.0, 1.0), 0.45));
          if (dir.y < 0.0) col = uHorizon * mix(1.0, 0.8, clamp(-dir.y * 4.0, 0.0, 1.0));
          float sd = max(dot(dir, uSunDir), 0.0);
          col += uSunColor * (pow(sd, 6.0) * 0.18 + pow(sd, 64.0) * 0.35);

          // 星（夜と、大気の薄い惑星）
          vec3 c = floor(dir * 300.0);
          float star = step(0.9972, hash(c.xy + c.z * 17.31)) * (0.4 + 0.6 * hash(c.yz + 3.7));
          col += star * uNight * smoothstep(-0.02, 0.15, dir.y);

          // 環: 足もとの惑星の中心を通る板と、視線が交わる所に帯を描く
          if (uRingOn > 0.5 && dir.y > -0.02) {
            vec3 center = vec3(0.0, -1.0, 0.0);
            float denom = dot(dir, uRingNormal);
            float t = dot(center, uRingNormal) / denom;
            if (t > 0.0) {
              float rr = length(dir * t - center);
              if (rr > uRingRadii.x && rr < uRingRadii.y) {
                float band = 0.55 + 0.45 * sin(rr * 41.0) * sin(rr * 13.0 + 1.0);
                float edge = smoothstep(uRingRadii.x, uRingRadii.x + 0.06, rr) * smoothstep(uRingRadii.y, uRingRadii.y - 0.12, rr);
                float lit = 0.35 + 0.65 * max(uSunDir.y + 0.2, 0.0);
                col = mix(col, uRingColor * lit, band * edge * 0.65);
              }
            }
          }

          // 衛星: 太陽の向きから満ち欠けを付ける
          for (int i = 0; i < 3; i++) {
            if (i >= uMoonCount) break;
            float md = dot(dir, uMoonDir[i]);
            float r = sin(uMoonSize[i]);
            vec3 local = (dir - uMoonDir[i] * md) / r;
            float l2 = dot(local, local);
            if (md > 0.0 && l2 < 1.0) {
              vec3 normal = local + uMoonDir[i] * sqrt(1.0 - l2);
              float lit = smoothstep(-0.05, 0.25, dot(normal, uSunDir));
              vec3 moon = uMoonColor[i] * (0.06 + 0.94 * lit);
              col = mix(col, moon, mix(1.0, 0.75, 1.0 - uNight) * smoothstep(1.0, 0.92, l2));
            }
          }

          // 太陽
          float disc = smoothstep(cos(uSunSize), cos(uSunSize * 0.8), dot(dir, uSunDir));
          col = mix(col, uSunColor * 1.5 + 0.2, disc);
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    }),
  );
  sky.renderOrder = -1;
  sky.frustumCulled = false;
  scene.add(sky);

  // --- 植物 ---
  const sunLight = new THREE.DirectionalLight(0xffffff, Math.PI);
  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, Math.PI);
  scene.add(sunLight, sunLight.target, hemi);
  scene.fog = new THREE.FogExp2(0xffffff, 0.0002);
  let flora = [];

  // --- 惑星の入れ替え ---
  let planet = null, data = null;
  const heightTex = { tex: null }, mapTex = { tex: null };

  function setPlanet(p, terrain) {
    planet = p;
    const n = Math.round(Math.sqrt(terrain.heights.length));
    // 水面の高さは「地形の何割が海に沈むか」から決める
    const sorted = terrain.heights.filter((_, i) => i % 7 === 0).sort();
    const max = sorted[sorted.length - 1];
    const waterLevel = p.waterFraction > 0 ? sorted[Math.floor(sorted.length * p.waterFraction)] : sorted[0] - 50;
    const snowH = p.snowLine < 0 ? -1e5 : p.snowLine > 1 ? 1e5 : waterLevel + (max - waterLevel) * p.snowLine;
    data = { ...terrain, n, waterLevel, snowH, maxH: max };

    heightTex.tex?.dispose();
    mapTex.tex?.dispose();
    heightTex.tex = new THREE.DataTexture(terrain.heights, n, n, THREE.RedFormat, THREE.FloatType);
    heightTex.tex.needsUpdate = true;
    mapTex.tex = new THREE.DataTexture(terrain.map, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
    mapTex.tex.magFilter = THREE.LinearFilter;
    mapTex.tex.minFilter = THREE.LinearMipmapLinearFilter;
    mapTex.tex.generateMipmaps = true;
    mapTex.tex.needsUpdate = true;
    shared.uHeight.value = heightTex.tex;
    terrainUniforms.uMap.value = mapTex.tex;
    shared.uN.value = n;

    const set = (u, rgb) => u.value.setRGB(...rgb);
    set(terrainUniforms.uGround, p.ground);
    set(terrainUniforms.uGround2, p.ground2);
    set(terrainUniforms.uRock, p.rock);
    set(terrainUniforms.uSand, p.sand);
    set(terrainUniforms.uSnow, p.type === "ice" ? p.ground : [0.93, 0.95, 0.98]);
    terrainUniforms.uWater.value = waterLevel;
    terrainUniforms.uSnowH.value = snowH;
    set(waterUniforms.uShallow, p.water.shallow);
    set(waterUniforms.uDeep, p.water.deep);
    waterUniforms.uFrozen.value = p.water.frozen ? 1 : 0;
    water.visible = p.waterFraction > 0;
    water.position.y = waterLevel;

    skyUniforms.uSunSize.value = p.sunSize;
    skyUniforms.uMoonCount.value = p.moons.length;
    p.moons.forEach((m, i) => {
      skyUniforms.uMoonDir.value[i].set(Math.cos(m.el) * Math.sin(m.az), Math.sin(m.el), Math.cos(m.el) * Math.cos(m.az));
      skyUniforms.uMoonColor.value[i].setRGB(...m.color);
      skyUniforms.uMoonSize.value[i] = m.size;
    });
    skyUniforms.uRingOn.value = p.rings ? 1 : 0;
    if (p.rings) {
      const { tilt, turn } = p.rings;
      skyUniforms.uRingNormal.value.set(Math.sin(tilt) * Math.cos(turn), Math.cos(tilt), Math.sin(tilt) * Math.sin(turn)).normalize();
      set(skyUniforms.uRingColor, p.rings.color);
      skyUniforms.uRingRadii.value.set(p.rings.inner, p.rings.inner + p.rings.width);
    }
    buildFlora();
    lastFloraCenter = null;
  }

  // 地形の高さ（JS 側。カメラの当たり判定と植物の配置に使う）
  function heightAt(x, z) {
    if (!data) return 0;
    const { n, heights } = data;
    const tx = Math.min(Math.max((x / WORLD + 0.5) * (n - 1), 0), n - 1.001);
    const tz = Math.min(Math.max((z / WORLD + 0.5) * (n - 1), 0), n - 1.001);
    const i = Math.floor(tx), j = Math.floor(tz), fx = tx - i, fz = tz - j;
    const a = heights[j * n + i], b = heights[j * n + i + 1], c = heights[(j + 1) * n + i], d = heights[(j + 1) * n + i + 1];
    return (a * (1 - fx) + b * fx) * (1 - fz) + (c * (1 - fx) + d * fx) * fz;
  }
  function mapAt(x, z) {
    const { n, map } = data;
    const i = Math.min(Math.max(Math.round((x / WORLD + 0.5) * (n - 1)), 0), n - 1);
    const j = Math.min(Math.max(Math.round((z / WORLD + 0.5) * (n - 1)), 0), n - 1);
    const o = (j * n + i) * 4;
    const nx = map[o] / 127.5 - 1, nz = map[o + 1] / 127.5 - 1;
    return { ny: Math.sqrt(Math.max(0, 1 - nx * nx - nz * nz)), flow: map[o + 2] / 255 };
  }

  // --- 植物（カメラのまわりだけ、タイルごとに決まった場所に生やす） ---
  const TILE = 48;
  const floraRadius = matchMedia("(pointer: coarse)").matches ? 550 : 900;
  let lastFloraCenter = null;

  function partsFor(kind, leaf, trunk, accent) {
    const parts = [];
    const add = (geo, color, y = 0, sx = 1, sy = 1, sz = 1, x = 0, rotZ = 0) => {
      geo = geo.toNonIndexed();
      geo.scale(sx, sy, sz);
      if (rotZ) geo.rotateZ(rotZ);
      geo.translate(x, y, 0);
      parts.push({ geo, color });
    };
    switch (kind) {
      case "broadleaf":
        add(new THREE.CylinderGeometry(0.25, 0.4, 4, 6), trunk, 2);
        add(new THREE.IcosahedronGeometry(3, 0), leaf, 5.6, 1, 0.85, 1);
        add(new THREE.IcosahedronGeometry(2, 0), leaf, 7.2, 1, 0.8, 1, 0.8);
        break;
      case "conifer":
        add(new THREE.CylinderGeometry(0.2, 0.35, 3, 6), trunk, 1.5);
        add(new THREE.ConeGeometry(2.6, 5, 7), leaf, 5);
        add(new THREE.ConeGeometry(1.9, 4, 7), leaf, 7.6);
        break;
      case "bush":
        add(new THREE.IcosahedronGeometry(1.6, 0), leaf, 0.9, 1.3, 0.7, 1.3);
        break;
      case "palm":
        add(new THREE.CylinderGeometry(0.18, 0.3, 8, 6), trunk, 4, 1, 1, 1, 0.4, -0.1);
        add(new THREE.ConeGeometry(3.6, 1.2, 7), leaf, 8.2, 1, 1, 1, 0.8);
        break;
      case "mushroom":
        add(new THREE.CylinderGeometry(0.45, 0.65, 5, 7), [0.86, 0.84, 0.78], 2.5);
        add(new THREE.SphereGeometry(3, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2), accent, 4.8, 1, 0.6, 1);
        break;
      case "spire":
        add(new THREE.ConeGeometry(0.9, 9, 5), accent, 4.5);
        add(new THREE.ConeGeometry(0.6, 5, 5), leaf, 2.5, 1, 1, 1, 1.1, 0.25);
        break;
      case "crystal":
        add(new THREE.OctahedronGeometry(1.2, 0), accent, 2.6, 0.55, 2.4, 0.55);
        add(new THREE.OctahedronGeometry(0.8, 0), accent, 1.4, 0.5, 2, 0.5, 0.9, 0.5);
        break;
      case "cactus":
        add(new THREE.CylinderGeometry(0.5, 0.6, 4.5, 7), leaf, 2.25);
        add(new THREE.CylinderGeometry(0.32, 0.32, 1.4, 6), leaf, 2.4, 1, 1, 1, 0.9, Math.PI / 2);
        add(new THREE.CylinderGeometry(0.3, 0.3, 1.6, 6), leaf, 3.1, 1, 1, 1, 1.5);
        break;
    }
    // 頂点色付きで1つにまとめる
    const count = parts.reduce((s, p) => s + p.geo.attributes.position.count, 0);
    const pos = new Float32Array(count * 3), col = new Float32Array(count * 3);
    let o = 0;
    for (const p of parts) {
      pos.set(p.geo.attributes.position.array, o * 3);
      for (let i = 0; i < p.geo.attributes.position.count; i++) col.set(p.color, (o + i) * 3);
      o += p.geo.attributes.position.count;
      p.geo.dispose();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    geo.computeVertexNormals();
    return geo;
  }

  function buildFlora() {
    for (const f of flora) {
      scene.remove(f.mesh);
      f.mesh.geometry.dispose();
      f.mesh.material.dispose();
      f.mesh.dispose();
    }
    flora = [];
    const p = planet;
    const r = rng(p.seed ^ 0x51ed);
    const leaf = hsl(p.flora.hue, 0.45, 0.3);
    const trunk = mix(p.rock, [0.3, 0.2, 0.12], 0.6);
    const accent = hsl(p.flora.hue + 40 * (r() - 0.5), 0.6, 0.55);
    const tiles = Math.ceil(Math.PI * (floraRadius / TILE + 1) ** 2);
    const perTile = Math.round(7 * p.flora.density);
    for (const kind of [...new Set(p.flora.kinds)]) {
      const glow = kind === "crystal";
      const material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
      if (glow) material.emissive.setRGB(...accent.map(v => v * 0.35));
      const mesh = new THREE.InstancedMesh(partsFor(kind, leaf, trunk, accent), material, tiles * perTile);
      mesh.count = 0;
      mesh.frustumCulled = false;
      scene.add(mesh);
      flora.push({ kind, mesh, perTile });
    }
  }

  // 大きな範囲で増えたり減ったりする茂り具合（森と草原のまだら）
  function patch(x, z) {
    const s = planet.seed;
    const cell = 350;
    const gx = Math.floor(x / cell), gz = Math.floor(z / cell), fx = x / cell - gx, fz = z / cell - gz;
    const h = (i, j) => rng((s * 73856093) ^ (i * 19349663) ^ (j * 83492791))();
    const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
    return (h(gx, gz) * (1 - u) + h(gx + 1, gz) * u) * (1 - v) + (h(gx, gz + 1) * (1 - u) + h(gx + 1, gz + 1) * u) * v;
  }

  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sv = new THREE.Vector3(), pv = new THREE.Vector3(), cv = new THREE.Color();
  const up = new THREE.Vector3(0, 1, 0);
  function placeFlora(cam) {
    if (!flora.length) return;
    if (lastFloraCenter && Math.hypot(cam.x - lastFloraCenter.x, cam.z - lastFloraCenter.z) < TILE) return;
    lastFloraCenter = { x: cam.x, z: cam.z };
    const counts = flora.map(() => 0);
    const tr = Math.ceil(floraRadius / TILE);
    const ctx = Math.floor(cam.x / TILE), ctz = Math.floor(cam.z / TILE);
    for (let tz = ctz - tr; tz <= ctz + tr; tz++) {
      for (let tx = ctx - tr; tx <= ctx + tr; tx++) {
        const dx = (tx + 0.5) * TILE - cam.x, dz = (tz + 0.5) * TILE - cam.z;
        if (dx * dx + dz * dz > floraRadius * floraRadius) continue;
        const r = rng((planet.seed * 2654435761) ^ (tx * 73856093) ^ (tz * 19349663));
        for (let k = 0; k < flora[0].perTile; k++) {
          const x = (tx + r()) * TILE, z = (tz + r()) * TILE;
          const pick = r() < 0.7 || flora.length === 1 ? 0 : 1;
          const scale = 0.65 + r() * 0.8, yaw = r() * Math.PI * 2, shade = 0.8 + r() * 0.35, chance = r();
          const h = heightAt(x, z);
          if (h < data.waterLevel + 2 || Math.abs(x) > WORLD * 0.45 || Math.abs(z) > WORLD * 0.45) continue;
          const { ny, flow } = mapAt(x, z);
          if (ny < 0.9) continue;
          const kind = flora[pick].kind;
          if (h > data.snowH && kind !== "crystal" && kind !== "conifer") continue;
          if (chance > (0.25 + flow * 0.9) * (0.15 + 1.1 * patch(x, z))) continue;
          const f = flora[pick];
          if (counts[pick] >= f.mesh.instanceMatrix.count) continue;
          q.setFromAxisAngle(up, yaw);
          m4.compose(pv.set(x, h - 0.3, z), q, sv.setScalar(scale));
          f.mesh.setMatrixAt(counts[pick], m4);
          f.mesh.setColorAt(counts[pick], cv.setScalar(shade));
          counts[pick]++;
        }
      }
    }
    flora.forEach((f, i) => {
      f.mesh.count = counts[i];
      f.mesh.instanceMatrix.needsUpdate = true;
      if (f.mesh.instanceColor) f.mesh.instanceColor.needsUpdate = true;
    });
  }

  // --- 時刻と光 ---
  // dayTime: 0 で日の出、0.25 で南中、0.5 で日の入り、0.5〜1 は夜
  const tmp = new THREE.Vector3();
  function setTime(dayTime) {
    const p = planet;
    const a = dayTime * Math.PI * 2;
    // 少し持ち上げて、昼が一日の3分の2ほどになるようにする
    tmp.set(Math.cos(a), Math.sin(a) * Math.sin(p.sunTilt) + 0.16, Math.sin(a) * Math.cos(p.sunTilt)).normalize().applyAxisAngle(up, p.sunAzimuth);
    const sunY = tmp.y;
    shared.uSunDir.value.copy(tmp);
    const smooth = (e0, e1, x) => {
      const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
      return t * t * (3 - 2 * t);
    };
    const day = smooth(-0.12, 0.18, sunY);
    const sunset = smooth(-0.15, 0.02, sunY) * (1 - smooth(0.02, 0.3, sunY));
    const atm = p.atmosphere;
    // 夜も真っ暗にはせず、月明かりの青い薄明かりにする
    const zenith = mix(mix(atm.zenith, [0, 0, 0], 0.9).map((v, i) => v + [0.012, 0.016, 0.04][i]), atm.zenith, day);
    const horizon = mix([0.07, 0.085, 0.14], mix(atm.horizon, atm.sunset, sunset * 0.85), day);
    const sunColor = mix(mix(p.star.color, atm.sunset, 0.6), p.star.color, smooth(0, 0.35, sunY));
    const light = sunColor.map(v => v * smooth(-0.03, 0.12, sunY) * 1.1);
    const moonGlow = 0.11 + p.moons.length * 0.025;
    const ambient = mix([moonGlow * 0.75, moonGlow * 0.9, moonGlow * 1.5], mix(horizon, zenith, 0.5).map(v => v * 0.6), day);

    waterUniforms.uZenith.value.setRGB(...zenith);
    waterUniforms.uHorizon.value.setRGB(...horizon);
    shared.uFogColor.value.setRGB(...horizon);
    shared.uSunColor.value.setRGB(...sunColor.map(v => v * smooth(-0.1, 0.05, sunY)));
    shared.uSunLight.value.setRGB(...light);
    shared.uAmbient.value.setRGB(...ambient);
    shared.uFogDensity.value = 0.000105 * atm.density;
    skyUniforms.uNight.value = Math.max(1 - day, (0.8 - atm.density) * 0.35);

    sunLight.position.copy(tmp).multiplyScalar(1000);
    sunLight.color.setRGB(...light);
    hemi.color.setRGB(...ambient);
    hemi.groundColor.setRGB(...ambient.map(v => v * 0.6));
    scene.fog.color.setRGB(...horizon);
    scene.fog.density = shared.uFogDensity.value;
    return { sunY, day };
  }

  function update(camera, time) {
    const cam = camera.position;
    shared.uCam.value.copy(cam);
    shared.uTime.value = time;
    for (const { cell, mesh } of levels) {
      const snap = cell * 2;
      mesh.material.uniforms.uCenter.value.set(Math.round(cam.x / snap) * snap, Math.round(cam.z / snap) * snap);
    }
    water.position.x = cam.x;
    water.position.z = cam.z;
    sky.position.copy(cam);
    sunLight.target.position.set(0, 0, 0);
    placeFlora(cam);
  }

  return {
    setPlanet,
    setTime,
    update,
    heightAt,
    get waterLevel() { return data?.waterLevel ?? -1e9; },
    get maxHeight() { return data?.maxH ?? 0; },
  };
}
