// タワーディフェンスの中身: 塔・敵・弾・ウェーブ。
import * as THREE from "three";
import { make, animationsOf, heightOf } from "./assets.js";
import { TILE_TOP, cellToWorld, pointOnRoute, routeLength } from "./board.js";

// 塔の種類。段（parts）を積み、てっぺんに武器を載せる。強化すると中段が増えて背が伸びる
export const TOWERS = {
  ballista: {
    name: "バリスタ", cost: 50, desc: "速く撃つ。1体ずつ狙う",
    bottom: "tower-round-bottom-a", middle: "tower-round-middle-a", top: "tower-round-top-a",
    weapon: "weapon-ballista", ammo: "weapon-ammo-arrow",
    range: 2.6, damage: 14, rate: 1.25, splash: 0, speed: 9, arc: 0.15,
  },
  cannon: {
    name: "大砲", cost: 90, desc: "まとめて吹き飛ばす",
    bottom: "tower-square-bottom-b", middle: "tower-square-middle-b", top: "tower-square-top-b",
    weapon: "weapon-cannon", ammo: "weapon-ammo-cannonball",
    range: 2.3, damage: 30, rate: 0.6, splash: 0.9, speed: 6, arc: 0.7,
  },
  catapult: {
    name: "投石機", cost: 140, desc: "遠くまで届く重い一撃",
    bottom: "tower-round-bottom-c", middle: "tower-round-middle-c", top: "tower-round-top-c",
    weapon: "weapon-catapult", ammo: "weapon-ammo-boulder",
    range: 3.6, damage: 55, rate: 0.32, splash: 1.3, speed: 4.5, arc: 1.8,
  },
};
export const MAX_LEVEL = 3;
const TOWER_SCALE = 0.8;
export const upgradeCost = t => Math.round(TOWERS[t.type].cost * (t.level === 1 ? 0.75 : 1.25));
export const sellValue = t => Math.round(t.spent * 0.6);

// 敵の種類
const ENEMIES = {
  orc: { model: "character-orc", hp: 55, speed: 0.95, reward: 7, harm: 1, scale: 0.7, held: [["weapon-spear", "arm-right"]] },
  knight: { model: "character-human", hp: 150, speed: 0.65, reward: 14, harm: 2, armor: 4, scale: 0.75, held: [["weapon-sword", "arm-right"], ["shield-round", "arm-left"]] },
  ufo: { model: "enemy-ufo-a", hp: 40, speed: 1.7, reward: 9, harm: 1, scale: 0.5, fly: 0.55 },
  boss: { model: "enemy-ufo-b", hp: 700, speed: 0.5, reward: 90, harm: 5, scale: 0.9, fly: 0.7 },
};

// ウェーブごとの敵の並び
function waveList(n) {
  const list = [];
  const count = 5 + n * 2;
  for (let k = 0; k < count; k++) {
    let type = "orc";
    if (n >= 3 && k % 3 === 2) type = "knight";
    if (n >= 4 && k % 4 === 1) type = "ufo";
    list.push(type);
  }
  if (n % 5 === 0) list.push("boss");
  return list;
}

export function createGame(scene, ui) {
  const state = {
    gold: 150, lives: 20, wave: 0,
    waveActive: false, queue: [], spawnTimer: 0,
    enemies: [], towers: new Map(), shots: [], effects: [],
    over: false,
  };

  // --- 塔 ---
  function towerStats(type, level) {
    const d = TOWERS[type];
    return {
      range: d.range + 0.3 * (level - 1),
      damage: d.damage * (1 + 0.6 * (level - 1)),
      rate: d.rate * (1 + 0.15 * (level - 1)),
      splash: d.splash,
    };
  }

  function towerModel(type, level) {
    const d = TOWERS[type];
    const group = new THREE.Group();
    // マスより少し小さくして、隣の塔との間にすき間を作る
    const body = new THREE.Group();
    body.position.y = TILE_TOP;
    body.scale.setScalar(TOWER_SCALE);
    group.add(body);
    let y = 0;
    for (const part of [d.bottom, ...Array(level - 1).fill(d.middle), d.top]) {
      const m = make(part);
      m.position.y = y;
      body.add(m);
      y += heightOf(part);
    }
    const weapon = make(d.weapon);
    weapon.position.y = y - heightOf(d.top) * 0.45;
    body.add(weapon);
    return { group, weapon, muzzle: TILE_TOP + y * TOWER_SCALE + 0.12 };
  }

  function build(key, type) {
    const d = TOWERS[type];
    if (state.gold < d.cost || state.towers.has(key)) return false;
    state.gold -= d.cost;
    const [i, j] = key.split(",").map(Number);
    const { group, weapon, muzzle } = towerModel(type, 1);
    group.position.copy(cellToWorld(i, j));
    scene.add(group);
    const tower = { key, type, level: 1, spent: d.cost, group, weapon, muzzle, cooldown: 0, ...towerStats(type, 1) };
    state.towers.set(key, tower);
    pop(group, 0.35);
    ui.changed();
    return tower;
  }

  function upgrade(tower) {
    if (tower.level >= MAX_LEVEL) return false;
    const cost = upgradeCost(tower);
    if (state.gold < cost) return false;
    state.gold -= cost;
    tower.spent += cost;
    tower.level++;
    const yaw = tower.weapon.rotation.y;
    scene.remove(tower.group);
    const { group, weapon, muzzle } = towerModel(tower.type, tower.level);
    group.position.copy(tower.group.position);
    weapon.rotation.y = yaw;
    scene.add(group);
    Object.assign(tower, { group, weapon, muzzle, ...towerStats(tower.type, tower.level) });
    pop(group, 0.3);
    ui.changed();
    return true;
  }

  function sell(tower) {
    state.gold += sellValue(tower);
    scene.remove(tower.group);
    state.towers.delete(tower.key);
    ui.changed();
  }

  // 建てたときに少し弾む
  function pop(obj, time) {
    state.effects.push({ obj, age: 0, life: time, kind: "pop" });
  }

  // --- 敵 ---
  function spawn(type, hpScale) {
    const e = ENEMIES[type];
    const obj = make(e.model);
    obj.scale.setScalar(e.scale);
    for (const [item, bone] of e.held ?? []) {
      const hand = obj.getObjectByName(bone);
      if (!hand) continue;
      const m = make(item);
      m.scale.setScalar(0.9);
      m.position.set(0, -0.12, 0.12);
      hand.add(m);
    }
    let mixer = null, walk = null;
    const clips = animationsOf(e.model);
    if (clips.length) {
      mixer = new THREE.AnimationMixer(obj);
      walk = mixer.clipAction(THREE.AnimationClip.findByName(clips, "walk"));
      walk.timeScale = e.speed * 1.6;
      walk.play();
    }
    scene.add(obj);
    // 体力のバー（いつもカメラの方を向く板）
    const back = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0x1b1b1b, depthTest: false }));
    const bar = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0x6ee06e, depthTest: false }));
    back.scale.set(0.5, 0.06, 1);
    bar.center.set(0, 0.5);
    bar.scale.set(0.48, 0.045, 1);
    back.renderOrder = bar.renderOrder = 10;
    scene.add(back, bar);
    const hp = Math.round(e.hp * hpScale);
    state.enemies.push({ type, def: e, obj, mixer, walk, back, bar, hp, maxHp: hp, d: 0, alive: true, dying: 0, bob: Math.random() * 6 });
  }

  function damage(enemy, amount) {
    if (!enemy.alive) return;
    enemy.hp -= Math.max(1, amount - (enemy.def.armor ?? 0));
    if (enemy.hp <= 0) kill(enemy);
  }

  function kill(enemy) {
    enemy.alive = false;
    state.gold += enemy.def.reward;
    ui.changed();
    enemy.back.visible = enemy.bar.visible = false;
    if (enemy.mixer) {
      enemy.walk.stop();
      const die = enemy.mixer.clipAction(THREE.AnimationClip.findByName(animationsOf(enemy.def.model), "die"));
      die.setLoop(THREE.LoopOnce, 1);
      die.clampWhenFinished = true;
      die.play();
    }
    enemy.dying = 1.2;
    // 倒した所から金貨が跳ねる
    const coin = make("coin");
    coin.scale.setScalar(0.6);
    coin.position.copy(enemy.obj.position).add(new THREE.Vector3(0, 0.3, 0));
    scene.add(coin);
    state.effects.push({ obj: coin, age: 0, life: 0.9, kind: "coin" });
  }

  function removeEnemy(enemy) {
    scene.remove(enemy.obj, enemy.back, enemy.bar);
    enemy.back.material.dispose();
    enemy.bar.material.dispose();
  }

  // --- 弾 ---
  function fire(tower, target) {
    const d = TOWERS[tower.type];
    const from = tower.group.position.clone().setY(tower.muzzle);
    const to = target.obj.position.clone().setY(target.obj.position.y + 0.25);
    const mesh = make(d.ammo);
    mesh.scale.setScalar(0.7);
    mesh.position.copy(from);
    scene.add(mesh);
    const duration = from.distanceTo(to) / d.speed + 0.05;
    state.shots.push({ mesh, from, to, target: d.splash ? null : target, t: 0, duration, arc: d.arc, damage: tower.damage, splash: tower.splash, homing: !d.splash });
    // 武器を撃った方へ少し反動させる
    tower.recoil = 0.12;
  }

  function impact(shot) {
    if (shot.splash) {
      for (const e of state.enemies) {
        if (!e.alive) continue;
        const dist = e.obj.position.distanceTo(shot.to);
        if (dist < shot.splash) damage(e, shot.damage * (1 - 0.5 * dist / shot.splash));
      }
      const puff = new THREE.Mesh(
        new THREE.SphereGeometry(shot.splash * 0.6, 16, 10),
        new THREE.MeshBasicMaterial({ color: 0xfff1d6, transparent: true, opacity: 0.6, depthWrite: false }),
      );
      puff.position.copy(shot.to);
      scene.add(puff);
      state.effects.push({ obj: puff, age: 0, life: 0.35, kind: "puff" });
    } else if (shot.target) {
      damage(shot.target, shot.damage);
    }
  }

  // --- ウェーブ ---
  function startWave() {
    if (state.waveActive || state.over) return;
    state.wave++;
    state.queue = waveList(state.wave);
    state.hpScale = 1 + 0.2 * (state.wave - 1) + 0.02 * (state.wave - 1) ** 2;
    state.interval = Math.max(0.45, 1.1 - state.wave * 0.04);
    state.spawnTimer = 0;
    state.waveActive = true;
    ui.message(state.wave % 5 === 0 ? `ウェーブ ${state.wave} ・ 大円盤が来る！` : `ウェーブ ${state.wave}`);
    ui.changed();
  }

  // --- 毎フレームの更新 ---
  const tmp = new THREE.Vector3();
  function update(dt, camera) {
    if (state.waveActive && state.queue.length) {
      state.spawnTimer -= dt;
      if (state.spawnTimer <= 0) {
        spawn(state.queue.shift(), state.hpScale);
        state.spawnTimer = state.interval;
      }
    }

    for (const e of state.enemies) {
      e.mixer?.update(dt);
      if (!e.alive) {
        e.dying -= dt;
        if (e.dying < 0.4) e.obj.position.y -= dt * 0.8;   // 地面に沈んで消える
        continue;
      }
      e.d += e.def.speed * dt;
      const { pos, dir } = pointOnRoute(e.d, tmp);
      e.obj.position.copy(pos);
      if (e.def.fly) e.obj.position.y += e.def.fly + Math.sin(performance.now() / 300 + e.bob) * 0.05;
      e.obj.rotation.y = Math.atan2(dir.x, dir.z);
      const top = e.obj.position.y + (e.def.fly ? 0.45 : 0.62);
      e.back.position.set(pos.x, top, pos.z);
      // バーの左端を、カメラから見た左に合わせる
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
      e.bar.position.copy(e.back.position).addScaledVector(right, -0.24);
      const ratio = Math.max(0, e.hp / e.maxHp);
      e.bar.scale.x = 0.48 * ratio;
      e.bar.material.color.setHSL(0.33 * ratio, 0.7, 0.55);
      // お城に着いた
      if (e.d >= routeLength) {
        e.alive = false;
        e.dying = 0;
        state.lives = Math.max(0, state.lives - e.def.harm);
        ui.hurt();
        ui.changed();
        if (state.lives <= 0 && !state.over) {
          state.over = true;
          ui.gameOver(state.wave);
        }
      }
    }
    for (const e of state.enemies) if (!e.alive && e.dying <= 0) removeEnemy(e);
    state.enemies = state.enemies.filter(e => e.alive || e.dying > 0);

    // 塔: 射程に入った敵のうち、一番先に進んでいる敵を狙う
    for (const tower of state.towers.values()) {
      tower.cooldown -= dt;
      let best = null;
      for (const e of state.enemies) {
        if (!e.alive) continue;
        const dx = e.obj.position.x - tower.group.position.x, dz = e.obj.position.z - tower.group.position.z;
        if (dx * dx + dz * dz <= tower.range * tower.range && (!best || e.d > best.d)) best = e;
      }
      if (best) {
        const want = Math.atan2(best.obj.position.x - tower.group.position.x, best.obj.position.z - tower.group.position.z);
        let diff = want - tower.weapon.rotation.y;
        diff = Math.atan2(Math.sin(diff), Math.cos(diff));
        tower.weapon.rotation.y += diff * Math.min(1, dt * 10);
        if (tower.cooldown <= 0 && Math.abs(diff) < 0.4) {
          fire(tower, best);
          tower.cooldown = 1 / tower.rate;
        }
      }
      if (tower.recoil) {
        tower.recoil = Math.max(0, tower.recoil - dt * 0.6);
        tower.weapon.scale.setScalar(1 - tower.recoil * 0.6);
      }
    }

    // 弾: 放物線を描いて飛ぶ。1体狙いの弾は相手を追いかける
    for (const s of state.shots) {
      s.t += dt / s.duration;
      if (s.target?.alive) s.to.copy(s.target.obj.position).setY(s.target.obj.position.y + 0.25);
      const t = Math.min(s.t, 1);
      const prev = s.mesh.position.clone();
      s.mesh.position.lerpVectors(s.from, s.to, t);
      s.mesh.position.y += Math.sin(Math.PI * t) * s.arc;
      if (s.mesh.position.distanceToSquared(prev) > 1e-6) s.mesh.lookAt(s.mesh.position.clone().add(s.mesh.position.clone().sub(prev)));
      if (s.t >= 1) {
        impact(s);
        scene.remove(s.mesh);
      }
    }
    state.shots = state.shots.filter(s => s.t < 1);

    // 演出
    for (const fx of state.effects) {
      fx.age += dt;
      const k = Math.min(fx.age / fx.life, 1);
      if (fx.kind === "pop") fx.obj.scale.setScalar(1 + Math.sin(k * Math.PI) * 0.15);
      if (fx.kind === "coin") {
        fx.obj.position.y += dt * 1.2;
        fx.obj.rotation.y += dt * 9;
        fx.obj.scale.setScalar(0.6 * (1 - k * k));
      }
      if (fx.kind === "puff") {
        fx.obj.scale.setScalar(0.6 + k);
        fx.obj.material.opacity = 0.6 * (1 - k);
      }
      if (k >= 1 && fx.kind !== "pop") {
        scene.remove(fx.obj);
        if (fx.kind === "puff") {
          fx.obj.geometry.dispose();
          fx.obj.material.dispose();
        }
      }
    }
    state.effects = state.effects.filter(fx => fx.age < fx.life);

    // ウェーブの終わり
    if (state.waveActive && !state.queue.length && !state.enemies.length) {
      state.waveActive = false;
      if (!state.over) {
        const bonus = 20 + state.wave * 5;
        state.gold += bonus;
        ui.message(`ウェーブ ${state.wave} クリア ・ ボーナス ${bonus}`);
        ui.changed();
      }
    }
  }

  function reset() {
    for (const e of state.enemies) removeEnemy(e);
    for (const t of state.towers.values()) scene.remove(t.group);
    for (const s of state.shots) scene.remove(s.mesh);
    for (const fx of state.effects) if (fx.kind !== "pop") scene.remove(fx.obj);
    Object.assign(state, {
      gold: 150, lives: 20, wave: 0, waveActive: false, queue: [], spawnTimer: 0,
      enemies: [], towers: new Map(), shots: [], effects: [], over: false,
    });
    ui.changed();
  }

  return { state, build, upgrade, sell, startWave, update, reset, towerStats };
}
