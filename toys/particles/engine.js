// 粒子シミュレーションの JS 版と、Wasm 版を同じ形で使うためのラッパー。
// JS 版は rust/src/lib.rs と同じ計算をするので、変更するときは両方そろえること。

const SOFTEN = 400;
const ATTRACT = 200000;
const BURST = 1500;
const BURST_RANGE = 150;
const BOUNCE = 0.6;
const MAX_SPEED = 1500;

export class JsWorld {
  constructor(n, w, h, seed, palette) {
    this.w = w;
    this.h = h;
    this.pos = new Float32Array(n * 2);
    this.vel = new Float32Array(n * 2);
    this.pixels = new Uint32Array(w * h).fill(0xff000000);
    this.palette = Uint32Array.from(palette);
    this.image = new ImageData(new Uint8ClampedArray(this.pixels.buffer), w, h);
    let s = seed | 1;
    const rand = () => {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      return (s >>> 0) / 4294967296;
    };
    for (let i = 0; i < n; i++) {
      this.pos[i * 2] = rand() * w;
      this.pos[i * 2 + 1] = rand() * h;
    }
  }

  step(dt, damp, fade, px, py, mode) {
    const { w, h, pos, vel, pixels, palette } = this;
    for (let i = 0; i < pixels.length; i++) {
      const c = pixels[i];
      const rb = (((c & 0x00ff00ff) * fade) >>> 8) & 0x00ff00ff;
      const g = (((c & 0x0000ff00) * fade) >>> 8) & 0x0000ff00;
      pixels[i] = 0xff000000 | rb | g;
    }

    for (let i = 0; i < pos.length; i += 2) {
      let x = pos[i], y = pos[i + 1];
      let vx = vel[i], vy = vel[i + 1];

      if (mode !== 0) {
        const dx = px - x;
        const dy = py - y;
        const d2 = dx * dx + dy * dy + SOFTEN;
        if (mode === 1) {
          const f = ATTRACT * dt / d2;
          vx += dx * f;
          vy += dy * f;
        } else {
          const d = Math.sqrt(d2);
          const f = BURST * BURST_RANGE / ((d + BURST_RANGE) * d);
          vx -= dx * f;
          vy -= dy * f;
        }
      }

      vx *= damp;
      vy *= damp;
      x += vx * dt;
      y += vy * dt;
      if (x < 0) {
        x = -x;
        vx = -vx * BOUNCE;
      } else if (x >= w) {
        x = 2 * w - x;
        vx = -vx * BOUNCE;
      }
      if (y < 0) {
        y = -y;
        vy = -vy * BOUNCE;
      } else if (y >= h) {
        y = 2 * h - y;
        vy = -vy * BOUNCE;
      }
      x = Math.min(Math.max(x, 0), w - 0.01);
      y = Math.min(Math.max(y, 0), h - 0.01);

      pos[i] = x;
      pos[i + 1] = y;
      vel[i] = vx;
      vel[i + 1] = vy;

      const speed = Math.sqrt(vx * vx + vy * vy);
      const color = palette[Math.min((speed * (255 / MAX_SPEED)) | 0, 255)];
      const k = (y | 0) * w + (x | 0);
      const p = pixels[k];
      const r = Math.min((p & 0xff) + (color & 0xff), 0xff);
      const gg = Math.min(((p >>> 8) & 0xff) + ((color >>> 8) & 0xff), 0xff);
      const b = Math.min(((p >>> 16) & 0xff) + ((color >>> 16) & 0xff), 0xff);
      pixels[k] = 0xff000000 | (b << 16) | (gg << 8) | r;
    }
  }

  free() {}
}

export async function loadWasm(url) {
  const res = fetch(url);
  const { instance } = await WebAssembly.instantiateStreaming(res, {})
    .catch(async () => WebAssembly.instantiate(await (await fetch(url)).arrayBuffer(), {}));
  const wasm = instance.exports;

  return class WasmWorld {
    constructor(n, w, h, seed, palette) {
      this.w = w;
      this.h = h;
      this.ptr = wasm.world_new(n, w, h, seed);
      // world_new でメモリが増えると古いビューは使えなくなるので、作った後にビューを取る
      new Uint32Array(wasm.memory.buffer, wasm.world_palette(this.ptr), 256).set(palette);
      this.pixelsPtr = wasm.world_pixels(this.ptr);
      this.buffer = null;
    }

    get image() {
      if (this.buffer !== wasm.memory.buffer) {
        this.buffer = wasm.memory.buffer;
        const bytes = new Uint8ClampedArray(this.buffer, this.pixelsPtr, this.w * this.h * 4);
        this._image = new ImageData(bytes, this.w, this.h);
      }
      return this._image;
    }

    step(dt, damp, fade, px, py, mode) {
      wasm.world_step(this.ptr, dt, damp, fade, px, py, mode);
    }

    free() {
      wasm.world_free(this.ptr);
    }
  };
}
