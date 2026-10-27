// 盤面: ステージの設計図から、道（敵の通り道）と塔を建てられるマスを組み立てる。
import * as THREE from "three";
import { make } from "./assets.js";
import { ROUTE_COLORS } from "./stages.js";

export const COLS = 12;
export const ROWS = 10;
export const TILE_TOP = 0.2;   // タイルの上面の高さ

// マス (i, j) の中心の位置
export const cellToWorld = (i, j) => new THREE.Vector3(i - (COLS - 1) / 2, 0, j - (ROWS - 1) / 2);
export function worldToCell(x, z) {
  const i = Math.round(x + (COLS - 1) / 2), j = Math.round(z + (ROWS - 1) / 2);
  return i >= 0 && j >= 0 && i < COLS && j < ROWS ? [i, j] : null;
}

// 曲がり角の並びを、1マスずつのリストに広げる
function expand(turns) {
  const cells = [turns[0]];
  for (let k = 1; k < turns.length; k++) {
    const [x0, z0] = turns[k - 1], [x1, z1] = turns[k];
    const steps = Math.abs(x1 - x0) + Math.abs(z1 - z0);
    for (let s = 1; s <= steps; s++) cells.push([x0 + Math.sign(x1 - x0) * s, z0 + Math.sign(z1 - z0) * s]);
  }
  return cells;
}

// ステージの道の形を求める。
// cells: 道のマス → つながっている向きの集合、routes: 敵が歩く線（盤の外の出発点 → 門）
export function createLayout(stage) {
  const cells = new Map();
  const spawns = new Map();   // 入口のマス → 道の番号
  const connect = (key, d) => {
    if (!cells.has(key)) cells.set(key, new Set());
    cells.get(key).add(d.join(","));
  };
  const routes = stage.routes.map((turns, r) => {
    const list = expand(turns);
    // 入口は最初の一歩と逆向きの、盤の外から入ってくる
    const enter = [list[1][0] - list[0][0], list[1][1] - list[0][1]];
    list.forEach(([i, j], k) => {
      const prev = k ? list[k - 1] : [i - enter[0], j - enter[1]];
      const next = k < list.length - 1 ? list[k + 1] : [i, j + 1];
      connect(`${i},${j}`, [prev[0] - i, prev[1] - j]);
      connect(`${i},${j}`, [next[0] - i, next[1] - j]);
    });
    spawns.set(list[0].join(","), r);
    const pts = list.map(([i, j]) => cellToWorld(i, j).setY(TILE_TOP));
    const first = pts[0].clone().add(new THREE.Vector3(-enter[0] * 1.4, 0, -enter[1] * 1.4));
    const last = pts[pts.length - 1].clone().add(new THREE.Vector3(0, 0, 1.1));
    const points = [first, ...pts, last];
    const length = points.reduce((s, p, k) => (k ? s + p.distanceTo(points[k - 1]) : 0), 0);
    return { points, length, enter };
  });
  const gate = routes[0].points.at(-1).clone().setY(0);
  return { cells, spawns, routes, gate };
}

// 道に沿って d だけ進んだ位置と向き
export function pointOnRoute(route, d, out = new THREE.Vector3()) {
  const pts = route.points;
  for (let k = 1; k < pts.length; k++) {
    const seg = pts[k].distanceTo(pts[k - 1]);
    if (d <= seg || k === pts.length - 1) {
      const t = Math.min(Math.max(d, 0) / seg, 1);
      out.lerpVectors(pts[k - 1], pts[k], t);
      return { pos: out, dir: pts[k].clone().sub(pts[k - 1]).normalize() };
    }
    d -= seg;
  }
  return { pos: out.copy(pts[pts.length - 1]), dir: new THREE.Vector3(0, 0, 1) };
}

// 道タイルの元の向き（回転 0 でつながっている向き）
const TILE_DIRS = {
  "tile-straight": ["0,1", "0,-1"],
  "tile-corner-round": ["1,0", "0,1"],
  "tile-split": ["1,0", "-1,0", "0,1"],
  "tile-crossing": ["1,0", "-1,0", "0,1", "0,-1"],
};
// 欲しい向きの組み合わせになるよう、90°ずつ回して合うものを探す
function fitTile(name, want) {
  for (let q = 0; q < 4; q++) {
    const yaw = q * Math.PI / 2;
    const c = Math.round(Math.cos(yaw)), s = Math.round(Math.sin(yaw));
    // y 軸まわりの回転: (x, z) → (x cos + z sin, -x sin + z cos)
    const got = TILE_DIRS[name].map(d => {
      const [x, z] = d.split(",").map(Number);
      return `${x * c + z * s},${-x * s + z * c}`;
    });
    if (got.length === want.size && got.every(d => want.has(d))) return yaw;
  }
  return 0;
}

// 盤面を組み立てる。塔を建てられるマスの一覧も返す
export function buildBoard(layout, stage, rand) {
  const group = new THREE.Group();
  const buildable = new Set();
  const rocks = stage.rocks ?? 0.16;
  const isPath = key => layout.cells.has(key);

  for (let j = 0; j < ROWS; j++) {
    for (let i = 0; i < COLS; i++) {
      const pos = cellToWorld(i, j);
      const key = `${i},${j}`;
      let tile, yaw = 0;
      if (isPath(key)) {
        const dirs = layout.cells.get(key);
        if (dirs.size === 4) tile = "tile-crossing";
        else if (dirs.size === 3) tile = "tile-split";
        else {
          const [a, b] = [...dirs].map(d => d.split(",").map(Number));
          tile = a[0] === -b[0] && a[1] === -b[1] ? "tile-straight" : "tile-corner-round";
        }
        if (layout.spawns.has(key) && tile === "tile-straight") tile = "tile-spawn";
        yaw = fitTile(tile === "tile-spawn" ? "tile-straight" : tile, dirs);
      } else {
        // 道から離れた所には木や岩を置いて、建てられないマスにする。
        // 岩の多いステージでは道のそばにも置く
        const nearPath = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => isPath(`${i + a},${j + b}`));
        const r = rand();
        if ((!nearPath || rocks > 0.2) && r < rocks) {
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

  // 入口の外に、道ごとの色の旗を立てる
  layout.routes.forEach((route, r) => {
    // 入口のマスの、盤の外側の角
    const side = [-route.enter[1], route.enter[0]];
    const p = route.points[1].clone().add(new THREE.Vector3(
      -route.enter[0] * 0.42 + side[0] * 0.42, 0, -route.enter[1] * 0.42 + side[1] * 0.42));
    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(0.03, 0.03, 0.8, 8),
      new THREE.MeshStandardMaterial({ color: 0x6b4a32 }),
    );
    post.position.set(p.x, TILE_TOP + 0.4, p.z);
    const cloth = new THREE.Mesh(
      new THREE.PlaneGeometry(0.34, 0.22),
      new THREE.MeshStandardMaterial({ color: ROUTE_COLORS[r], side: THREE.DoubleSide }),
    );
    cloth.position.set(p.x, TILE_TOP + 0.68, p.z);
    cloth.translateX(0.17);
    post.castShadow = cloth.castShadow = true;
    group.add(post, cloth);
  });
  return { group, buildable };
}

// お城: 道の終点の先に、門・塔・天守を組み立てる
export function buildCastle(layout) {
  const castle = new THREE.Group();
  const gate = layout.gate;
  castle.position.copy(gate);
  const put = (name, x, z, yaw = 0, y = 0) => {
    const m = make(name);
    m.position.set(x, y, z);
    m.rotation.y = yaw;
    castle.add(m);
    return m;
  };
  // 地面（お城の敷地）。盤の端にぴったり付ける
  const edge = ROWS / 2 - gate.z;
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
  return castle;
}

// 次のウェーブで敵が通る道に、流れる矢印を並べる
export function createRoutePreview(scene, layout) {
  const arrow = new THREE.ShapeGeometry(new THREE.Shape([
    new THREE.Vector2(0, 0.16), new THREE.Vector2(0.13, -0.04), new THREE.Vector2(0.05, -0.04),
    new THREE.Vector2(0.05, -0.14), new THREE.Vector2(-0.05, -0.14), new THREE.Vector2(-0.05, -0.04),
    new THREE.Vector2(-0.13, -0.04),
  ])).rotateX(-Math.PI / 2).rotateY(Math.PI);
  const STEP = 0.5;
  const lines = layout.routes.map((route, r) => {
    const count = Math.ceil(route.length / STEP);
    const mesh = new THREE.InstancedMesh(arrow, new THREE.MeshBasicMaterial({
      color: ROUTE_COLORS[r], transparent: true, opacity: 0.85, depthWrite: false,
    }), count);
    mesh.renderOrder = 5;
    mesh.frustumCulled = false;
    mesh.visible = false;
    scene.add(mesh);
    // 道が重なる所では、色が交互に流れるよう少しずつずらす
    return { mesh, route, count, phase: r * STEP / layout.routes.length };
  });
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  let t = 0;
  return {
    show(routeIds) { lines.forEach((l, r) => { l.mesh.visible = routeIds.includes(r); }); },
    update(dt) {
      t = (t + dt * 0.8) % STEP;
      for (const l of lines) {
        if (!l.mesh.visible) continue;
        for (let k = 0; k < l.count; k++) {
          const d = k * STEP + (t + l.phase) % STEP;
          const { pos, dir } = pointOnRoute(l.route, d);
          // 両端は小さくしてふわっと出入りさせる
          const edge = Math.min(1, d / 0.8, (l.route.length - d) / 0.8);
          q.setFromAxisAngle(up, Math.atan2(dir.x, dir.z));
          s.setScalar(Math.max(edge, 0.001));
          m.compose(pos.setY(TILE_TOP + 0.03), q, s);
          l.mesh.setMatrixAt(k, m);
        }
        l.mesh.instanceMatrix.needsUpdate = true;
      }
    },
    dispose() {
      for (const l of lines) {
        scene.remove(l.mesh);
        l.mesh.material.dispose();
        l.mesh.dispose();
      }
      arrow.dispose();
    },
  };
}
