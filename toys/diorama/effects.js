// 仕上げの効果: 朝霧（光の筋つき）と、周辺の減光・粒子感。
import * as THREE from "three";
import { Pass, FullScreenQuad } from "three/addons/postprocessing/Pass.js";

// 箱庭の中だけに漂う霧。水面近くほど濃く、ゆっくり流れる。
// 視線に沿って少しずつ進みながら、各点で太陽の光が届くか（影の地図）を調べるので、
// 木の間から差し込む光の筋が霧に映る。
export class MistPass extends Pass {
  constructor({ steps, boxMin, boxMax }) {
    super();
    this.uniforms = {
      tColor: { value: null },
      tDepth: { value: null },
      tShadow: { value: null },
      uShadowMatrix: { value: new THREE.Matrix4() },
      uInvProj: { value: new THREE.Matrix4() },
      uCamWorld: { value: new THREE.Matrix4() },
      uCamPos: { value: new THREE.Vector3() },
      uBoxMin: { value: boxMin },
      uBoxMax: { value: boxMax },
      uSunDir: { value: new THREE.Vector3() },
      uSunColor: { value: new THREE.Color() },
      uAmbient: { value: new THREE.Color() },
      uDensity: { value: 0.3 },
      uFalloff: { value: 1.6 },
      uTime: { value: 0 },
      uShadowOn: { value: 1 },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      defines: { STEPS: steps },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        #include <packing>
        uniform sampler2D tColor, tDepth, tShadow;
        uniform mat4 uShadowMatrix, uInvProj, uCamWorld;
        uniform vec3 uCamPos, uBoxMin, uBoxMax, uSunDir, uSunColor, uAmbient;
        uniform float uDensity, uFalloff, uTime, uShadowOn;
        varying vec2 vUv;

        float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
        float hash3(vec3 p) { return hash(p.xy + p.z * 17.31); }
        float noise(vec3 p) {
          vec3 i = floor(p), f = fract(p);
          vec3 u = f * f * (3.0 - 2.0 * f);
          float a = mix(mix(hash3(i), hash3(i + vec3(1, 0, 0)), u.x), mix(hash3(i + vec3(0, 1, 0)), hash3(i + vec3(1, 1, 0)), u.x), u.y);
          float b = mix(mix(hash3(i + vec3(0, 0, 1)), hash3(i + vec3(1, 0, 1)), u.x), mix(hash3(i + vec3(0, 1, 1)), hash3(i + vec3(1, 1, 1)), u.x), u.y);
          return mix(a, b, u.z);
        }
        // 前方への散乱が強い（太陽の方を見ると霧が明るく光る）
        float phase(float mu, float g) { return (1.0 - g * g) / (12.566 * pow(1.0 + g * g - 2.0 * g * mu, 1.5)); }
        float sunlit(vec3 p) {
          if (uShadowOn < 0.5) return 1.0;
          vec4 sc = uShadowMatrix * vec4(p, 1.0);
          sc.xyz /= sc.w;
          if (sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0 || sc.z > 1.0) return 1.0;
          return step(sc.z - 0.003, unpackRGBAToDepth(texture2D(tShadow, sc.xy)));
        }

        void main() {
          vec4 col = texture2D(tColor, vUv);
          float d = texture2D(tDepth, vUv).x;
          vec4 v = uInvProj * vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
          vec3 world = (uCamWorld * vec4(v.xyz / v.w, 1.0)).xyz;
          vec3 rd = world - uCamPos;
          float tSurf = length(rd);
          rd /= tSurf;
          if (d >= 1.0) tSurf = 1e5;
          vec3 inv = 1.0 / rd;
          vec3 t0 = (uBoxMin - uCamPos) * inv, t1 = (uBoxMax - uCamPos) * inv;
          vec3 tmn = min(t0, t1), tmx = max(t0, t1);
          float tn = max(max(max(tmn.x, tmn.y), tmn.z), 0.0);
          float tf = min(min(min(tmx.x, tmx.y), tmx.z), tSurf);
          if (tf <= tn || uDensity <= 0.0) { gl_FragColor = col; return; }

          float len = (tf - tn) / float(STEPS);
          float jitter = hash(gl_FragCoord.xy + fract(uTime) * 61.7);
          float mu = dot(rd, uSunDir);
          float ph = phase(mu, 0.65) * 0.8 + phase(mu, -0.15) * 0.2;
          vec3 trans = vec3(1.0), scat = vec3(0.0);
          vec3 wind = vec3(uTime * 0.18, 0.0, uTime * 0.07);
          for (int i = 0; i < STEPS; i++) {
            vec3 p = uCamPos + rd * (tn + (float(i) + jitter) * len);
            float h = max(p.y - uBoxMin.y, 0.0);
            float n = noise(p * 0.16 + wind) * 0.65 + noise(p * 0.45 + wind * 1.7) * 0.35;
            // 側面に近づくほど薄くして、箱の境目が線にならないようにする
            vec3 edge = min(p - uBoxMin, uBoxMax - p);
            float soft = smoothstep(0.0, 3.0, min(edge.x, edge.z));
            float dens = uDensity * (exp(-h / uFalloff) * smoothstep(0.25, 0.75, n + 0.15) + 0.015 * smoothstep(9.0, 3.0, h)) * soft;
            vec3 light = uSunColor * sunlit(p) * ph * 4.0 + uAmbient;
            float ext = exp(-dens * len);
            scat += trans * light * (1.0 - ext);
            trans *= ext;
          }
          gl_FragColor = vec4(col.rgb * trans + scat, col.a);
        }
      `,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  render(renderer, writeBuffer) {
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  dispose() {
    this.material.dispose();
    this.quad.dispose();
  }
}

// 周辺をわずかに暗くし、細かな粒子感を足す（写真らしさ）
export const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uGrain: { value: 0.035 }, uVignette: { value: 0.35 } },
  vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime, uGrain, uVignette;
    varying vec2 vUv;
    float hash(vec2 p) { p = fract(p * vec2(443.897, 441.423)); p += dot(p, p.yx + 19.19); return fract((p.x + p.y) * p.x); }
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec2 q = vUv - 0.5;
      c.rgb *= 1.0 - uVignette * smoothstep(0.25, 0.85, length(q * vec2(1.1, 1.0)));
      c.rgb += (hash(vUv * 1000.0 + fract(uTime) * 100.0) - 0.5) * uGrain;
      gl_FragColor = c;
    }
  `,
};
