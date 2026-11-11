// 炎・火の粉・煙の見た目。
// 炎は箱の中をレイマーチして、上へ流れる 3D ノイズを温度とみなして光らせる。
import * as THREE from "three";

const NOISE = /* glsl */ `
float hash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float noise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x),
                 mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x),
                 mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float fbm(vec3 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) {
    s += a * noise(p);
    p = p * 2.07 + vec3(1.7, 9.2, 3.1);
    a *= 0.5;
  }
  return s / 0.875;
}`;

// 単位立方体 (-0.5〜0.5) の中で炎を描く。メッシュの拡大で大きさを変える
export function createFlame() {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uCamObj: { value: new THREE.Vector3() },
      uTime: { value: 0 },
      uPower: { value: 1 },
      uSeed: { value: 0 },
      uRise: { value: 3.0 },
      uMorph: { value: 0 },
      uSway: { value: 0.55 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vPos;
      void main() {
        vPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uCamObj;
      uniform float uTime, uPower, uSeed, uRise, uMorph, uSway;
      varying vec3 vPos;
      ${NOISE}
      // 温度 → 色 (暗い赤 → 橙 → 黄 → 白に近い黄)
      vec3 ramp(float t) {
        return vec3(1.0, 0.2, 0.03) * smoothstep(0.0, 0.35, t)
             + vec3(0.0, 0.38, 0.06) * smoothstep(0.3, 0.75, t)
             + vec3(0.0, 0.18, 0.22) * smoothstep(0.7, 1.0, t);
      }
      void main() {
        vec3 ro = uCamObj, rd = normalize(vPos - uCamObj);
        vec3 inv = 1.0 / rd;
        vec3 t0 = (-0.5 - ro) * inv, t1 = (0.5 - ro) * inv;
        vec3 tmin = min(t0, t1), tmax = max(t0, t1);
        float tn = max(max(max(tmin.x, tmin.y), tmin.z), 0.0);
        float tf = min(min(tmax.x, tmax.y), tmax.z);
        if (tf <= tn) discard;
        const int STEPS = 40;
        float dt = (tf - tn) / float(STEPS);
        float jitter = hash(vec3(gl_FragCoord.xy, fract(uTime)));
        vec3 col = vec3(0.0);
        float time = uTime + uSeed;
        for (int i = 0; i < STEPS; i++) {
          vec3 p = ro + rd * (tn + (float(i) + jitter) * dt);
          float y = p.y + 0.5;
          // 横に細かく縦に長いノイズを上へ流すと、炎の舌のような筋になる
          // uRise: 上へ流れる速さ / uMorph: 模様そのものが形を変える速さ
          vec3 q = vec3(p.x * 5.0, p.y * 2.4 - time * uRise, p.z * 5.0 + time * uMorph);
          // 上ほど大きく横に揺らす
          vec2 sway = vec2(noise(q * 0.4 + 4.0), noise(q * 0.4 + 11.0)) - 0.5;
          vec2 xz = p.xz + sway * uSway * y;
          float r = length(xz) * 2.1;
          float width = pow(max(1.0 - y, 0.0), 0.45);
          float s = 1.0 - r / max(width, 1e-3);
          float n = fbm(q);
          // 形 (中心ほど熱い) にノイズを大きく足して、縁をちぎれた舌にする
          float temp = s * 1.0 + (n - 0.5) * 2.8 - y * 0.55;
          // 箱の壁や天井で切れて見えないよう、端に近づくほど消す
          float edge = 1.0 - smoothstep(0.38, 0.5, max(abs(p.x), abs(p.z)));
          temp = clamp(temp, 0.0, 1.0) * smoothstep(0.0, 0.08, y) * (1.0 - smoothstep(0.85, 1.0, y)) * edge * uPower;
          col += ramp(temp) * temp * dt * 6.0;
        }
        gl_FragColor = vec4(col, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.BackSide,
  });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
  mesh.renderOrder = 2;
  mesh.frustumCulled = false;
  const inv = new THREE.Matrix4();
  return {
    mesh,
    // 炎の動きの速さ (rise / morph / sway) を設定する
    setMotion({ rise, morph, sway }) {
      material.uniforms.uRise.value = rise;
      material.uniforms.uMorph.value = morph;
      material.uniforms.uSway.value = sway;
    },
    update(camera, time, power) {
      mesh.updateMatrixWorld();
      inv.copy(mesh.matrixWorld).invert();
      material.uniforms.uCamObj.value.copy(camera.position).applyMatrix4(inv);
      material.uniforms.uTime.value = time;
      material.uniforms.uPower.value = power;
    },
  };
}

// 火の粉: 小さな光る点。位置は JS で動かす
export function createSparks(max = 300) {
  const positions = new Float32Array(max * 3);
  const life = new Float32Array(max);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("aLife", new THREE.BufferAttribute(life, 1));
  const material = new THREE.ShaderMaterial({
    uniforms: { uScale: { value: 1 } },
    vertexShader: /* glsl */ `
      attribute float aLife;
      uniform float uScale;
      varying float vLife;
      void main() {
        vLife = aLife;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aLife <= 0.0 ? 0.0 : uScale * (0.6 + aLife) * 0.028 / -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying float vLife;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        if (d > 0.5) discard;
        float a = 1.0 - smoothstep(0.0, 0.5, d);
        a *= a;
        vec3 c = mix(vec3(1.0, 0.25, 0.03), vec3(1.0, 0.75, 0.3), vLife);
        // 明るすぎるとブルームのにじみが四角く見えるので抑えめにする
        gl_FragColor = vec4(c * a * (0.35 + 0.8 * vLife), 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 3;

  const sparks = [];
  return {
    points,
    emit(x, y, z, strength) {
      if (sparks.length >= max) return;
      sparks.push({
        x, y, z,
        vx: (Math.random() - 0.5) * 0.4,
        vy: (0.8 + Math.random() * 1.6) * (0.6 + 0.4 * strength),
        vz: (Math.random() - 0.5) * 0.4,
        age: 0,
        life: 1.2 + Math.random() * 2.2,
        phase: Math.random() * 10,
      });
    },
    update(dt, scale) {
      material.uniforms.uScale.value = scale;
      for (const s of sparks) {
        s.age += dt;
        s.vx += Math.sin(s.age * 4 + s.phase) * 0.9 * dt;
        s.vz += Math.cos(s.age * 3.3 + s.phase) * 0.9 * dt;
        s.vy *= Math.exp(-0.6 * dt);
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        s.z += s.vz * dt;
      }
      for (let i = sparks.length - 1; i >= 0; i--) if (sparks[i].age > sparks[i].life) sparks.splice(i, 1);
      for (let i = 0; i < max; i++) {
        const s = sparks[i];
        if (s) {
          positions.set([s.x, s.y, s.z], i * 3);
          life[i] = 1 - s.age / s.life;
        } else {
          life[i] = 0;
        }
      }
      geometry.attributes.position.needsUpdate = true;
      geometry.attributes.aLife.needsUpdate = true;
    },
    clear() {
      sparks.length = 0;
    },
  };
}

// 煙: 柔らかい円のスプライトをゆっくり昇らせて広げる
export function createSmoke(count = 18, { color = 0x8a8580, opacity = 0.14 } = {}) {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, "rgba(255,255,255,0.55)");
  grad.addColorStop(0.5, "rgba(255,255,255,0.2)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  // まだらにする
  for (let i = 0; i < 60; i++) {
    g.fillStyle = `rgba(0,0,0,${Math.random() * 0.08})`;
    g.beginPath();
    g.arc(20 + Math.random() * 88, 20 + Math.random() * 88, 6 + Math.random() * 18, 0, Math.PI * 2);
    g.fill();
  }
  // まだらが四角の角まではみ出さないよう、円の形で切り抜く
  g.globalCompositeOperation = "destination-in";
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const texture = new THREE.CanvasTexture(c);
  const group = new THREE.Group();
  const puffs = [];
  for (let i = 0; i < count; i++) {
    const material = new THREE.SpriteMaterial({
      map: texture, color, transparent: true, depthWrite: false, opacity: 0,
    });
    const sprite = new THREE.Sprite(material);
    sprite.renderOrder = 1;
    group.add(sprite);
    puffs.push({ sprite, age: (i / count) * 7, life: 7, x: 0, z: 0, rot: Math.random() * 6 });
  }
  return {
    group,
    update(dt, strength, wind) {
      for (const p of puffs) {
        p.age += dt;
        if (p.age > p.life) {
          p.age = 0;
          p.x = (Math.random() - 0.5) * 0.2;
          p.z = (Math.random() - 0.5) * 0.2;
          p.rot = Math.random() * 6;
        }
        const k = p.age / p.life;
        p.x += wind.x * dt * k;
        p.z += wind.y * dt * k;
        p.sprite.position.set(p.x, 0.7 + k * 3.2, p.z);
        const s = 0.4 + k * 2.2;
        p.sprite.scale.set(s, s, s);
        p.sprite.material.rotation = p.rot + k * 0.8;
        p.sprite.material.opacity = Math.sin(Math.PI * k) * opacity * strength;
      }
    },
  };
}
