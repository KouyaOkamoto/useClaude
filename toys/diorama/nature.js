// 箱庭の中身: 地面・切り口・台座・湖・草・葦・岩・小石・針葉樹・桟橋
import * as THREE from "three";
import { Water } from "three/addons/objects/Water.js";
import { SIZE, HALF, BOTTOM, PIER, heightAt, slopeAt, forestness, lakeness, onPier, rng, noise2, fbm, smoothstep } from "./land.js";
import { groundTexture, detailNormal, waterNormals, woodTexture, soilTexture, barkTexture, needleTexture } from "./textures.js";

// 高さなどを格子で先に計算しておく（地面の形と色塗りの両方で使う）
export function buildGrid(n) {
  const heights = new Float32Array(n * n), forest = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = -HALF + (i / (n - 1)) * SIZE, z = -HALF + (j / (n - 1)) * SIZE;
      heights[j * n + i] = heightAt(x, z);
      forest[j * n + i] = forestness(x, z);
    }
  }
  return { n, heights, forest };
}

const detail = detailNormal();

// --- 地面と切り口と台座 ---
export function buildGround(grid, quality) {
  const group = new THREE.Group();
  const { n, heights } = grid;
  const geo = new THREE.PlaneGeometry(SIZE, SIZE, n - 1, n - 1).rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let k = 0; k < pos.count; k++) pos.setY(k, heights[k]);
  geo.computeVertexNormals();
  const { map, rough } = groundTexture(grid, quality.groundTexture);
  const ground = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    map, roughnessMap: rough, roughness: 1, normalMap: detail, normalScale: new THREE.Vector2(0.8, 0.8),
  }));
  ground.receiveShadow = true;
  ground.castShadow = true;
  group.add(ground);

  // 切り口: 四辺それぞれ、地面の高さから底までの壁。水に沈んだ所は水の断面も
  const soil = soilTexture();
  const soilMat = new THREE.MeshStandardMaterial({ map: soil, roughness: 0.95, normalMap: detail, normalScale: new THREE.Vector2(1.2, 1.2) });
  const waterSide = new THREE.MeshStandardMaterial({ color: 0x1f4a48, roughness: 0.05, transparent: true, opacity: 0.62, depthWrite: false });
  const edges = [
    (t) => [-HALF + t * SIZE, -HALF, 0, 0, -1],   // 奥
    (t) => [HALF - t * SIZE, HALF, 0, 0, 1],      // 手前
    (t) => [-HALF, HALF - t * SIZE, -1, 0, 0],    // 左
    (t) => [HALF, -HALF + t * SIZE, 1, 0, 0],     // 右
  ];
  for (const edge of edges) {
    const wall = [], wallUv = [], wallN = [], water = [];
    for (let k = 0; k < n; k++) {
      const t = k / (n - 1);
      const [x, z, nx, , nz] = edge(t);
      const h = heightAt(x, z);
      const depth = h - BOTTOM;
      wall.push(x, h, z, x, BOTTOM, z);
      wallUv.push(t * 5, 1, t * 5, 1 - depth / 9);
      wallN.push(nx, 0, nz, nx, 0, nz);
      water.push(x, Math.max(h, -0.001), z, x, Math.max(h, 0) - 0.02, z);
      void nz;
    }
    // 三角形の向きを、外向きの法線にそろえる（内向きだと箱の中から照らされてしまう）
    const [x0, , z0, nx0, , nz0] = edge(0), [x1, , z1] = edge(1);
    const outward = (x1 - x0) * nz0 - (z1 - z0) * nx0 > 0;
    const strip = (arr) => {
      const idx = [];
      for (let k = 0; k < n - 1; k++) {
        if (outward) idx.push(2 * k, 2 * k + 1, 2 * k + 2, 2 * k + 2, 2 * k + 1, 2 * k + 3);
        else idx.push(2 * k, 2 * k + 2, 2 * k + 1, 2 * k + 2, 2 * k + 3, 2 * k + 1);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(arr, 3));
      g.setIndex(idx);
      return g;
    };
    const wg = strip(wall);
    wg.setAttribute("uv", new THREE.Float32BufferAttribute(wallUv, 2));
    wg.setAttribute("normal", new THREE.Float32BufferAttribute(wallN, 3));
    const wm = new THREE.Mesh(wg, soilMat);
    wm.receiveShadow = true;
    group.add(wm);
    const wtr = strip(water);
    wtr.computeVertexNormals();
    group.add(new THREE.Mesh(wtr, waterSide));
  }

  // 底と台座
  const bottom = new THREE.Mesh(new THREE.PlaneGeometry(SIZE, SIZE).rotateX(Math.PI / 2), soilMat);
  bottom.position.y = BOTTOM;
  group.add(bottom);
  const wood = woodTexture([70, 46, 30]);
  wood.repeat.set(2, 1);
  const plinth = new THREE.Mesh(
    new THREE.BoxGeometry(SIZE + 2.4, 1.6, SIZE + 2.4),
    new THREE.MeshStandardMaterial({ map: wood, roughness: 0.45, metalness: 0 }),
  );
  plinth.position.y = BOTTOM - 0.8;
  plinth.receiveShadow = true;
  group.add(plinth);
  return group;
}

// --- 湖 ---
export function buildWater(quality, sunDir, grid) {
  const normals = waterNormals();
  const water = new Water(new THREE.PlaneGeometry(SIZE - 0.02, SIZE - 0.02), {
    textureWidth: quality.reflection,
    textureHeight: quality.reflection,
    waterNormals: normals,
    sunDirection: sunDir.clone(),
    sunColor: 0xffe2b8,
    waterColor: 0x0b2224,
    distortionScale: 0.6,
    fog: false,
  });
  water.rotation.x = -Math.PI / 2;
  water.material.uniforms.size.value = 1.6;

  // 浅い所は底が透けるように、水深を表すテクスチャを渡して透明度を変える
  const { n, heights } = grid;
  const depth = new Uint8Array(n * n * 4);
  for (let k = 0; k < n * n; k++) {
    const d = Math.min(Math.max(-heights[k], 0), 2) / 2;
    depth[k * 4] = d * 255;
    depth[k * 4 + 3] = 255;
  }
  const depthTex = new THREE.DataTexture(depth, n, n);
  depthTex.magFilter = THREE.LinearFilter;
  depthTex.needsUpdate = true;
  const m = water.material;
  m.transparent = true;
  m.uniforms.depthMap = { value: depthTex };
  m.fragmentShader = m.fragmentShader
    .replace("uniform sampler2D mirrorSampler;", "uniform sampler2D mirrorSampler;\nuniform sampler2D depthMap;")
    .replace(
      "gl_FragColor = vec4( outgoingLight, alpha );",
      `float depth = texture2D( depthMap, worldPosition.xz / ${SIZE.toFixed(1)} + 0.5 ).r * 2.0;
       float clear = 1.0 - smoothstep( 0.0, 0.9, depth );
       gl_FragColor = vec4( outgoingLight, alpha * mix( 0.97, 0.18, clear ) );`,
    );
  return water;
}

// --- 草 ---
// 1つのインスタンスは数本の葉の束。高さに応じて風で揺らす
function grassClump(blades, rand) {
  const pos = [], nrm = [], uv = [], idx = [];
  const SEG = 3;
  for (let b = 0; b < blades; b++) {
    const ox = (rand() - 0.5) * 0.22, oz = (rand() - 0.5) * 0.22;
    const yaw = rand() * Math.PI * 2, lean = 0.15 + rand() * 0.35, h = 0.6 + rand() * 0.5, w = 0.03 + rand() * 0.015;
    const dx = Math.cos(yaw), dz = Math.sin(yaw);
    const base = pos.length / 3;
    for (let s = 0; s <= SEG; s++) {
      const t = s / SEG;
      const bend = lean * t * t;
      const cx = ox + dx * bend, cz = oz + dz * bend, cy = h * t;
      const half = w * (1 - t * 0.92);
      pos.push(cx - dz * half, cy, cz + dx * half, cx + dz * half, cy, cz - dx * half);
      // 法線はほぼ上向き（薄い葉が柔らかく光を受けるように）
      nrm.push(dx * 0.3, 0.95, dz * 0.3, dx * 0.3, 0.95, dz * 0.3);
      uv.push(0, t, 1, t);
    }
    for (let s = 0; s < SEG; s++) {
      const a = base + s * 2;
      idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

const wind = { value: 0 };
export const windTime = wind;

function swayingMaterial(params, strength) {
  const mat = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, ...params });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = wind;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nuniform float uTime;\nvarying float vH;")
      .replace("#include <begin_vertex>", `#include <begin_vertex>
        vH = uv.y;
        vec3 ip = instanceMatrix[3].xyz;
        float w = uv.y * uv.y * ${strength.toFixed(2)};
        float gust = 0.6 + 0.4 * sin(uTime * 0.35 + ip.x * 0.05);
        transformed.x += (sin(uTime * 1.6 + ip.x * 0.7 + ip.z * 0.3) * 0.7 + sin(uTime * 3.7 + ip.z * 1.3) * 0.3) * w * gust;
        transformed.z += cos(uTime * 1.2 + ip.z * 0.6) * 0.5 * w * gust;`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vH;")
      .replace("#include <color_fragment>", "#include <color_fragment>\ndiffuseColor.rgb *= mix(0.32, 1.12, vH);");
  };
  return mat;
}

export function buildGrass(quality) {
  const rand = rng(31);
  const mesh = new THREE.InstancedMesh(grassClump(5, rand), swayingMaterial({ roughness: 0.75 }, 0.09), quality.grass);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), c = new THREE.Color();
  const greens = [[0.21, 0.32, 0.09], [0.3, 0.38, 0.12], [0.36, 0.38, 0.14], [0.18, 0.28, 0.1]];
  let count = 0, tries = 0;
  while (count < quality.grass && tries++ < quality.grass * 8) {
    const x = (rand() - 0.5) * (SIZE - 0.4), z = (rand() - 0.5) * (SIZE - 0.4);
    const h = heightAt(x, z);
    if (h < 0.12 || slopeAt(x, z) > 1.1 || onPier(x, z, 0.2)) continue;
    const f = forestness(x, z);
    if (rand() < f * 0.75) continue;
    // 岸の近くは背が高く、草地はまだらに
    const shore = 1 - smoothstep(0.15, 0.9, h);
    const patch = fbm(x * 0.2 + 5, z * 0.2, 3);
    if (rand() > 0.35 + patch * 0.9) continue;
    const s = 0.28 + rand() * 0.25 + shore * 0.35 + patch * 0.2;
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rand() * Math.PI * 2);
    m4.compose(new THREE.Vector3(x, h - 0.02, z), q, new THREE.Vector3(s, s * (0.8 + rand() * 0.5), s));
    mesh.setMatrixAt(count, m4);
    const g = greens[(rand() * greens.length) | 0];
    c.setRGB(g[0], g[1], g[2], THREE.SRGBColorSpace).multiplyScalar(0.85 + rand() * 0.3 + (1 - f) * 0.1);
    mesh.setColorAt(count, c);
    count++;
  }
  mesh.count = count;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  return mesh;
}

// --- 葦（岸辺の背の高い草）と蒲の穂 ---
export function buildReeds(quality) {
  const rand = rng(57);
  const group = new THREE.Group();
  const max = quality.reeds;
  const reeds = new THREE.InstancedMesh(grassClump(9, rand), swayingMaterial({ roughness: 0.7 }, 0.18), max);
  const heads = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.035, 0.22, 3, 6), new THREE.MeshStandardMaterial({ color: 0x4a2f1c, roughness: 0.9 }), max);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), c = new THREE.Color();
  let count = 0, headCount = 0, tries = 0;
  while (count < max && tries++ < max * 40) {
    const x = (rand() - 0.5) * (SIZE - 0.6), z = (rand() - 0.5) * (SIZE - 0.6);
    const h = heightAt(x, z);
    if (h > 0.35 || h < -0.45 || onPier(x, z, 0.6)) continue;
    if (fbm(x * 0.25 + 9, z * 0.25, 3) < 0.48) continue;   // 群生する所だけ
    const s = 1.4 + rand() * 0.9;
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rand() * Math.PI * 2);
    m4.compose(new THREE.Vector3(x, h, z), q, new THREE.Vector3(1.1, s, 1.1));
    reeds.setMatrixAt(count, m4);
    c.setRGB(0.36 + rand() * 0.1, 0.4 + rand() * 0.08, 0.16, THREE.SRGBColorSpace);
    reeds.setColorAt(count, c);
    count++;
    if (rand() < 0.35) {
      m4.compose(new THREE.Vector3(x + (rand() - 0.5) * 0.1, h + s * 0.82, z + (rand() - 0.5) * 0.1), new THREE.Quaternion(), new THREE.Vector3(1, 1, 1));
      heads.setMatrixAt(headCount++, m4);
    }
  }
  reeds.count = count;
  heads.count = headCount;
  for (const m of [reeds, heads]) {
    m.receiveShadow = true;
    m.castShadow = true;
    m.frustumCulled = false;
    group.add(m);
  }
  return group;
}

// --- 岩 ---
function rockGeometry(seed, detailLevel) {
  const g = new THREE.IcosahedronGeometry(1, detailLevel);
  const p = g.attributes.position;
  const v = new THREE.Vector3();
  const ox = seed * 13.1, oy = seed * 7.3;
  for (let k = 0; k < p.count; k++) {
    v.fromBufferAttribute(p, k);
    const n = fbm(v.x * 1.3 + ox, v.z * 1.3 + v.y * 0.7 + oy, 4);
    const ridge = Math.abs(noise2(v.x * 3 + oy, v.y * 3 + v.z * 2) - 0.5);
    v.multiplyScalar(0.75 + n * 0.55 - ridge * 0.15);
    v.y *= 0.62;
    if (v.y < -0.1) v.y = -0.1 + (v.y + 0.1) * 0.3;    // 底は平たく（地面に座る）
    p.setXYZ(k, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

export function buildRocks() {
  const rand = rng(91);
  const group = new THREE.Group();
  const spots = [];
  const tryPlace = (want, minH, maxH, sMin, sMax, filter = () => true) => {
    for (let t = 0; t < 400 && want > 0; t++) {
      const x = (rand() - 0.5) * (SIZE - 4), z = (rand() - 0.5) * (SIZE - 4);
      const h = heightAt(x, z);
      if (h < minH || h > maxH || onPier(x, z, 1.5) || !filter(x, z)) continue;
      const s = sMin + rand() * (sMax - sMin);
      if (Math.max(Math.abs(x), Math.abs(z)) > HALF - s * 2.2) continue;   // 切り口からはみ出さない
      if (spots.some(r => Math.hypot(r.x - x, r.z - z) < (r.s + s) * 1.3)) continue;
      spots.push({ x, z, h, s });
      want--;
    }
  };
  tryPlace(5, -0.4, 0.4, 0.7, 1.8);                         // 水際
  tryPlace(3, -1.2, -0.3, 0.6, 1.3);                        // 浅瀬
  tryPlace(4, 0.4, 2.5, 0.5, 1.6, (x, z) => forestness(x, z) < 0.3);   // 草地
  tryPlace(5, 1.5, 9, 0.9, 2.4);                            // 丘
  const detailMap = detail.clone();
  detailMap.repeat.set(3, 3);
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, normalMap: detailMap, normalScale: new THREE.Vector2(1.5, 1.5) });
  spots.forEach((r, i) => {
    const g = rockGeometry(i + 1, 4);
    const yaw = rand() * Math.PI * 2;
    g.applyMatrix4(new THREE.Matrix4().compose(
      new THREE.Vector3(r.x, r.h + r.s * 0.12, r.z),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw),
      new THREE.Vector3(r.s * (0.9 + rand() * 0.5), r.s, r.s * (0.8 + rand() * 0.4)),
    ));
    // 色: 灰色の地に、上を向いた面は苔、水に浸かる所は暗く藻っぽく
    const p = g.attributes.position, nrm = g.attributes.normal;
    const col = [];
    const tone = 0.8 + rand() * 0.25;
    for (let k = 0; k < p.count; k++) {
      const x = p.getX(k), y = p.getY(k), z = p.getZ(k);
      const n1 = noise2(x * 2.1, z * 2.1 + y), n2 = noise2(x * 7, y * 7 + z);
      let c = [0.42, 0.41, 0.39].map(v => v * tone * (0.75 + n1 * 0.35 + n2 * 0.15));
      const mossy = smoothstep(0.45, 0.85, nrm.getY(k) + (n1 - 0.5) * 0.6) * smoothstep(0.1, 0.4, y);
      c = c.map((v, j) => v + ([0.2, 0.27, 0.08][j] - v) * mossy * 0.85);
      const wet = 1 - smoothstep(-0.05, 0.25, y);
      c = c.map((v, j) => v * (1 - wet * 0.45) + [0.02, 0.04, 0.01][j] * wet);
      const lin = new THREE.Color().setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);
      col.push(lin.r, lin.g, lin.b);
    }
    g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    const m = new THREE.Mesh(g, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
  });
  return group;
}

export function buildPebbles(quality) {
  const rand = rng(17);
  const geo = rockGeometry(3, 1);
  const mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8 }), quality.pebbles);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), c = new THREE.Color();
  let count = 0;
  for (let t = 0; t < quality.pebbles * 30 && count < quality.pebbles; t++) {
    const x = (rand() - 0.5) * (SIZE - 0.4), z = (rand() - 0.5) * (SIZE - 0.4);
    const h = heightAt(x, z);
    if (h < -0.35 || h > 0.45 || onPier(x, z, 0.3)) continue;
    const s = 0.04 + rand() * rand() * 0.16;
    q.setFromEuler(new THREE.Euler(rand() * 0.4, rand() * 6.28, rand() * 0.4));
    m4.compose(new THREE.Vector3(x, h + s * 0.1, z), q, new THREE.Vector3(s * (1 + rand() * 0.5), s, s * (1 + rand() * 0.3)));
    mesh.setMatrixAt(count, m4);
    const g = 0.32 + rand() * 0.28, warm = rand() * 0.06;
    c.setRGB(g + warm, g + warm * 0.5, g - warm * 0.3, THREE.SRGBColorSpace);
    if (h < 0.05) c.multiplyScalar(0.6);
    mesh.setColorAt(count++, c);
  }
  mesh.count = count;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// --- 針葉樹: 幹と、針葉の小枝を描いた板をたくさん並べて作る ---
export function buildTrees(quality) {
  const rand = rng(123);
  const group = new THREE.Group();
  const trees = [];
  for (let t = 0; t < 2000 && trees.length < quality.trees; t++) {
    const x = (rand() - 0.5) * (SIZE - 3), z = (rand() - 0.5) * (SIZE - 3);
    if (forestness(x, z) < 0.45 || heightAt(x, z) < 1) continue;
    if (trees.some(o => Math.hypot(o.x - x, o.z - z) < 2.4)) continue;
    trees.push({ x, z, y: heightAt(x, z), h: 7 + rand() * 6 });
  }
  // 手前に少しだけ、離れて立つ木
  for (const [x, z] of [[-15.5, 9], [16, -2]]) trees.push({ x, z, y: heightAt(x, z), h: 8 + rand() * 3 });

  const bark = barkTexture();
  bark.repeat.set(1, 3);
  const trunkMat = new THREE.MeshStandardMaterial({ map: bark, roughness: 0.95 });
  const needles = needleTexture();
  const cardMat = new THREE.MeshStandardMaterial({ map: needles, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.85 });
  const card = new THREE.PlaneGeometry(1, 0.7).rotateX(-Math.PI / 2).translate(0.5, 0, 0);
  const cards = [];
  const up = new THREE.Vector3(0, 1, 0);

  for (const tree of trees) {
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.012 * tree.h + 0.1, tree.h, 8), trunkMat);
    trunk.position.set(tree.x, tree.y + tree.h / 2 - 0.1, tree.z);
    trunk.castShadow = true;
    trunk.receiveShadow = true;
    group.add(trunk);
    // 枝は輪生（同じ高さから何本も出る）。下ほど長く、少し垂れる
    for (let y = 1.2 + rand() * 0.4; y < tree.h; y += 0.24 + rand() * 0.1) {
      const k = (tree.h - y) / tree.h;
      const branchLen = 0.4 + k * tree.h * 0.32;
      const count = 7 + Math.floor(rand() * 3);
      const spin = rand() * Math.PI * 2;
      for (let b = 0; b < count; b++) {
        const yaw = spin + (b / count) * Math.PI * 2 + (rand() - 0.5) * 0.4;
        const droop = 0.12 + k * 0.35 + rand() * 0.15;
        const segs = Math.max(1, Math.round(branchLen / 0.5));
        for (let s = 0; s < segs; s++) {
          const along = (s / segs) * branchLen;
          const len = (branchLen / segs) * 1.6;
          const dir = new THREE.Vector3(Math.cos(yaw), -Math.sin(droop) * 0.6, Math.sin(yaw));
          const pos = new THREE.Vector3(tree.x, tree.y + y - along * Math.sin(droop) * 0.6, tree.z).addScaledVector(dir, along);
          for (const roll of [0, Math.PI / 3, (2 * Math.PI) / 3]) {
            const qy = new THREE.Quaternion().setFromAxisAngle(up, -yaw);
            const qd = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -droop);
            const qr = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), roll + (rand() - 0.5) * 0.5);
            cards.push({ pos, quat: qy.multiply(qd).multiply(qr), scale: new THREE.Vector3(len, 1, len * (0.9 + rand() * 0.4)), shade: 0.7 + rand() * 0.45 });
          }
        }
      }
    }
    // てっぺん
    cards.push({ pos: new THREE.Vector3(tree.x, tree.y + tree.h - 0.1, tree.z), quat: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2), scale: new THREE.Vector3(1.1, 1, 0.6), shade: 0.9 });
  }

  const mesh = new THREE.InstancedMesh(card, cardMat, cards.length);
  const m4 = new THREE.Matrix4(), c = new THREE.Color();
  cards.forEach((cd, i) => {
    mesh.setMatrixAt(i, m4.compose(cd.pos, cd.quat, cd.scale));
    mesh.setColorAt(i, c.setScalar(cd.shade));
  });
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  // 影も葉の形に抜けるように
  mesh.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: needles, alphaTest: 0.45 });
  group.add(mesh);
  group.userData.cards = cards.length;
  return group;
}

// --- 桟橋 ---
export function buildPier() {
  const rand = rng(7);
  const group = new THREE.Group();
  const wood = woodTexture();
  const plankMat = new THREE.MeshStandardMaterial({ map: wood, roughness: 0.85 });
  const deckY = 0.55;
  const ca = Math.cos(PIER.angle), sa = Math.sin(PIER.angle);
  const along = (a, c) => new THREE.Vector3(PIER.x0 + ca * a - sa * c, 0, PIER.z0 + sa * a + ca * c);
  const yaw = -PIER.angle;
  const planks = Math.floor((PIER.length + 1) / 0.2);
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.18, 0.05, PIER.width), plankMat, planks);
  const m4 = new THREE.Matrix4();
  for (let i = 0; i < planks; i++) {
    const a = -1 + i * 0.2 + 0.1;
    const p = along(a, (rand() - 0.5) * 0.05);
    const ground = heightAt(p.x, p.z);
    p.y = Math.max(deckY, ground + 0.08) + (rand() - 0.5) * 0.015;
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler((rand() - 0.5) * 0.03, yaw + (rand() - 0.5) * 0.02, (rand() - 0.5) * 0.02, "YXZ"));
    mesh.setMatrixAt(i, m4.compose(p, q, new THREE.Vector3(1, 1, 0.97 + rand() * 0.06)));
  }
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);

  const beamMat = new THREE.MeshStandardMaterial({ map: wood, color: 0x8a8070, roughness: 0.9 });
  for (const side of [-0.6, 0.6]) {
    const p = along(PIER.length / 2 - 0.5, side);
    const beam = new THREE.Mesh(new THREE.BoxGeometry(PIER.length + 1, 0.14, 0.12), beamMat);
    beam.position.set(p.x, deckY - 0.1, p.z);
    beam.rotation.y = yaw;
    beam.castShadow = true;
    group.add(beam);
  }
  const postMat = new THREE.MeshStandardMaterial({ map: wood, color: 0x6c6458, roughness: 0.9 });
  for (let a = 0.5; a <= PIER.length; a += 2.2) {
    for (const side of [-0.72, 0.72]) {
      const p = along(a, side);
      const bed = heightAt(p.x, p.z);
      const top = deckY + 0.25;
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.09, top - bed + 0.3, 8), postMat);
      post.position.set(p.x, (top + bed - 0.3) / 2, p.z);
      post.castShadow = true;
      post.receiveShadow = true;
      group.add(post);
    }
  }
  return group;
}

export { lakeness };
