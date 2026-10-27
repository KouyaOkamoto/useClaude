// タワーディフェンスの中身: 塔・敵・弾・ウェーブ・ステージの勝ち負け。
import * as THREE from "three";
import { make, animationsOf, heightOf } from "./assets.js";
import { TILE_TOP, cellToWorld, pointOnRoute } from "./board.js";
import { ENEMY_INFO } from "./stages.js";

// 塔の種類。段（parts）を積み、てっぺんに武器を載せる。強化すると中段が増えて背が伸びる
export const TOWERS = {
  ballista: {
    name: "バリスタ", cost: 50, desc: "速く撃つ。1体ずつ狙う",
    bottom: "tower-round-bottom-a", middle: "tower-round-middle-a", top: "tower-round-top-a",
    weapon: "weapon-ballista", ammo: "weapon-ammo-arrow",
    range: 2.6, damage: 14, rate: 1.25, splash: 0, speed: 9, arc: 0.15, hp: 100,
  },
  cannon: {
    name: "大砲", cost: 90, desc: "まとめて吹き飛ばす",
    bottom: "tower-square-bottom-b", middle: "tower-square-middle-b", top: "tower-square-top-b",
    weapon: "weapon-cannon", ammo: "weapon-ammo-cannonball",
    range: 2.3, damage: 30, rate: 0.6, splash: 0.9, speed: 6, arc: 0.7, hp: 160,
  },
  catapult: {
    name: "投石機", cost: 140, desc: "遠くまで届く重い一撃",
    bottom: "tower-round-bottom-c", middle: "tower-round-middle-c", top: "tower-round-top-c",
    weapon: "weapon-catapult", ammo: "weapon-ammo-boulder",
    range: 3.6, damage: 55, rate: 0.32, splash: 1.3, speed: 4.5, arc: 1.8, hp: 130,
  },
};
export const MAX_LEVEL = 3;
export const LIVES = 20;
const TOWER_SCALE = 0.8;
export const upgradeCost = t => Math.round(TOWERS[t.type].cost * (t.level === 1 ? 0.75 : 1.25));
export const sellValue = t => Math.round(t.spent * 0.6);
// 残った命で星の数を決める
export const starsFor = lives => (lives >= LIVES ? 3 : lives >= LIVES / 2 ? 2 : 1);

// 敵の種類。能力を持つ敵は、決まった間隔（every 秒）で能力を使う
const ENEMIES = {
  orc: { model: "character-orc", hp: 55, speed: 0.95, reward: 7, harm: 1, scale: 0.7, held: [["weapon-spear", "arm-right"]] },
  knight: { model: "character-human", hp: 150, speed: 0.65, reward: 12, harm: 2, armor: 4, scale: 0.75, held: [["weapon-sword", "arm-right"], ["shield-round", "arm-left"]] },
  ufo: { model: "enemy-ufo-a", hp: 40, speed: 1.7, reward: 7, harm: 1, scale: 0.5, fly: 0.55 },
  // 回復役: 周りの仲間を少しずつ回復する
  healer: {
    model: "character-human", hp: 90, speed: 0.8, reward: 12, harm: 1, scale: 0.62, held: [["potion", "arm-right"]],
    heal: { every: 2.5, radius: 1.6, amount: 0.12 },
  },
  // 砲撃円盤: 近くの塔を撃つ
  gunner: {
    model: "enemy-ufo-a-weapon", hp: 110, speed: 0.85, reward: 14, harm: 2, scale: 0.55, fly: 0.55,
    gun: { every: 1.8, range: 2.2, damage: 12 },
  },
  // 中ボス: 号令で敵全体を一時的に速くする
  midboss: {
    model: "character-orc", hp: 1600, speed: 0.4, reward: 150, harm: 8, armor: 6, scale: 1.3, bar: 0.9,
    held: [["weapon-sword", "arm-right"], ["shield-rectangle", "arm-left"]],
    rally: { every: 8, time: 3, boost: 1.7 },
  },
  // ボス: いる間は金が半分・敵の攻撃が2倍。光線で塔を撃ち、円盤を呼ぶ
  boss: {
    model: "enemy-ufo-b-weapon", hp: 3000, speed: 0.26, reward: 0, harm: LIVES, scale: 1.5, fly: 0.9, bar: 1.1,
    drain: true,
    beam: { every: 6, range: 3.6, damage: 40 },
    summon: { every: 10, type: "ufo", count: 2 },
  },
};
const ABILITIES = ["heal", "gun", "rally", "beam", "summon"];

const ringGeometry = new THREE.RingGeometry(0.88, 1, 48).rotateX(-Math.PI / 2);

export function createGame(scene, ui) {
  const state = {
    stage: null, layout: null,
    gold: 0, lives: LIVES, wave: 0,
    waveActive: false, spawners: [], hpScale: 1,
    enemies: [], towers: new Map(), shots: [], bolts: [], effects: [],
    coinMul: 1, atkMul: 1,
    over: false, cleared: false,
  };

  // --- 塔 ---
  function towerStats(type, level) {
    const d = TOWERS[type];
    return {
      range: d.range + 0.3 * (level - 1),
      damage: d.damage * (1 + 0.6 * (level - 1)),
      rate: d.rate * (1 + 0.15 * (level - 1)),
      splash: d.splash,
      maxHp: Math.round(d.hp * (1 + 0.5 * (level - 1))),
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

  // このステージで建てられるか。建てられないときは理由を返す
  function buildBlock(type) {
    const st = state.stage;
    if (st.allowed && !st.allowed.includes(type)) return "このステージでは使えない";
    if (st.maxTowers && state.towers.size >= st.maxTowers) return `塔は${st.maxTowers}基まで`;
    if (state.gold < TOWERS[type].cost) return "金が足りない";
    return null;
  }

  function build(key, type) {
    const d = TOWERS[type];
    if (buildBlock(type) || state.towers.has(key)) return false;
    state.gold -= d.cost;
    const [i, j] = key.split(",").map(Number);
    const { group, weapon, muzzle } = towerModel(type, 1);
    group.position.copy(cellToWorld(i, j));
    scene.add(group);
    const stats = towerStats(type, 1);
    const tower = { key, type, level: 1, spent: d.cost, group, weapon, muzzle, cooldown: 0, ...stats, hp: stats.maxHp, ...hpBar(0.5) };
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
    const stats = towerStats(tower.type, tower.level);
    Object.assign(tower, { group, weapon, muzzle, ...stats, hp: tower.hp + stats.maxHp - tower.maxHp });
    pop(group, 0.3);
    ui.changed();
    return true;
  }

  function removeTower(tower) {
    scene.remove(tower.group, tower.back, tower.bar);
    tower.back.material.dispose();
    tower.bar.material.dispose();
    state.towers.delete(tower.key);
  }

  function sell(tower) {
    state.gold += sellValue(tower);
    removeTower(tower);
    ui.changed();
  }

  function hurtTower(tower, amount) {
    if (state.towers.get(tower.key) !== tower) return;
    tower.hp -= amount;
    if (tower.hp > 0) return;
    // 壊れた: 煙を残して消える
    puff(tower.group.position.clone().setY(TILE_TOP + 0.4), 0.9, 0x8a8178);
    removeTower(tower);
    ui.towerLost(tower);
    ui.changed();
  }

  // 建てたときに少し弾む
  function pop(obj, time) {
    state.effects.push({ obj, age: 0, life: time, kind: "pop" });
  }

  // 体力のバー（いつもカメラの方を向く板）
  function hpBar(width) {
    const back = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0x1b1b1b, depthTest: false }));
    const bar = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0x6ee06e, depthTest: false }));
    back.scale.set(width, 0.06, 1);
    bar.center.set(0, 0.5);
    bar.scale.set(width - 0.02, 0.045, 1);
    back.renderOrder = bar.renderOrder = 10;
    scene.add(back, bar);
    return { back, bar, barWidth: width - 0.02 };
  }
  const right = new THREE.Vector3();
  function placeBar(o, x, y, z, ratio) {
    o.back.position.set(x, y, z);
    // バーの左端を、カメラから見た左に合わせる
    o.bar.position.copy(o.back.position).addScaledVector(right, -o.barWidth / 2);
    o.bar.scale.x = Math.max(0.0001, o.barWidth * ratio);
    o.bar.material.color.setHSL(0.33 * ratio, 0.7, 0.55);
  }

  // --- 敵 ---
  function spawn(type, routeId, d = 0) {
    const e = ENEMIES[type];
    const obj = make(e.model);
    obj.scale.setScalar(e.scale);
    for (const [item, bone] of e.held ?? []) {
      const hand = obj.getObjectByName(bone);
      if (!hand) continue;
      const m = make(item);
      m.scale.setScalar(item === "potion" ? 0.6 : 0.9);
      m.position.set(0, -0.12, 0.12);
      hand.add(m);
    }
    let mixer = null, walk = null;
    const clips = animationsOf(e.model);
    if (clips.length) {
      mixer = new THREE.AnimationMixer(obj);
      walk = mixer.clipAction(THREE.AnimationClip.findByName(clips, "walk"));
      walk.timeScale = e.speed * 1.6 / e.scale * 0.7;
      walk.play();
    }
    scene.add(obj);
    const hp = Math.round(e.hp * state.hpScale);
    const enemy = {
      type, def: e, obj, mixer, walk, hp, maxHp: hp,
      routeId, route: state.layout.routes[routeId], d,
      alive: true, dying: 0, bob: Math.random() * 6, haste: 0, cd: {},
      top: heightOf(e.model) * e.scale + (e.fly ?? 0) + 0.12,
      ...hpBar(e.bar ?? 0.5),
    };
    // 能力は少し待ってから使い始める
    for (const a of ABILITIES) if (e[a]) enemy.cd[a] = e[a].every * (0.5 + Math.random() * 0.3);
    state.enemies.push(enemy);
    return enemy;
  }

  function damage(enemy, amount) {
    if (!enemy.alive) return;
    enemy.hp -= Math.max(1, amount - (enemy.def.armor ?? 0));
    if (enemy.hp <= 0) kill(enemy);
  }

  function kill(enemy) {
    enemy.alive = false;
    state.gold += Math.round(enemy.def.reward * state.coinMul);
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
    if (enemy.type === "midboss" || enemy.type === "boss") {
      ui.message(`${ENEMY_INFO[enemy.type].name}を倒した！`);
      puff(enemy.obj.position.clone().setY(enemy.obj.position.y + 0.4), 1.6, 0xfff1d6);
    }
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

  // 一番近い塔（射程 range の中）
  function nearestTower(pos, range) {
    let best = null, bestD = range * range;
    for (const t of state.towers.values()) {
      const dx = t.group.position.x - pos.x, dz = t.group.position.z - pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 <= bestD) { best = t; bestD = d2; }
    }
    return best;
  }

  // 能力を使う
  function useAbility(e, a) {
    const p = e.obj.position;
    const def = e.def[a];
    if (a === "heal") {
      for (const o of state.enemies) {
        if (o === e || !o.alive) continue;
        if (o.obj.position.distanceTo(p) <= def.radius) o.hp = Math.min(o.maxHp, o.hp + o.maxHp * def.amount);
      }
      ring(p, 0x7dff8a, def.radius, 0.7);
    } else if (a === "gun") {
      const t = nearestTower(p, def.range);
      if (!t) return false;
      const mesh = make("weapon-ammo-bullet");
      mesh.scale.setScalar(0.8);
      const from = p.clone().setY(p.y + 0.15), to = t.group.position.clone().setY(t.muzzle - 0.2);
      mesh.position.copy(from);
      scene.add(mesh);
      state.bolts.push({ mesh, from, to, t: 0, duration: from.distanceTo(to) / 5, tower: t, damage: def.damage * state.atkMul });
    } else if (a === "rally") {
      for (const o of state.enemies) if (o.alive) o.haste = def.time;
      ring(p, 0xffa040, 3.2, 0.9);
      ui.message(`${ENEMY_INFO[e.type].name}の号令！ 敵が速くなった`);
    } else if (a === "beam") {
      const t = nearestTower(p, def.range);
      if (!t) return false;
      const beam = make("enemy-ufo-beam");
      beam.position.copy(t.group.position).setY(TILE_TOP);
      beam.scale.set(0.7, Math.max(0.5, p.y - TILE_TOP), 0.7);
      beam.traverse(o => { o.castShadow = false; });
      scene.add(beam);
      state.effects.push({ obj: beam, age: 0, life: 0.5, kind: "beam" });
      hurtTower(t, def.damage * state.atkMul);
    } else if (a === "summon") {
      for (let k = 0; k < def.count; k++) spawn(def.type, e.routeId, Math.max(0, e.d - 0.3 - k * 0.5));
      ring(p, 0xb98cff, 1.2, 0.6);
    }
    return true;
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
    state.shots.push({ mesh, from, to, target: d.splash ? null : target, t: 0, duration, arc: d.arc, damage: tower.damage, splash: tower.splash });
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
      puff(shot.to, shot.splash * 0.6, 0xfff1d6);
    } else if (shot.target) {
      damage(shot.target, shot.damage);
    }
  }

  // --- 演出 ---
  function puff(pos, size, color) {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(size, 16, 10),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6, depthWrite: false }),
    );
    m.position.copy(pos);
    scene.add(m);
    state.effects.push({ obj: m, age: 0, life: 0.35, kind: "puff" });
  }
  // 地面に広がる輪（能力を使った合図）
  function ring(pos, color, radius, life) {
    const m = new THREE.Mesh(ringGeometry, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false }));
    m.position.set(pos.x, TILE_TOP + 0.04, pos.z);
    m.renderOrder = 6;
    scene.add(m);
    state.effects.push({ obj: m, age: 0, life, kind: "ring", radius });
  }

  // --- ステージとウェーブ ---
  function clear() {
    for (const e of state.enemies) removeEnemy(e);
    for (const t of [...state.towers.values()]) removeTower(t);
    for (const s of [...state.shots, ...state.bolts]) scene.remove(s.mesh);
    for (const fx of state.effects) if (fx.kind !== "pop") scene.remove(fx.obj);
  }

  function start(stage, layout) {
    clear();
    Object.assign(state, {
      stage, layout,
      gold: stage.gold, lives: LIVES, wave: 0,
      waveActive: false, spawners: [], hpScale: 1,
      enemies: [], towers: new Map(), shots: [], bolts: [], effects: [],
      coinMul: 1, atkMul: 1,
      over: false, cleared: false,
    });
    ui.changed();
  }

  // 次のウェーブの中身（予告用）: 通る道と、敵の種類ごとの数
  function nextWave() {
    const list = state.stage?.waves[state.wave];
    if (!list) return null;
    const counts = {};
    for (const grp of list) counts[grp.type] = (counts[grp.type] ?? 0) + grp.count;
    return { routes: [...new Set(list.map(grp => grp.route))], counts };
  }

  function startWave() {
    if (state.waveActive || state.over || state.cleared || !nextWave()) return;
    const list = state.stage.waves[state.wave];
    state.wave++;
    state.spawners = list.map(grp => ({ ...grp, left: grp.count, timer: grp.delay }));
    state.hpScale = state.stage.hp * (1 + 0.12 * (state.wave - 1));
    state.waveActive = true;
    const boss = list.find(grp => grp.type === "midboss" || grp.type === "boss");
    ui.message(boss ? `最終ウェーブ ・ ${ENEMY_INFO[boss.type].name}が来る！` : `ウェーブ ${state.wave}`);
    ui.changed();
  }

  // --- 毎フレームの更新 ---
  const tmp = new THREE.Vector3();
  function update(dt, camera) {
    right.set(1, 0, 0).applyQuaternion(camera.quaternion);
    if (state.waveActive) {
      for (const sp of state.spawners) {
        if (!sp.left) continue;
        sp.timer -= dt;
        if (sp.timer <= 0) {
          spawn(sp.type, sp.route);
          sp.left--;
          sp.timer = sp.gap;
        }
      }
    }

    // 母船がいる間は、金が半分・敵の攻撃が2倍
    const drain = state.enemies.some(e => e.alive && e.def.drain);
    if (drain !== (state.coinMul < 1)) {
      state.coinMul = drain ? 0.5 : 1;
      state.atkMul = drain ? 2 : 1;
      ui.changed();
    }

    for (const e of state.enemies) {
      e.mixer?.update(dt);
      if (!e.alive) {
        e.dying -= dt;
        if (e.dying < 0.4) e.obj.position.y -= dt * 0.8;   // 地面に沈んで消える
        continue;
      }
      const boost = e.haste > 0 ? 1.7 : 1;
      e.haste -= dt;
      e.d += e.def.speed * boost * dt;
      if (e.walk) e.walk.timeScale = e.def.speed * 1.6 / e.def.scale * 0.7 * boost;
      const { pos, dir } = pointOnRoute(e.route, e.d, tmp);
      e.obj.position.copy(pos);
      if (e.def.fly) e.obj.position.y += e.def.fly + Math.sin(performance.now() / 300 + e.bob) * 0.05;
      e.obj.rotation.y = Math.atan2(dir.x, dir.z);
      placeBar(e, pos.x, pos.y + e.top, pos.z, Math.max(0, e.hp / e.maxHp));
      for (const a in e.cd) {
        e.cd[a] -= dt;
        // 狙う塔がないときは、少し待ってからもう一度試す
        if (e.cd[a] <= 0) e.cd[a] = useAbility(e, a) ? e.def[a].every : 0.3;
      }
      // お城に着いた
      if (e.d >= e.route.length) {
        e.alive = false;
        e.dying = 0;
        state.lives = Math.max(0, state.lives - e.def.harm);
        ui.hurt();
        ui.changed();
        if (state.lives <= 0 && !state.over) {
          state.over = true;
          state.waveActive = false;
          ui.gameOver();
        }
      }
    }
    for (const e of state.enemies) if (!e.alive && e.dying <= 0) removeEnemy(e);
    state.enemies = state.enemies.filter(e => e.alive || e.dying > 0);

    // 塔: 射程に入った敵のうち、お城に一番近い敵を狙う
    for (const tower of state.towers.values()) {
      tower.cooldown -= dt;
      let best = null, bestLeft = Infinity;
      for (const e of state.enemies) {
        if (!e.alive) continue;
        const dx = e.obj.position.x - tower.group.position.x, dz = e.obj.position.z - tower.group.position.z;
        const left = e.route.length - e.d;
        if (dx * dx + dz * dz <= tower.range * tower.range && left < bestLeft) {
          best = e;
          bestLeft = left;
        }
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
      // 傷ついた塔だけ体力のバーを出す
      const hurt = tower.hp < tower.maxHp;
      tower.back.visible = tower.bar.visible = hurt;
      if (hurt) placeBar(tower, tower.group.position.x, tower.muzzle + 0.25, tower.group.position.z, tower.hp / tower.maxHp);
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

    // 敵の弾: まっすぐ塔へ
    for (const b of state.bolts) {
      b.t += dt / b.duration;
      b.mesh.position.lerpVectors(b.from, b.to, Math.min(b.t, 1));
      b.mesh.lookAt(b.to);
      if (b.t >= 1) {
        hurtTower(b.tower, b.damage);
        puff(b.to, 0.15, 0xffb070);
        scene.remove(b.mesh);
      }
    }
    state.bolts = state.bolts.filter(b => b.t < 1);

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
      if (fx.kind === "ring") {
        fx.obj.scale.setScalar(0.2 + fx.radius * Math.sqrt(k));
        fx.obj.material.opacity = 0.9 * (1 - k);
      }
      if (fx.kind === "beam") fx.obj.scale.x = fx.obj.scale.z = 0.7 * (1 - k * 0.8);
      if (k >= 1 && fx.kind !== "pop") {
        scene.remove(fx.obj);
        if (fx.kind === "puff") fx.obj.geometry.dispose();
        if (fx.kind === "puff" || fx.kind === "ring") fx.obj.material.dispose();
      }
    }
    state.effects = state.effects.filter(fx => fx.age < fx.life);

    // ウェーブの終わり: 塔は直り、最後のウェーブならステージクリア
    if (state.waveActive && !state.spawners.some(sp => sp.left) && !state.enemies.length) {
      state.waveActive = false;
      for (const t of state.towers.values()) t.hp = t.maxHp;
      if (state.wave >= state.stage.waves.length) {
        state.cleared = true;
        ui.stageClear(starsFor(state.lives));
      } else {
        const bonus = 20 + state.wave * 5;
        state.gold += bonus;
        ui.message(`ウェーブ ${state.wave} クリア ・ ボーナス ${bonus}`);
      }
      ui.changed();
    }
  }

  return { state, build, buildBlock, upgrade, sell, start, startWave, nextWave, update, towerStats };
}
