// 盆栽の木。枝（線分）の一覧として持ち、成長・剪定・見栄えの採点・描画をする。
// 長さの単位は幹の最初の1節を 1 としたもの。角度は -π/2 が真上。

export const SPECIES = {
  pine: {
    name: "黒松",
    upward: 0.3,       // 幹が上に向かおうとする強さ
    flat: 0.35,        // 枝が横に広がろうとする強さ
    spread: 0.9,       // 枝分かれの開き
    split: 0.5,        // 伸びるときに枝分かれする確率
    bark: [92, 70, 52],
  },
  maple: {
    name: "もみじ",
    upward: 0.35,
    flat: 0.22,
    spread: 0.85,
    split: 0.6,
    bark: [110, 92, 80],
  },
  sakura: {
    name: "桜",
    upward: 0.3,
    flat: 0.28,
    spread: 0.95,
    split: 0.55,
    bark: [96, 72, 66],
  },
};
export const SPECIES_ORDER = ["pine", "maple", "sakura"];

export const MATURE_STEP = 36;   // この段数まで育つと作品にできる
export const MAX_STEP = 60;
const MAX_DEPTH = 9;
const MAX_SEGMENTS = 450;
const GROW_IN = 3;               // 新しい枝が伸びきるまでの段数
const EXTEND = 0.42;             // 1段で枝先が伸びる確率
const BACK_BUD = 0.04;           // 古い枝から新しい枝が出る確率

export function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function newTree(species, seed) {
  const rand = rng(seed);
  const tree = {
    species,
    seed,
    age: 0,      // 連続的に増える成長量（段）
    steps: 0,    // 実行済みの成長段数
    nextId: 1,
    segments: [{ id: 0, parent: -1, a: -Math.PI / 2 + (rand() - 0.5) * 0.3, len: 1, born: -GROW_IN, depth: 0, bud: 0 }],
  };
  // 最初から小さな苗木の形にしておく
  for (let i = 0; i < 8; i++) growStep(tree);
  tree.age = tree.steps;
  return tree;
}

// 1段成長させる。増えた枝の数を返す
export function growStep(tree) {
  if (tree.steps >= MAX_STEP) return 0;
  tree.steps++;
  const sp = SPECIES[tree.species];
  const rand = rng(tree.seed * 7919 + tree.steps * 104729);
  const before = tree.segments.length;
  const children = childCounts(tree);

  const add = (parent, angle, len) => {
    if (tree.segments.length >= MAX_SEGMENTS) return;
    // 幹は上へ、枝は少し上向きの横へ向かう癖を混ぜる
    const toward = parent.depth < 1 ? -Math.PI / 2 : angle < -Math.PI / 2 ? -Math.PI + 0.3 : -0.3;
    const a = angle + (toward - angle) * (parent.depth < 1 ? sp.upward : sp.flat);
    tree.segments.push({ id: tree.nextId++, parent: parent.id, a, len, born: tree.steps, depth: parent.depth + 1, bud: 0 });
  };

  for (const seg of tree.segments.slice()) {
    // 剪定された所から出る新しい芽
    if (seg.bud > 0) {
      for (let i = 0; i < seg.bud; i++) {
        const side = i % 2 ? 1 : -1;
        add(seg, seg.a + side * sp.spread * (0.6 + 0.5 * rand()), seg.len * (0.6 + 0.2 * rand()));
      }
      seg.bud = 0;
      continue;
    }
    if (seg.born > tree.steps - GROW_IN) continue;
    const kids = children.get(seg.id) ?? 0;
    const side = rand() < 0.5 ? -1 : 1;
    if (kids) {
      if (kids < 3 && seg.depth >= 1 && seg.depth <= 6 && rand() < BACK_BUD) {
        add(seg, seg.a + side * sp.spread * (0.8 + 0.4 * rand()), seg.len * 0.7);
      }
      continue;
    }
    if (seg.depth >= MAX_DEPTH || rand() > EXTEND) continue;
    add(seg, seg.a + (rand() - 0.5) * 0.5, seg.len * (0.76 + rand() * 0.1));
    // 幹に近いところはほぼ必ず枝分かれさせて、骨格を作る
    if (rand() < (seg.depth >= 1 && seg.depth <= 3 ? 0.9 : sp.split)) {
      add(seg, seg.a + side * sp.spread * (0.8 + 0.5 * rand()), seg.len * (0.7 + rand() * 0.15));
    }
  }
  return tree.segments.length - before;
}

// 指定の枝と、その先をすべて切る。切った本数を返す
export function cut(tree, id) {
  const target = tree.segments.find(s => s.id === id);
  if (!target || target.depth < 2) return 0;
  const removed = new Set([id]);
  for (const s of tree.segments) if (removed.has(s.parent)) removed.add(s.id);
  tree.segments = tree.segments.filter(s => !removed.has(s.id));
  // 切り口の手前から、次の成長で新しい芽が出る（枝数が増えて密になる）
  const parent = tree.segments.find(s => s.id === target.parent);
  if (parent && parent.depth < MAX_DEPTH - 1) parent.bud = Math.min(parent.bud + 2, 3);
  return removed.size;
}

function childCounts(tree) {
  const counts = new Map();
  for (const s of tree.segments) counts.set(s.parent, (counts.get(s.parent) ?? 0) + 1);
  return counts;
}

// 各枝の始点・終点・太さ・葉を付けるかを計算する（座標は幹の根元が原点）
export function layout(tree) {
  const byId = new Map();
  const children = childCounts(tree);
  const out = [];
  for (const s of tree.segments) {
    const p = byId.get(s.parent);
    const grow = Math.min(1, Math.max(0, (tree.age - s.born) / GROW_IN));
    const x1 = p ? p.x2 : 0, y1 = p ? p.y2 : 0;
    const len = s.len * grow;
    const node = {
      seg: s, x1, y1, x2: x1 + Math.cos(s.a) * len, y2: y1 + Math.sin(s.a) * len,
      grow, tips: 0, tip: !children.get(s.id),
    };
    byId.set(s.id, node);
    out.push(node);
  }
  // 太さはその枝が支える枝先の数で決める（親は子より前にあるので逆順に足す）
  for (let i = out.length - 1; i >= 0; i--) {
    const n = out[i];
    if (n.tip) n.tips += 1;
    const p = byId.get(n.seg.parent);
    if (p) p.tips += n.tips;
  }
  for (const n of out) n.width = 0.035 + 0.045 * Math.sqrt(n.tips);
  return out;
}

export const foliage = nodes => nodes.filter(n => n.seg.depth >= 2 && (n.tip || n.seg.depth >= 5) && n.grow > 0.2);

// 見栄え（0〜100）: 左右のつり合い、横長の三角に近い輪郭、葉の茂り具合。
// 茂りすぎるとぼさぼさとして減点されるので、剪定で整えると上がる
export function beauty(tree, bonus = 0) {
  const leaves = foliage(layout(tree));
  if (leaves.length < 3) return Math.min(100, 10 + bonus);
  const xs = leaves.map(n => n.x2), ys = leaves.map(n => n.y2);
  const w = Math.max(...xs) - Math.min(...xs), h = -Math.min(...ys);
  const cx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const balance = 1 - Math.min(1, Math.abs(cx) / Math.max(w / 2, 0.5));
  const ratio = w / Math.max(h, 0.5);
  const shape = Math.exp(-((ratio - 1.3) ** 2) / 0.6);
  const fullness = Math.min(1, leaves.length / 45);
  const shaggy = Math.min(1, Math.max(0, leaves.length - 110) / 150);
  return Math.max(0, Math.min(100, Math.round(40 * shape + 30 * balance + 20 * fullness - 25 * shaggy) + bonus));
}

// --- 描画 ---

const css = ([r, g, b], a = 1) => `rgba(${r | 0},${g | 0},${b | 0},${a})`;
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

// 季節と種類ごとの葉の見た目
export function leafLook(species, season, rand) {
  if (species === "pine") return { kind: "pad", color: mix([38, 78, 44], [62, 104, 58], rand()) };
  if (season === "winter") return null;
  if (species === "maple") {
    if (season === "autumn") return { kind: "star", color: mix([200, 50, 30], [235, 150, 40], rand()) };
    if (season === "spring") return { kind: "star", color: mix([120, 170, 60], [160, 190, 80], rand()) };
    return { kind: "star", color: mix([60, 120, 50], [90, 150, 60], rand()) };
  }
  if (season === "spring") return { kind: "flower", color: mix([248, 196, 210], [255, 230, 236], rand()) };
  if (season === "autumn") return { kind: "round", color: mix([190, 120, 50], [220, 170, 70], rand()) };
  return { kind: "round", color: mix([70, 130, 60], [100, 160, 70], rand()) };
}

// opts: { scale, ox, oy, season, thirst (0〜1), highlight (枝 id の Set), snow }
export function drawTree(ctx, tree, opts) {
  const { scale, ox, oy, season, thirst = 0, highlight, snow } = opts;
  const nodes = layout(tree);
  const sp = SPECIES[tree.species];
  const X = x => ox + x * scale, Y = y => oy + y * scale;

  ctx.lineCap = "round";
  for (const n of nodes) {
    if (n.grow <= 0) continue;
    const hot = highlight?.has(n.seg.id);
    ctx.strokeStyle = hot ? "rgba(255,120,100,.95)" : css(mix(sp.bark, [40, 30, 24], Math.min(1, n.seg.depth / 8) * 0.4));
    ctx.lineWidth = Math.max(1, n.width * scale);
    ctx.beginPath();
    ctx.moveTo(X(n.x1), Y(n.y1));
    ctx.lineTo(X(n.x2), Y(n.y2));
    ctx.stroke();
  }
  // 幹の明るい側
  for (const n of nodes) {
    if (n.seg.depth > 1 || n.grow <= 0) continue;
    ctx.strokeStyle = "rgba(255,240,220,.08)";
    ctx.lineWidth = Math.max(0.5, n.width * scale * 0.35);
    const off = n.width * scale * 0.25;
    ctx.beginPath();
    ctx.moveTo(X(n.x1) - off, Y(n.y1));
    ctx.lineTo(X(n.x2) - off, Y(n.y2));
    ctx.stroke();
  }

  for (const n of foliage(nodes)) {
    const rand = rng(tree.seed * 31 + n.seg.id * 977);
    const look = leafLook(tree.species, season, rand);
    const size = scale * (0.32 + 0.12 * rand()) * Math.min(1, n.grow);
    const cx = X(n.x2), cy = Y(n.y2);
    const hot = highlight?.has(n.seg.id);
    if (look) {
      // 水が足りないと色がくすんで黄色っぽくなる
      const color = hot ? [255, 140, 120] : mix(look.color, [170, 150, 80], thirst * 0.4);
      drawCluster(ctx, look.kind, cx, cy, size * (1 - thirst * 0.15), color, rand);
    }
    if (snow) {
      ctx.fillStyle = "rgba(245,248,255,.9)";
      ctx.beginPath();
      ctx.ellipse(cx, cy - size * (look ? 0.45 : 0.05), size * (look ? 0.75 : 0.25), size * (look ? 0.22 : 0.1), 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawCluster(ctx, kind, cx, cy, size, color, rand) {
  if (kind === "pad") {
    // 松: 平たい葉の塊を重ねる
    for (let i = 0; i < 4; i++) {
      const x = cx + (rand() - 0.5) * size * 0.9, y = cy + (rand() - 0.5) * size * 0.35;
      const g = ctx.createLinearGradient(0, y - size * 0.3, 0, y + size * 0.3);
      g.addColorStop(0, css(mix(color, [200, 230, 160], 0.25)));
      g.addColorStop(1, css(mix(color, [0, 0, 0], 0.35)));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(x, y, size * (0.55 + 0.2 * rand()), size * (0.24 + 0.08 * rand()), 0, 0, Math.PI * 2);
      ctx.fill();
    }
    return;
  }
  const count = kind === "flower" ? 6 : 7;
  for (let i = 0; i < count; i++) {
    const x = cx + (rand() - 0.5) * size * 1.3, y = cy + (rand() - 0.5) * size * 0.9;
    const s = size * (0.22 + 0.12 * rand());
    const c = mix(color, [0, 0, 0], rand() * 0.25);
    ctx.fillStyle = css(c);
    ctx.beginPath();
    if (kind === "round") {
      ctx.ellipse(x, y, s, s * 0.7, rand() * Math.PI, 0, Math.PI * 2);
    } else {
      // もみじは5つの尖り、桜の花は5枚の丸い花びら
      const petals = 5, rot = rand() * Math.PI;
      for (let k = 0; k <= petals * 2; k++) {
        const ang = rot + (k / (petals * 2)) * Math.PI * 2;
        const r = kind === "star" ? (k % 2 ? s * 0.4 : s) : (k % 2 ? s * 0.55 : s * 0.95);
        const px = x + Math.cos(ang) * r, py = y + Math.sin(ang) * r;
        k ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      }
    }
    ctx.fill();
    if (kind === "flower") {
      ctx.fillStyle = "rgba(230,120,140,.8)";
      ctx.beginPath();
      ctx.arc(x, y, s * 0.18, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// 枝先のスクリーン座標から一番近い枝を探す（剪定用）
export function hitTest(tree, px, py, { scale, ox, oy }, radius = 14) {
  let best = null, bestD = radius;
  for (const n of layout(tree)) {
    if (n.seg.depth < 2 || n.grow <= 0) continue;
    const x1 = ox + n.x1 * scale, y1 = oy + n.y1 * scale, x2 = ox + n.x2 * scale, y2 = oy + n.y2 * scale;
    const dx = x2 - x1, dy = y2 - y1;
    const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy || 1)));
    const d = Math.hypot(px - x1 - dx * t, py - y1 - dy * t);
    if (d < bestD) {
      bestD = d;
      best = n.seg.id;
    }
  }
  return best;
}

// 枝 id とその先の id の集合（剪定のプレビュー用）
export function subtree(tree, id) {
  const ids = new Set([id]);
  for (const s of tree.segments) if (ids.has(s.parent)) ids.add(s.id);
  return ids;
}

export function tipCount(tree) {
  return layout(tree).filter(n => n.tip).length;
}
