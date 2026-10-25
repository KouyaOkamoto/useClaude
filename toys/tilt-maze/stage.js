// ステージは文字列の地図
// '#': 壁  'O': 穴  'S': スタート  'G': ゴール  '.': 床

export const FIRST_STAGE = [
  "##########",
  "#S.....O.#",
  "#...O....#",
  "#O.......#",
  "#####....#",
  "#...O..O.#",
  "#........#",
  "#.O..#...#",
  "#....#####",
  "#..O.....#",
  "#......O.#",
  "#.O..O...#",
  "#....#..G#",
  "##########",
];

const BASE_W = 10;
const BASE_H = 14;
const MAX_TIER = 6;       // これ以上は大きくしない（スマホで玉が小さくなりすぎるため）
const BLOCK_RATE = 0.04;  // 床に対する追加の壁ブロックの割合

// 5ステージごとに一回り大きくする
export function stageSize(n) {
  const tier = Math.min(Math.floor((n - 1) / 5), MAX_TIER);
  return { w: BASE_W + tier, h: BASE_H + tier * 2 };
}

// 穴の割合: サイズが同じ5ステージの間で増え、サイズが上がると少し戻る
export function holeRate(n) {
  const tier = Math.floor((n - 1) / 5);
  return Math.min(0.10 + 0.015 * ((n - 1) % 5) + 0.01 * tier, 0.2);
}

export function generateStage(n, random = Math.random) {
  const { w, h } = stageSize(n);
  const int = k => Math.floor(random() * k);
  const g = Array.from({ length: h }, (_, r) =>
    Array.from({ length: w }, (_, c) => (r === 0 || c === 0 || r === h - 1 || c === w - 1 ? "#" : ".")));

  // 横の仕切り: 片側の壁から伸ばして反対側に通路を残し、向きを交互に変えて蛇行させる
  const iw = w - 2;
  const firstFromLeft = random() < 0.5;
  let fromLeft = firstFromLeft;
  for (let r = 3 + int(2); r < h - 3; r += 3 + int(3)) {
    const gap = 2 + int(Math.floor(iw / 2) - 1);
    for (let i = 0; i < iw - gap; i++) g[r][fromLeft ? 1 + i : w - 2 - i] = "#";
    fromLeft = !fromLeft;
  }
  // スタートは最初の仕切りの付け根側、ゴールは最後の通路の反対側
  const start = { r: 1, c: firstFromLeft ? 1 : w - 2 };
  const goal = { r: h - 2, c: fromLeft ? w - 2 : 1 };
  const nearEnds = (r, c) =>
    Math.abs(r - start.r) + Math.abs(c - start.c) <= 1 || Math.abs(r - goal.r) + Math.abs(c - goal.c) <= 1;

  // 置いてもゴールまでの道が残る場合だけ確定する
  function tryPlace(cells, ch) {
    if (!cells.every(([r, c]) => g[r]?.[c] === "." && !nearEnds(r, c))) return false;
    for (const [r, c] of cells) g[r][c] = ch;
    if (hasPath(g, start, goal)) return true;
    for (const [r, c] of cells) g[r][c] = ".";
    return false;
  }

  const floorCount = () => g.flat().filter(ch => ch === ".").length;

  const blocks = Math.round(floorCount() * BLOCK_RATE);
  for (let placed = 0, tries = 0; placed < blocks && tries < blocks * 20; tries++) {
    const r = 1 + int(h - 2), c = 1 + int(iw);
    const cells = random() < 0.5 ? [[r, c]] : random() < 0.5 ? [[r, c], [r + 1, c]] : [[r, c], [r, c + 1]];
    if (tryPlace(cells, "#")) placed++;
  }

  const holes = Math.round(floorCount() * holeRate(n));
  for (let placed = 0, tries = 0; placed < holes && tries < holes * 20; tries++) {
    if (tryPlace([[1 + int(h - 2), 1 + int(iw)]], "O")) placed++;
  }

  g[start.r][start.c] = "S";
  g[goal.r][goal.c] = "G";
  return g.map(row => row.join(""));
}

// 壁と穴を避けて上下左右に進み、スタートからゴールへ行けるか
function hasPath(g, start, goal) {
  const seen = new Set([`${start.r},${start.c}`]);
  const queue = [start];
  while (queue.length) {
    const { r, c } = queue.pop();
    if (r === goal.r && c === goal.c) return true;
    for (const [nr, nc] of [[r + 1, c], [r - 1, c], [r, c + 1], [r, c - 1]]) {
      const key = `${nr},${nc}`;
      if (seen.has(key) || g[nr][nc] === "#" || g[nr][nc] === "O") continue;
      seen.add(key);
      queue.push({ r: nr, c: nc });
    }
  }
  return false;
}

export function isSolvable(rows) {
  const g = rows.map(row => [...row]);
  const find = ch => {
    const r = g.findIndex(row => row.includes(ch));
    return { r, c: g[r].indexOf(ch) };
  };
  return hasPath(g, find("S"), find("G"));
}
