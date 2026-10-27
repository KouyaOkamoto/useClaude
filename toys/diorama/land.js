// 箱庭の土地の形。湖・岸辺・奥の丘を、ノイズで自然に崩しながら作る。
// 単位はメートル。箱庭は一辺 SIZE の正方形で、水面の高さが 0。

export const SIZE = 40;
export const HALF = SIZE / 2;
export const BOTTOM = -6;          // 箱庭の底

export function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 値ノイズ（なめらかな乱数）
const PERM = (() => {
  const r = rng(20261027);
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  return Uint8Array.from([...p, ...p]);
})();
const VALUES = (() => {
  const r = rng(77);
  return Float32Array.from({ length: 256 }, () => r());
})();

export function noise2(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const h = (i, j) => VALUES[PERM[(PERM[(xi + i) & 255] + yi + j) & 255]];
  return (h(0, 0) * (1 - u) + h(1, 0) * u) * (1 - v) + (h(0, 1) * (1 - u) + h(1, 1) * u) * v;
}

export function fbm(x, y, octaves = 5) {
  let sum = 0, amp = 0.5, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise2(x, y) * amp;
    norm += amp;
    amp *= 0.5;
    x = x * 2.03 + 17.1;
    y = y * 2.03 + 3.7;
  }
  return sum / norm;   // 0〜1
}

export const smoothstep = (a, b, x) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

// 湖らしさ（1 で湖の中、0 で陸）
export function lakeness(x, z) {
  const wx = x + (fbm(x * 0.06 + 3, z * 0.06, 3) - 0.5) * 9;
  const wz = z + (fbm(x * 0.06, z * 0.06 + 7, 3) - 0.5) * 9;
  const d = Math.hypot((wx + 2) / 14, (wz - 2) / 10.5);
  return smoothstep(1.05, 0.55, d);
}

// 地面の高さ
export function heightAt(x, z) {
  const meadow = 0.85 + (fbm(x * 0.07, z * 0.07) - 0.5) * 1.3 + (fbm(x * 0.35, z * 0.35, 3) - 0.5) * 0.25;
  // 奥（z が小さい側）は丘、右手は少し高く
  const hill = smoothstep(-5, -19, z) * (3.5 + (fbm(x * 0.09 + 11, z * 0.09, 4) - 0.5) * 3);
  const rise = smoothstep(7, 19, x) * 1.2;
  const land = meadow + hill + rise;
  const bed = -2.6 + (fbm(x * 0.12 + 5, z * 0.12, 3) - 0.5) * 1.2;
  const l = lakeness(x, z);
  return land + (bed - land) * l;
}

export function slopeAt(x, z) {
  const e = 0.25;
  const dx = (heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e);
  const dz = (heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
  return Math.hypot(dx, dz);
}

// 木が生えているあたり（奥の丘）
export function forestness(x, z) {
  const edge = z + (fbm(x * 0.08 + 9, 3, 3) - 0.5) * 10;
  return smoothstep(-7, -11, edge) * smoothstep(0.3, 0.55, fbm(x * 0.1 + 40, z * 0.1, 3) + 0.15);
}

// 桟橋: 右手前の岸から湖へ
export const PIER = { x0: 12, z0: 9.5, angle: Math.atan2(-6.5, -9), length: 11, width: 1.6 };
export function onPier(x, z, margin = 0) {
  const dx = x - PIER.x0, dz = z - PIER.z0;
  const ca = Math.cos(PIER.angle), sa = Math.sin(PIER.angle);
  const along = dx * ca + dz * sa, across = -dx * sa + dz * ca;
  return along > -1 - margin && along < PIER.length + margin && Math.abs(across) < PIER.width / 2 + margin;
}
