// 画像ファイルを使わず、模様をすべてその場で描く。
import * as THREE from "three";
import { HALF, SIZE, noise2, fbm, rng, smoothstep } from "./land.js";

const mixc = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

function canvasTexture(w, h, draw, { srgb = true, repeat = 1 } = {}) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  draw(ctx, w, h);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = 8;
  return tex;
}

function pixels(w, h, fn, opts) {
  return canvasTexture(w, h, (ctx) => {
    const img = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const c = fn(x, y);
        const o = (y * w + x) * 4;
        img.data[o] = c[0];
        img.data[o + 1] = c[1];
        img.data[o + 2] = c[2];
        img.data[o + 3] = c[3] ?? 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, opts);
}

// 端でつながる（敷き詰められる）ノイズ
function tileNoise(x, y, period) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const h = (i, j) => {
    const a = ((xi + i) % period + period) % period, b = ((yi + j) % period + period) % period;
    return noise2(a * 1.7 + 0.31, b * 1.7 + 0.53);
  };
  return (h(0, 0) * (1 - u) + h(1, 0) * u) * (1 - v) + (h(0, 1) * (1 - u) + h(1, 1) * u) * v;
}
function tileFbm(x, y, period, octaves = 5) {
  let s = 0, a = 0.5, n = 0;
  for (let i = 0; i < octaves; i++) {
    s += tileNoise(x, y, period) * a;
    n += a;
    a *= 0.5;
    x *= 2;
    y *= 2;
    period *= 2;
  }
  return s / n;
}

// 高さの格子を元に、地面の色を塗る（湖底・濡れた岸・草地・森の落ち葉）
export function groundTexture(grid, size) {
  const { heights, forest, n } = grid;
  const at = (arr, x, z) => {
    const tx = (x / SIZE + 0.5) * (n - 1), tz = (z / SIZE + 0.5) * (n - 1);
    const i = Math.min(Math.max(Math.floor(tx), 0), n - 2), j = Math.min(Math.max(Math.floor(tz), 0), n - 2);
    const fx = tx - i, fz = tz - j;
    return (arr[j * n + i] * (1 - fx) + arr[j * n + i + 1] * fx) * (1 - fz) + (arr[(j + 1) * n + i] * (1 - fx) + arr[(j + 1) * n + i + 1] * fx) * fz;
  };
  const grassA = [74, 98, 42], grassB = [116, 122, 58], grassDark = [52, 74, 36];
  const soil = [84, 66, 46], sandWet = [96, 86, 66], sandDry = [150, 138, 110], pebble = [128, 122, 110];
  const bedShallow = [98, 92, 64], bedDeep = [40, 50, 40], litter = [78, 58, 38], moss = [58, 76, 34];
  const step = SIZE / size;
  const map = pixels(size, size, (px, py) => {
    const x = -HALF + (px + 0.5) * step, z = -HALF + (py + 0.5) * step;
    const h = at(heights, x, z);
    const e = SIZE / (n - 1);
    const slope = Math.hypot(at(heights, x + e, z) - at(heights, x - e, z), at(heights, x, z + e) - at(heights, x, z - e)) / (2 * e);
    const f = at(forest, x, z);
    const n1 = noise2(x * 0.9, z * 0.9), n2 = noise2(x * 3.1 + 5, z * 3.1), n3 = noise2(x * 11, z * 11);
    const patch = fbm(x * 0.15 + 3, z * 0.15, 3);

    let c = mixc(mixc(grassA, grassB, smoothstep(0.45, 0.75, patch)), grassDark, smoothstep(0.55, 0.8, n1) * 0.6);
    c = mixc(c, soil, smoothstep(0.55, 1.1, slope + n2 * 0.3) * 0.8);
    c = mixc(c, mixc(litter, moss, n1), smoothstep(0.2, 0.7, f));
    // 岸辺: 水際は濡れて暗く、少し上は乾いた砂と小石
    const shore = 1 - smoothstep(0.15, 0.55 + n2 * 0.2, h);
    c = mixc(c, mixc(mixc(sandDry, pebble, smoothstep(0.4, 0.7, n3)), sandWet, 1 - smoothstep(0.02, 0.2, h)), shore);
    if (h < 0) c = mixc(bedShallow, bedDeep, smoothstep(0, -2.2, h + (n1 - 0.5) * 0.4));
    const shade = 0.82 + 0.3 * n3 + 0.12 * (n2 - 0.5);
    return c.map(v => Math.min(255, v * shade));
  });
  map.repeat.set(1, 1);
  map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping;

  // 濡れた所はつやが出る（粗さが下がる）
  const rough = pixels(size / 4, size / 4, (px, py) => {
    const x = -HALF + (px + 0.5) * step * 4, z = -HALF + (py + 0.5) * step * 4;
    const h = at(heights, x, z);
    const v = Math.round(255 * (0.95 - 0.45 * (1 - smoothstep(0.0, 0.3, h))));
    return [v, v, v];
  }, { srgb: false });
  rough.wrapS = rough.wrapT = THREE.ClampToEdgeWrapping;
  return { map, rough };
}

// 細かな凹凸（土・草の地面用、敷き詰める）
export function detailNormal(size = 512, repeat = 10) {
  const P = 16;
  const hAt = (x, y) => tileFbm(x / size * P, y / size * P, P, 5);
  return pixels(size, size, (x, y) => {
    const dx = (hAt(x + 1, y) - hAt(x - 1, y)) * 6, dy = (hAt(x, y + 1) - hAt(x, y - 1)) * 6;
    const l = Math.hypot(dx, dy, 1);
    return [(-dx / l * 0.5 + 0.5) * 255, (-dy / l * 0.5 + 0.5) * 255, (1 / l * 0.5 + 0.5) * 255];
  }, { srgb: false, repeat });
}

// 水面のさざ波（敷き詰められる波を何本か重ねる）
export function waterNormals(size = 256) {
  const r = rng(5);
  const waves = Array.from({ length: 10 }, () => ({
    kx: Math.round((r() - 0.5) * 12), ky: Math.round((r() - 0.5) * 12), a: 0.4 + r(), p: r() * 6.28,
  }));
  const hAt = (x, y) => {
    let h = 0;
    for (const w of waves) h += Math.sin(((w.kx * x + w.ky * y) / size) * Math.PI * 2 + w.p) * w.a / Math.hypot(w.kx, w.ky, 1);
    return h + tileFbm(x / size * 8, y / size * 8, 8, 4) * 1.5;
  };
  return pixels(size, size, (x, y) => {
    const dx = (hAt(x + 1, y) - hAt(x - 1, y)) * 3, dy = (hAt(x, y + 1) - hAt(x, y - 1)) * 3;
    const l = Math.hypot(dx, dy, 1);
    return [(-dx / l * 0.5 + 0.5) * 255, (-dy / l * 0.5 + 0.5) * 255, (1 / l * 0.5 + 0.5) * 255];
  }, { srgb: false });
}

// 風雨にさらされた板（桟橋・台座）
export function woodTexture(tone = [118, 104, 88]) {
  return pixels(512, 128, (x, y) => {
    const grain = Math.sin(y * 0.55 + noise2(x * 0.02, y * 0.08) * 9) * 0.5 + 0.5;
    const knot = Math.max(0, 1 - Math.hypot((x % 211) - 100, (y - 64) * 2.5) / 14);
    const n = noise2(x * 0.05, y * 0.6) * 0.25 + noise2(x * 0.6, y * 2) * 0.1;
    const k = 0.72 + grain * 0.18 + n - knot * 0.35;
    return tone.map(v => v * k);
  });
}

// 箱庭の切り口: 上から 草の根・黒土・茶色の土・粘土・砂利・岩
export function soilTexture() {
  const layers = [
    [0.0, [40, 46, 28]], [0.035, [44, 34, 26]], [0.16, [78, 62, 46]], [0.38, [116, 98, 74]],
    [0.56, [104, 100, 92]], [0.74, [80, 80, 82]], [1.01, [80, 80, 82]],
  ];
  return pixels(256, 512, (x, y) => {
    const t = y / 512 + (noise2(x * 0.05, y * 0.01) - 0.5) * 0.04;
    let i = 0;
    while (i < layers.length - 2 && t > layers[i + 1][0]) i++;
    const [t0, c0] = layers[i], [t1] = layers[i + 1];
    const blend = smoothstep(t1 - 0.015, t1 + 0.015, t);
    let c = mixc(c0, layers[i + 1][1], blend);
    const grain = noise2(x * 0.7, y * 0.7) * 0.25 + noise2(x * 0.15, y * 0.3) * 0.15;
    if (t > 0.56 && t < 0.74 && noise2(x * 0.4, y * 0.4) > 0.72) c = mixc(c, [170, 165, 155], 0.6);   // 砂利の粒
    void t0;
    return c.map(v => v * (0.78 + grain));
  });
}

// 木の皮（縦の割れ目）
export function barkTexture() {
  return pixels(128, 512, (x, y) => {
    const fissure = Math.abs(Math.sin(x * 0.2 + noise2(x * 0.05, y * 0.02) * 6));
    const n = noise2(x * 0.3, y * 0.08) * 0.3;
    const k = 0.45 + fissure * 0.45 + n;
    return [86 * k, 64 * k, 48 * k];
  });
}

// 針葉樹の枝先（透明の背景に、小枝と針状の葉）
export function needleTexture() {
  return canvasTexture(256, 256, (ctx, w, h) => {
    const r = rng(9);
    ctx.clearRect(0, 0, w, h);
    ctx.lineCap = "round";
    const twig = (x0, y0, x1, y1, depth) => {
      ctx.strokeStyle = "rgba(70,52,36,1)";
      ctx.lineWidth = depth ? 1.5 : 3;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
      const len = Math.hypot(x1 - x0, y1 - y0);
      const steps = Math.floor(len / 2.2);
      for (let i = 0; i < steps; i++) {
        const t = i / steps;
        const px = x0 + (x1 - x0) * t, py = y0 + (y1 - y0) * t;
        for (const side of [-1, 1]) {
          const ang = Math.atan2(y1 - y0, x1 - x0) + side * (0.7 + r() * 0.4);
          const nl = (20 + r() * 10) * (1 - t * 0.45) * (depth ? 0.75 : 1);
          const g = 70 + r() * 40;
          ctx.strokeStyle = `rgba(${28 + r() * 20},${g},${34 + r() * 20},1)`;
          ctx.lineWidth = 2.2;
          ctx.beginPath();
          ctx.moveTo(px, py);
          ctx.lineTo(px + Math.cos(ang) * nl, py + Math.sin(ang) * nl);
          ctx.stroke();
        }
      }
      if (!depth) {
        for (let k = 0; k < 6; k++) {
          const t = 0.18 + k * 0.13;
          const px = x0 + (x1 - x0) * t, py = y0 + (y1 - y0) * t;
          const side = k % 2 ? 1 : -1;
          const ang = Math.atan2(y1 - y0, x1 - x0) + side * 0.6;
          twig(px, py, px + Math.cos(ang) * len * 0.42, py + Math.sin(ang) * len * 0.42, 1);
        }
      }
    };
    twig(w * 0.08, h * 0.5, w * 0.95, h * 0.5, 0);
  }, { repeat: 1 });
}
