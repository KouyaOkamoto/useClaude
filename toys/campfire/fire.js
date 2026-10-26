// WebGL2 で動かす炎の流体シミュレーション。
// 温度と速度の格子を GPU 上で毎フレーム更新する:
//   移流 → 熱と上昇気流の注入 → 浮力 → 渦の強調 → 圧力で非圧縮に補正
// 座標は格子のマス単位で、y は上向き。

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const NOISE = `
float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  return 0.55 * noise(p) + 0.3 * noise(p * 2.03 + 7.1) + 0.15 * noise(p * 4.01 + 3.7);
}`;

const SHADERS = {
  advectVelocity: `
    uniform sampler2D uVelocity;
    uniform vec2 uTexel;
    uniform float uDt, uDamp;
    void main() {
      vec2 p = vUv - uDt * texture(uVelocity, vUv).xy * uTexel;
      o = vec4(texture(uVelocity, p).xy * exp(-uDamp * uDt), 0.0, 1.0);
    }`,

  // 冷え方は温度の4乗に近い項を入れると、炎の先が細くなる
  advectTemperature: `
    uniform sampler2D uVelocity, uTemperature;
    uniform vec2 uTexel;
    uniform float uDt, uCoolA, uCoolB;
    void main() {
      vec2 p = vUv - uDt * texture(uVelocity, vUv).xy * uTexel;
      float t = texture(uTemperature, p).x;
      t -= uDt * (uCoolA * t + uCoolB * t * t * t * t);
      t *= 1.0 - smoothstep(0.85, 1.0, vUv.y) * 0.2;
      o = vec4(max(t, 0.0), 0.0, 0.0, 1.0);
    }`,

  // 燃えている薪（線分）のまわりに熱と上昇気流を足す。揺らぎはノイズで作る
  source: `
    #define MAX_SOURCES 24
    uniform sampler2D uField;
    uniform vec2 uSize;
    uniform vec4 uSegments[MAX_SOURCES];
    uniform vec2 uParams[MAX_SOURCES];   // x: 半径, y: 強さ
    uniform int uCount, uMode;
    uniform float uTime, uDt;
    ${NOISE}
    void main() {
      vec2 p = vUv * uSize;
      float w = 0.0;
      for (int i = 0; i < MAX_SOURCES; i++) {
        if (i >= uCount) break;
        vec2 a = uSegments[i].xy, ab = uSegments[i].zw - a;
        float h = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-4), 0.0, 1.0);
        float d = length(p - a - ab * h);
        float r = uParams[i].x;
        w += uParams[i].y * exp(-d * d / (r * r));
      }
      vec4 f = texture(uField, vUv);
      if (uMode == 0) {
        float n = fbm(vec2(p.x * 0.16, p.y * 0.05 - uTime * 2.6));
        f.x += uDt * w * 7.0 * smoothstep(0.42, 0.8, n);
      } else {
        float n = fbm(vec2(p.x * 0.05 + 17.0, p.y * 0.04 - uTime * 1.3)) * 2.0 - 1.0;
        f.xy += uDt * w * vec2(n * 60.0, 120.0);
      }
      o = f;
    }`,

  buoyancy: `
    uniform sampler2D uVelocity, uTemperature;
    uniform float uDt, uLift;
    void main() {
      vec2 v = texture(uVelocity, vUv).xy;
      v.y += uDt * uLift * texture(uTemperature, vUv).x;
      o = vec4(v, 0.0, 1.0);
    }`,

  curl: `
    uniform sampler2D uVelocity;
    uniform vec2 uTexel;
    void main() {
      float l = texture(uVelocity, vUv - vec2(uTexel.x, 0)).y;
      float r = texture(uVelocity, vUv + vec2(uTexel.x, 0)).y;
      float b = texture(uVelocity, vUv - vec2(0, uTexel.y)).x;
      float t = texture(uVelocity, vUv + vec2(0, uTexel.y)).x;
      o = vec4(0.5 * (r - l - t + b), 0.0, 0.0, 1.0);
    }`,

  vorticity: `
    uniform sampler2D uVelocity, uCurl;
    uniform vec2 uTexel;
    uniform float uDt, uStrength;
    void main() {
      float l = texture(uCurl, vUv - vec2(uTexel.x, 0)).x;
      float r = texture(uCurl, vUv + vec2(uTexel.x, 0)).x;
      float b = texture(uCurl, vUv - vec2(0, uTexel.y)).x;
      float t = texture(uCurl, vUv + vec2(0, uTexel.y)).x;
      float c = texture(uCurl, vUv).x;
      vec2 n = vec2(abs(t) - abs(b), abs(r) - abs(l));
      n /= length(n) + 1e-5;
      vec2 v = texture(uVelocity, vUv).xy + uDt * uStrength * c * n * vec2(1, -1);
      o = vec4(v, 0.0, 1.0);
    }`,

  divergence: `
    uniform sampler2D uVelocity;
    uniform vec2 uTexel;
    void main() {
      float l = texture(uVelocity, vUv - vec2(uTexel.x, 0)).x;
      float r = texture(uVelocity, vUv + vec2(uTexel.x, 0)).x;
      float b = texture(uVelocity, vUv - vec2(0, uTexel.y)).y;
      float t = texture(uVelocity, vUv + vec2(0, uTexel.y)).y;
      o = vec4(0.5 * (r - l + t - b), 0.0, 0.0, 1.0);
    }`,

  pressure: `
    uniform sampler2D uPressure, uDivergence;
    uniform vec2 uTexel;
    void main() {
      float l = texture(uPressure, vUv - vec2(uTexel.x, 0)).x;
      float r = texture(uPressure, vUv + vec2(uTexel.x, 0)).x;
      float b = texture(uPressure, vUv - vec2(0, uTexel.y)).x;
      float t = texture(uPressure, vUv + vec2(0, uTexel.y)).x;
      o = vec4(0.25 * (l + r + b + t - texture(uDivergence, vUv).x), 0.0, 0.0, 1.0);
    }`,

  gradient: `
    uniform sampler2D uPressure, uVelocity;
    uniform vec2 uTexel;
    void main() {
      float l = texture(uPressure, vUv - vec2(uTexel.x, 0)).x;
      float r = texture(uPressure, vUv + vec2(uTexel.x, 0)).x;
      float b = texture(uPressure, vUv - vec2(0, uTexel.y)).x;
      float t = texture(uPressure, vUv + vec2(0, uTexel.y)).x;
      vec2 v = texture(uVelocity, vUv).xy - 0.5 * vec2(r - l, t - b);
      o = vec4(v, 0.0, 1.0);
    }`,

  scale: `
    uniform sampler2D uField;
    uniform float uScale;
    void main() { o = texture(uField, vUv) * uScale; }`,

  // 温度を黒体放射っぽい色にする: 暗い赤 → 橙 → 黄 → 白に近い黄
  render: `
    uniform sampler2D uTemperature;
    uniform vec2 uTexel;
    void main() {
      float t = texture(uTemperature, vUv).x;
      // 少しぼかした温度を足して、炎のまわりにほんのり光をまとわせる
      float glow = 0.0;
      for (int i = -2; i <= 2; i++) for (int j = -2; j <= 2; j++)
        glow += texture(uTemperature, vUv + vec2(i, j) * uTexel * 3.0).x;
      glow /= 25.0;

      vec3 c = vec3(0.0);
      c += vec3(0.8, 0.14, 0.02) * smoothstep(0.22, 0.6, t);
      c += vec3(0.2, 0.48, 0.08) * smoothstep(0.45, 1.0, t);
      c += vec3(0.0, 0.32, 0.4) * smoothstep(0.95, 1.9, t);
      c += vec3(0.5, 0.14, 0.02) * smoothstep(0.05, 0.8, glow) * 0.25;

      // 格子の端が見えないように周囲を暗くする
      float edge = smoothstep(0.0, 0.12, vUv.x) * smoothstep(1.0, 0.88, vUv.x)
                 * smoothstep(1.0, 0.8, vUv.y) * smoothstep(0.0, 0.08, vUv.y);
      o = vec4(c * edge, 1.0);
    }`,
};

export function createFire(canvas, { cols = 128, rows = 192 } = {}) {
  const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, premultipliedAlpha: false });
  if (!gl) throw new Error("WebGL2 が使えません");
  if (!gl.getExtension("EXT_color_buffer_float") && !gl.getExtension("EXT_color_buffer_half_float")) {
    throw new Error("浮動小数のテクスチャに描画できません");
  }

  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  const programs = {};
  for (const [name, body] of Object.entries(SHADERS)) {
    const fs = compile(gl, gl.FRAGMENT_SHADER, `#version 300 es
      precision highp float;
      in vec2 vUv;
      out vec4 o;
      ${body}`);
    programs[name] = link(gl, vs, fs);
  }

  // 画面全体を覆う三角形1枚
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const target = () => {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, cols, rows, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fb };
  };
  const pair = () => {
    let read = target(), write = target();
    return {
      get read() { return read; },
      get write() { return write; },
      swap() { [read, write] = [write, read]; },
    };
  };
  const velocity = pair(), temperature = pair(), pressure = pair();
  const curl = target(), divergence = target();
  const texel = [1 / cols, 1 / rows];

  function run(name, uniforms, out) {
    const { program, locations } = programs[name];
    gl.useProgram(program);
    let unit = 0;
    for (const [key, value] of Object.entries(uniforms)) {
      const loc = locations(key);
      if (value?.tex) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, value.tex);
        gl.uniform1i(loc, unit++);
      } else if (typeof value === "number") {
        key === "uCount" || key === "uMode" ? gl.uniform1i(loc, value) : gl.uniform1f(loc, value);
      } else if (value.vec4) {
        gl.uniform4fv(loc, value.data);
      } else {
        gl.uniform2fv(loc, value.data ?? value);
      }
    }
    if (out) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, out.fb);
      gl.viewport(0, 0, cols, rows);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    }
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  const MAX_SOURCES = 24;
  const segData = new Float32Array(MAX_SOURCES * 4);
  const paramData = new Float32Array(MAX_SOURCES * 2);

  return {
    cols,
    rows,

    // sources: [{ x1, y1, x2, y2, r, s }] をマス単位で
    step(dt, sources, time) {
      const n = Math.min(sources.length, MAX_SOURCES);
      segData.fill(0);
      paramData.fill(0);
      sources.slice(0, n).forEach((s, i) => {
        segData.set([s.x1, s.y1, s.x2, s.y2], i * 4);
        paramData.set([s.r, s.s], i * 2);
      });
      const seg = { vec4: true, data: segData }, params = { data: paramData };

      run("advectVelocity", { uVelocity: velocity.read, uTexel: texel, uDt: dt, uDamp: 0.8 }, velocity.write);
      velocity.swap();
      run("advectTemperature", { uVelocity: velocity.read, uTemperature: temperature.read, uTexel: texel, uDt: dt, uCoolA: 1.5, uCoolB: 0.5 }, temperature.write);
      temperature.swap();

      const src = { uSize: [cols, rows], uSegments: seg, uParams: params, uCount: n, uTime: time, uDt: dt };
      run("source", { uField: temperature.read, uMode: 0, ...src }, temperature.write);
      temperature.swap();
      run("source", { uField: velocity.read, uMode: 1, ...src }, velocity.write);
      velocity.swap();

      run("buoyancy", { uVelocity: velocity.read, uTemperature: temperature.read, uDt: dt, uLift: 170 }, velocity.write);
      velocity.swap();
      run("curl", { uVelocity: velocity.read, uTexel: texel }, curl);
      run("vorticity", { uVelocity: velocity.read, uCurl: curl, uTexel: texel, uDt: dt, uStrength: 18 }, velocity.write);
      velocity.swap();

      run("divergence", { uVelocity: velocity.read, uTexel: texel }, divergence);
      run("scale", { uField: pressure.read, uScale: 0.8 }, pressure.write);
      pressure.swap();
      for (let i = 0; i < 20; i++) {
        run("pressure", { uPressure: pressure.read, uDivergence: divergence, uTexel: texel }, pressure.write);
        pressure.swap();
      }
      run("gradient", { uPressure: pressure.read, uVelocity: velocity.read, uTexel: texel }, velocity.write);
      velocity.swap();
    },

    render() {
      run("render", { uTemperature: temperature.read, uTexel: texel }, null);
    },

    reset() {
      for (const t of [velocity.read, velocity.write, temperature.read, temperature.write, pressure.read, pressure.write]) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
    },
  };
}

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
  return shader;
}

function link(gl, vs, fs) {
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.bindAttribLocation(program, 0, "aPos");
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  const cache = new Map();
  const locations = name => {
    if (!cache.has(name)) cache.set(name, gl.getUniformLocation(program, name));
    return cache.get(name);
  };
  return { program, locations };
}
