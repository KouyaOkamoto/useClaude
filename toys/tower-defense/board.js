// 盤面: 道（敵の通り道）と、塔を建てられるマス。
import * as THREE from "three";
import { make } from "./assets.js";

export const COLS = 12;
export const ROWS = 10;
export const TILE_TOP = 0.2;   // タイルの上面の高さ

// 道の曲がり角（マス目）。左の外から入り、右下のお城へ向かう
const TURNS = [[0, 1], [8, 1], [8, 4], [3, 4], [3, 7], [10, 7], [10, 9]];

// マス (i, j) の中心の位置
export const cellToWorld = (i, j) => new THREE.Vector3(i - (COLS - 1) / 2, 0, j - (ROWS - 1) / 2);
export function worldToCell(x, z) {
  const i = Math.round(x + (COLS - 1) / 2), j = Math.round(z + (ROWS - 1) / 2);
  return i >= 0 && j >= 0 && i < COLS && j < ROWS ? [i, j] : null;
}

// 道のマスの並び
export const pathCells = (() => {
  const cells = [TURNS[0]];
  for (let k = 1; k < TURNS.length; k++) {
    const [x0, z0] = TURNS[k - 1], [x1, z1] = TURNS[k];
    const steps = Math.abs(x1 - x0) + Math.abs(z1 - z0);
    for (let s = 1; s <= steps; s++) cells.push([x0 + Math.sign(x1 - x0) * s, z0 + Math.sign(z1 - z0) * s]);
  }
  return cells;
})();
const isPath = new Set(pathCells.map(([i, j]) => `${i},${j}`));

// 敵が歩く線: 盤の外の出発点 → 道のマス → お城の門
export const route = (() => {
  const pts = pathCells.map(([i, j]) => cellToWorld(i, j).setY(TILE_TOP));
  const first = pts[0].clone().add(new THREE.Vector3(-1.4, 0, 0));
  const last = pts[pts.length - 1].clone().add(new THREE.Vector3(0, 0, 1.1));
  return [first, ...pts, last];
})();
export const routeLength = route.reduce((s, p, k) => (k ? s + p.distanceTo(route[k - 1]) : 0), 0);

// 道に沿って d だけ進んだ位置と向き
export function pointOnRoute(d, out = new THREE.Vector3()) {
  for (let k = 1; k < route.length; k++) {
    const seg = route[k].distanceTo(route[k - 1]);
    if (d <= seg || k === route.length - 1) {
      const t = Math.min(d / seg, 1);
      out.lerpVectors(route[k - 1], route[k], t);
      return { pos: out, dir: route[k].clone().sub(route[k - 1]).normalize() };
    }
    d -= seg;
  }
  return { pos: out.copy(route[route.length - 1]), dir: new THREE.Vector3(0, 0, 1) };
}

// 方向（隣のマスへの向き）→ 回転。タイルは元々 +z 方向に道が伸びている
const yawFor = ([dx, dz]) => Math.atan2(dx, dz);

// 盤面を組み立てる。塔を建てられるマスの一覧も返す
export function buildBoard(rand) {
  const group = new THREE.Group();
  const buildable = new Set();
  const dirTo = ([i, j], [a, b]) => [Math.sign(a - i), Math.sign(b - j)];

  for (let j = 0; j < ROWS; j++) {
    for (let i = 0; i < COLS; i++) {
      const pos = cellToWorld(i, j);
      const key = `${i},${j}`;
      let tile, yaw = 0;
      if (isPath.has(key)) {
        const k = pathCells.findIndex(([a, b]) => a === i && b === j);
        // 入口と出口は盤の外にあるものとして、前後のマスへの向きを求める
        const prev = k > 0 ? pathCells[k - 1] : [i - 1, j];
        const next = k < pathCells.length - 1 ? pathCells[k + 1] : [i, j + 1];
        const a = dirTo([i, j], prev), b = dirTo([i, j], next);
        if (a[0] === -b[0] && a[1] === -b[1]) {
          tile = k === 0 ? "tile-spawn" : "tile-straight";
          yaw = yawFor(b);
        } else {
          // 曲がり角: 元の向きでは +x と +z をつなぐ
          tile = "tile-corner-round";
          const has = (d) => (a[0] === d[0] && a[1] === d[1]) || (b[0] === d[0] && b[1] === d[1]);
          if (has([1, 0]) && has([0, 1])) yaw = 0;
          else if (has([1, 0]) && has([0, -1])) yaw = Math.PI / 2;
          else if (has([-1, 0]) && has([0, -1])) yaw = Math.PI;
          else yaw = -Math.PI / 2;
        }
      } else {
        // 道から離れた所には木や岩を置いて、建てられないマスにする
        const nearPath = pathCells.some(([a, b]) => Math.abs(a - i) + Math.abs(b - j) <= 1);
        const r = rand();
        if (!nearPath && r < 0.16) {
          tile = ["tile-tree", "tile-tree-double", "tile-rock", "tile-crystal"][Math.floor(rand() * 4)];
          yaw = Math.floor(rand() * 4) * (Math.PI / 2);
        } else {
          tile = "tile";
          buildable.add(key);
          if (rand() < 0.08) {
            const deco = make(rand() < 0.6 ? "detail-tree" : "detail-rocks");
            deco.position.copy(pos).add(new THREE.Vector3((rand() - 0.5) * 0.5, TILE_TOP, (rand() - 0.5) * 0.5));
            deco.userData.decoKey = key;
            group.add(deco);
          }
        }
      }
      const m = make(tile);
      m.position.copy(pos);
      m.rotation.y = yaw;
      group.add(m);
    }
  }
  return { group, buildable };
}

// お城: 道の終点の先に、門・塔・天守を組み立てる
export function buildCastle() {
  const castle = new THREE.Group();
  const end = cellToWorld(...pathCells[pathCells.length - 1]);
  // 門の中心（敵の歩く線の終点）
  const gate = route[route.length - 1].clone().setY(0);
  castle.position.copy(gate);
  const put = (name, x, z, yaw = 0, y = 0) => {
    const m = make(name);
    m.position.set(x, y, z);
    m.rotation.y = yaw;
    castle.add(m);
    return m;
  };
  // 地面（お城の敷地）。盤の端にぴったり付ける
  const edge = end.z + 0.5 - gate.z;
  for (let dx = -1; dx <= 1; dx++) for (let dz = 0; dz <= 1; dz++) put("tile", dx, edge + 0.5 + dz, 0, -0.02);
  // 門は半分ずつの部品を向かい合わせにする
  put("wall-doorway", 0, 0);
  put("wall-doorway", 0, 0, Math.PI);
  put("tower-square-roof", -1, 0);
  put("tower-square-roof", 1, 0);
  // 奥の天守
  put("tower-hexagon-base", 0, 1.1);
  put("tower-hexagon-mid", 0, 1.1, 0, 1.31);
  put("tower-hexagon-roof", 0, 1.1, 0, 1.77);
  put("flag", 0, 1.1, 0, 2.55);
  put("flag", -1, 0, 0, 1.95);
  put("flag", 1, 0, 0, 1.95);
  castle.userData.gate = gate;
  return castle;
}
