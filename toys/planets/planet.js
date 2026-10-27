// シードから惑星の性格（色・大気・太陽・衛星・地形・植物）を決める。
// 同じシードなら必ず同じ惑星になる。

export function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 色は 0〜1 の [r, g, b]
export function hsl(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  const f = n => {
    const k = (n + h * 12) % 12;
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}
export const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

const SYLLABLES = ["ア", "カ", "サ", "タ", "ナ", "ラ", "ヴェ", "ゼ", "リ", "オ", "ス", "ト", "ル", "ミ", "ネ", "キ", "ド", "ヨ", "エ", "ソ", "ノ", "ヘ", "イ", "ク", "ジ", "テ"];
const ENDINGS = ["ス", "ア", "ン", "ラ", "ト", "ル", "ド", "ナ", "ム"];
const NUMERALS = ["", "", "", "・II", "・III", "・IV", "・V", "・VII", "・IX"];

// 惑星の型ごとの作り方
const TYPES = {
  temperate: {
    label: "温暖",
    weight: 3,
    make: r => ({
      sky: r.hue(195, 225),
      ground: hsl(r.range(80, 135), r.range(0.35, 0.55), r.range(0.28, 0.38)),
      ground2: hsl(r.range(60, 100), r.range(0.3, 0.5), r.range(0.3, 0.4)),
      rock: hsl(r.range(20, 40), r.range(0.05, 0.15), r.range(0.35, 0.45)),
      sand: hsl(r.range(38, 48), r.range(0.3, 0.45), r.range(0.62, 0.72)),
      water: { shallow: hsl(r.range(175, 195), 0.5, 0.45), deep: hsl(r.range(205, 220), 0.6, 0.18), frozen: false },
      waterFraction: r.range(0.25, 0.45),
      snowLine: r.range(0.72, 0.9),
      flora: { kinds: [r.pick(["broadleaf", "conifer"]), r.pick(["broadleaf", "conifer", "bush"])], density: r.range(0.6, 1), hue: r.range(90, 140) },
      terrain: { amp: r.range(350, 650), rough: r.range(0.48, 0.56), ridge: r.range(0.5, 1), warp: r.range(0.4, 0.9), terrace: 0, erosion: r.range(0.25, 0.4) },
    }),
  },
  alien: {
    label: "異星の森",
    weight: 3,
    make: r => {
      const h = r.range(0, 360);
      return {
        sky: r.hue(0, 360),
        ground: hsl(h, r.range(0.4, 0.65), r.range(0.28, 0.4)),
        ground2: hsl(h + r.range(-50, 50), r.range(0.35, 0.6), r.range(0.3, 0.42)),
        rock: hsl(r.range(0, 360), r.range(0.08, 0.25), r.range(0.28, 0.42)),
        sand: hsl(r.range(0, 360), r.range(0.2, 0.45), r.range(0.55, 0.7)),
        water: { shallow: hsl(r.range(0, 360), 0.55, 0.45), deep: hsl(r.range(0, 360), 0.6, 0.18), frozen: false },
        waterFraction: r.range(0.15, 0.4),
        snowLine: r.range(0.8, 0.95),
        flora: { kinds: [r.pick(["mushroom", "spire", "crystal"]), r.pick(["mushroom", "spire", "crystal", "bush"])], density: r.range(0.5, 1), hue: h + r.range(90, 270) },
        terrain: { amp: r.range(300, 700), rough: r.range(0.45, 0.58), ridge: r.range(0.3, 1), warp: r.range(0.5, 1), terrace: r.chance(0.25) ? r.range(0.3, 0.7) : 0, erosion: r.range(0.15, 0.35) },
      };
    },
  },
  desert: {
    label: "乾いた台地",
    weight: 2,
    make: r => ({
      sky: r.chance(0.5) ? r.hue(20, 45) : r.hue(195, 215),
      ground: hsl(r.range(18, 38), r.range(0.4, 0.6), r.range(0.45, 0.55)),
      ground2: hsl(r.range(10, 30), r.range(0.45, 0.6), r.range(0.4, 0.5)),
      rock: hsl(r.range(5, 25), r.range(0.35, 0.55), r.range(0.32, 0.42)),
      sand: hsl(r.range(30, 42), r.range(0.45, 0.6), r.range(0.62, 0.72)),
      water: { shallow: hsl(r.range(170, 190), 0.45, 0.45), deep: hsl(r.range(195, 210), 0.5, 0.22), frozen: false },
      waterFraction: r.chance(0.5) ? r.range(0.02, 0.12) : 0,
      snowLine: 2,
      flora: { kinds: ["cactus", r.pick(["spire", "bush"])], density: r.range(0.15, 0.4), hue: r.range(70, 130) },
      terrain: { amp: r.range(300, 550), rough: r.range(0.45, 0.52), ridge: r.range(0, 0.5), warp: r.range(0.5, 1), terrace: r.range(0.75, 1), erosion: r.range(0.04, 0.1) },
    }),
  },
  ice: {
    label: "氷の世界",
    weight: 1.5,
    make: r => ({
      sky: r.hue(185, 215),
      ground: hsl(r.range(190, 215), r.range(0.1, 0.25), r.range(0.82, 0.9)),
      ground2: hsl(r.range(190, 220), r.range(0.15, 0.3), r.range(0.74, 0.84)),
      rock: hsl(r.range(200, 230), r.range(0.1, 0.2), r.range(0.3, 0.4)),
      sand: hsl(r.range(195, 215), r.range(0.15, 0.3), r.range(0.8, 0.88)),
      water: { shallow: hsl(r.range(185, 200), 0.35, 0.78), deep: hsl(r.range(195, 210), 0.4, 0.6), frozen: true },
      waterFraction: r.range(0.2, 0.4),
      snowLine: -1,
      flora: { kinds: ["crystal", "conifer"], density: r.range(0.1, 0.3), hue: r.range(170, 230) },
      terrain: { amp: r.range(400, 750), rough: r.range(0.5, 0.58), ridge: r.range(0.6, 1), warp: r.range(0.3, 0.7), terrace: 0, erosion: r.range(0.2, 0.35) },
    }),
  },
  ocean: {
    label: "海の惑星",
    weight: 1.5,
    make: r => ({
      sky: r.hue(190, 215),
      ground: hsl(r.range(95, 150), r.range(0.45, 0.65), r.range(0.3, 0.38)),
      ground2: hsl(r.range(70, 110), r.range(0.4, 0.6), r.range(0.32, 0.42)),
      rock: hsl(r.range(15, 35), r.range(0.08, 0.18), r.range(0.38, 0.46)),
      sand: hsl(r.range(40, 50), r.range(0.4, 0.55), r.range(0.72, 0.8)),
      water: { shallow: hsl(r.range(165, 185), 0.65, 0.5), deep: hsl(r.range(200, 215), 0.7, 0.2), frozen: false },
      waterFraction: r.range(0.55, 0.7),
      snowLine: 2,
      flora: { kinds: ["palm", "broadleaf"], density: r.range(0.6, 1), hue: r.range(95, 135) },
      terrain: { amp: r.range(300, 500), rough: r.range(0.5, 0.56), ridge: r.range(0.3, 0.8), warp: r.range(0.5, 1), terrace: 0, erosion: r.range(0.25, 0.4) },
    }),
  },
};

// 恒星の色（温度の低い赤〜高い青白）
const STARS = [
  { label: "赤い恒星", color: [1, 0.55, 0.35], weight: 1 },
  { label: "橙の恒星", color: [1, 0.78, 0.55], weight: 2 },
  { label: "黄色い恒星", color: [1, 0.95, 0.82], weight: 3 },
  { label: "青白い恒星", color: [0.82, 0.9, 1], weight: 1 },
];

export function makePlanet(seed) {
  const rand = rng(seed);
  const r = {
    range: (a, b) => a + (b - a) * rand(),
    pick: arr => arr[(rand() * arr.length) | 0],
    chance: p => rand() < p,
    weighted: list => {
      let x = rand() * list.reduce((s, it) => s + it.weight, 0);
      for (const it of list) if ((x -= it.weight) < 0) return it;
      return list[0];
    },
  };
  r.hue = (a, b) => r.range(a, b);

  const typeKey = r.weighted(Object.entries(TYPES).map(([key, t]) => ({ key, weight: t.weight }))).key;
  const p = TYPES[typeKey].make(r);
  const star = r.weighted(STARS);

  // 大気: 濃いほど遠くが霞み、空の色も淡くなる
  const density = r.range(0.55, 1.5);
  const skyHue = p.sky;
  const zenith = hsl(skyHue, r.range(0.45, 0.7), r.range(0.38, 0.5) - density * 0.06);
  const horizon = mix(hsl(skyHue + r.range(-15, 15), r.range(0.3, 0.5), 0.75), star.color, 0.15);
  const sunset = hsl(r.range(5, 40) + (typeKey === "alien" ? r.range(-60, 60) : 0), r.range(0.6, 0.85), 0.6);

  const moons = Array.from({ length: r.pick([0, 1, 1, 2, 2, 3]) }, () => ({
    az: r.range(0, Math.PI * 2),
    el: r.range(0.15, 0.9),
    size: r.range(0.02, 0.09),
    color: hsl(r.range(0, 360), r.range(0, 0.3), r.range(0.55, 0.8)),
  }));
  const rings = r.chance(0.3)
    ? { tilt: r.range(0.2, 0.9), turn: r.range(0, Math.PI), color: hsl(r.range(20, 60), r.range(0.1, 0.35), r.range(0.7, 0.85)), inner: r.range(1.4, 1.8), width: r.range(0.5, 1.3) }
    : null;

  const syllables = 2 + (rand() < 0.5 ? 1 : 0);
  let name = "";
  for (let i = 0; i < syllables; i++) name += r.pick(SYLLABLES);
  name += r.pick(ENDINGS) + r.pick(NUMERALS);

  return {
    seed,
    name,
    type: typeKey,
    typeLabel: TYPES[typeKey].label,
    star,
    sunSize: r.range(0.018, 0.04),
    sunAzimuth: r.range(0, Math.PI * 2),
    sunTilt: r.range(0.35, 0.75),          // 太陽の通り道の傾き（大きいほど高く昇る）
    startTime: r.pick([r.range(0.06, 0.12), r.range(0.36, 0.44)]),   // 朝か夕方から始める
    atmosphere: { density, zenith, horizon, sunset },
    moons,
    rings,
    ...p,
  };
}

export function describe(p) {
  const air = p.atmosphere.density < 0.8 ? "薄い大気" : p.atmosphere.density < 1.2 ? "ほどよい大気" : "濃い大気";
  const water = p.waterFraction <= 0 ? "海なし" : p.water.frozen ? "凍った海" : p.waterFraction > 0.5 ? "広い海" : "海あり";
  const extras = [p.moons.length ? `衛星 ${p.moons.length}` : "衛星なし", p.rings ? "環あり" : ""].filter(Boolean);
  return [p.typeLabel, air, water, p.star.label, ...extras].join(" ・ ");
}
