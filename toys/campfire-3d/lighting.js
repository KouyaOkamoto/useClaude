// 焚き火の明かりの設定と、ノイズによる揺らぎ。
// 調整用の値はすべて LIGHTING にまとめている。
import * as THREE from "three";

export const LIGHTING = {
  // 揺らぎ (2 層のノイズを合成する)。周波数は「1 秒に何回くらい山谷が来るか」
  flicker: {
    slowHz: 0.7,        // ゆっくりした揺れ (炎全体が大きくなったり小さくなったり)
    fastHz: 10,         // 速いちらつき
    slowAmp: 0.2,       // 遅い揺れの振れ幅 (明るさの割合)
    fastAmp: 0.09,      // 速いちらつきの振れ幅
    instability: 1.6,   // 火力が低いとき、振れ幅を (1 + instability) 倍まで大きくする
    dipHz: 1.3,         // 火力が低いときに時々ふっと暗くなる頻度
    dipAmp: 0.35,       // その落ち込みの深さ
    min: 0.25,          // 揺らぎで下がりすぎないための下限 (割合)
    flameCoupling: 0.6, // 炎の見た目 (高さ・明るさ) にどれだけ同じ揺らぎを乗せるか
  },
  // 炎の見た目の動き
  flame: {
    rise: 5.0,   // 炎の模様が上へ流れる速さ (以前は 3.0)
    morph: 1.4,  // 模様そのものが形を変える速さ (0 だと流れるだけ)
    sway: 0.6,   // 上の方の横揺れの大きさ
  },
  // 焚き火の点光源
  fire: {
    minIntensity: 0.25, // 火力 0 のときの明るさ (cd)
    maxIntensity: 6.5,  // 火力 1 のときの明るさ
    curve: 1.2,         // 火力 → 明るさの曲がり具合 (1 より大きいと弱火がより暗い)
    emberIntensity: 0.6, // 熾火の分の上乗せ
    colorLow: 0xff4a12,  // 弱いとき (オレンジ〜赤)
    colorHigh: 0xffb066, // 強いとき (黄色寄り)
    baseY: 0.5,         // 光源の高さ (m)
    riseY: 0.2,         // 火力 1 でこれだけ高くなる
    wobbleHz: 2.2,      // 光源の位置が揺れる速さ
    wobbleXZ: 0.03,     // 横の揺れ (m)
    wobbleY: 0.012,     // 縦の揺れ (m)
  },
  // 熾火の照り返し (影なし)
  ember: { intensity: 0.4, perEmber: 2.5, color: 0xff4a14, distance: 1.6 },
  // 月明かりと空の光。遠くが真っ暗にならず、輪郭がうっすら見える程度
  ambient: {
    moonColor: 0xa9bcff,
    moonIntensity: 0.32,
    moonPosition: [-6, 10, -4],
    hemiSky: 0x6c84c4,
    hemiGround: 0x1a1612,
    hemiIntensity: 0.3,
    envIntensity: 0.08,
  },
  // 焚き火の影 (影を落とすのはこの 1 灯だけ)
  shadow: {
    mapSize: 1024,       // PC
    mapSizeMobile: 512,  // スマホ・タブレット (タッチが主な端末)
    bias: -0.0015,
    normalBias: 0.025,
    radius: 2.5,         // PCF のぼかし (大きいほど縁がにじむ)
    near: 0.05,
    far: 12,
  },
  // 煙。照明を受けないスプライトなので、明るいと光の柱のように見える。ごく薄くする
  smoke: { color: 0x2a2724, opacity: 0.05 },
};

// --- 1 次元のグラディエントノイズ (Perlin 型)。決まった入力には決まった値を返す ---
function hash(i) {
  let h = Math.imul(i | 0, 0x27d4eb2d) ^ 0x165667b1;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296 * 2 - 1; // -1〜1 の傾き
}
const fade = t => t * t * t * (t * (t * 6 - 15) + 10);
// 出力はおおむね -1〜1。channel を変えると別の系列になる。
// 入力 1 あたり約 0.5 周期 (スペクトルの重心) なので、Hz で指定するときは hzToX で換算する
export function noise1(x, channel = 0) {
  const i = Math.floor(x), f = x - i;
  const a = hash(i + channel * 7919) * f;
  const b = hash(i + 1 + channel * 7919) * (f - 1);
  return (a + (b - a) * fade(f)) * 2;
}

const CYCLES_PER_UNIT = 0.5;
const hzToX = (t, hz) => t * hz / CYCLES_PER_UNIT;

const lowColor = new THREE.Color();
const highColor = new THREE.Color();

// 火力 (0〜1) と時刻から、明るさの倍率・色・位置の揺れを求める。
// 返す値は炎・薪・熾火・ゲージでも共有し、すべてが同じリズムで揺れるようにする
export function createFireFlicker(config = LIGHTING) {
  const f = config.flicker, fire = config.fire;
  lowColor.set(fire.colorLow);
  highColor.set(fire.colorHigh);
  const state = {
    slow: 0, fast: 0, factor: 1, brightness: 0,
    color: new THREE.Color(), offset: new THREE.Vector3(),
  };
  return {
    state,
    update(t, power) {
      const lowness = 1 - power;
      const unstable = 1 + f.instability * lowness;
      state.slow = noise1(hzToX(t, f.slowHz), 1);
      state.fast = 0.6 * noise1(hzToX(t, f.fastHz), 2) + 0.4 * noise1(hzToX(t, f.fastHz * 1.3), 3);
      const dip = lowness * f.dipAmp * Math.max(0, noise1(hzToX(t, f.dipHz), 4));
      state.factor = Math.max(f.min, 1 + unstable * (f.slowAmp * state.slow + f.fastAmp * state.fast) - dip);
      // 色温度: 揺らぎ込みの強さで、赤橙 ↔ 黄 を行き来する
      state.brightness = THREE.MathUtils.clamp(power * (0.75 + 0.25 * state.factor), 0, 1);
      state.color.lerpColors(lowColor, highColor, state.brightness);
      // 位置の揺れ (遅い揺れ + 少しのちらつき)
      const w = hzToX(t, fire.wobbleHz), wob = 1 + 0.5 * f.instability * lowness;
      state.offset.set(
        (noise1(w, 5) + 0.3 * noise1(hzToX(t, f.fastHz * 0.7), 6)) * fire.wobbleXZ * wob,
        noise1(w * 1.3, 7) * fire.wobbleY * wob,
        (noise1(w, 8) + 0.3 * noise1(hzToX(t, f.fastHz * 0.8), 9)) * fire.wobbleXZ * wob);
      return state;
    },
    // 焚き火の点光源の明るさ
    intensity(power, ember) {
      const base = fire.minIntensity + (fire.maxIntensity - fire.minIntensity) * Math.pow(power, fire.curve);
      return base * state.factor + fire.emberIntensity * ember;
    },
  };
}
