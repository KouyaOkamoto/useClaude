// ライフゲームの JS 版と、Wasm 版を同じ形で使うためのラッパー。
// JS 版は rust/src/lib.rs と同じ計算を、JS がビット演算できる32ビット単位で行う。
//
// どちらも盤面は1マス1ビットの Uint32Array（1行 = cols / 32 個、ビット i が左から i 番目）として見える。
// cols は 64 の倍数にすること。

export class JsLife {
  constructor(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.words = cols / 32;
    this.cells = new Uint32Array(this.words * rows);
    this.next = new Uint32Array(this.words * rows);
  }

  step(n) {
    const { words, rows } = this;
    for (let g = 0; g < n; g++) {
      const cur = this.cells, out = this.next;
      for (let r = 0; r < rows; r++) {
        const up = (r === 0 ? rows - 1 : r - 1) * words;
        const mid = r * words;
        const down = (r + 1 === rows ? 0 : r + 1) * words;
        for (let k = 0; k < words; k++) {
          const kl = k === 0 ? words - 1 : k - 1;
          const kr = k + 1 === words ? 0 : k + 1;

          const u = cur[up + k], m = cur[mid + k], d = cur[down + k];
          const uw = (u << 1) | (cur[up + kl] >>> 31), ue = (u >>> 1) | (cur[up + kr] << 31);
          const mw = (m << 1) | (cur[mid + kl] >>> 31), me = (m >>> 1) | (cur[mid + kr] << 31);
          const dw = (d << 1) | (cur[down + kl] >>> 31), de = (d >>> 1) | (cur[down + kr] << 31);

          // 8つの隣のマスの数を、ビットごとに並列な加算器で数える
          let x = uw ^ u;
          const s1a = x ^ ue, c1a = (uw & u) | (ue & x);
          x = mw ^ me;
          const s1b = x ^ dw, c1b = (mw & me) | (dw & x);
          const s1c = d ^ de, c1c = d & de;
          x = s1a ^ s1b;
          const ones = x ^ s1c, c2 = (s1a & s1b) | (s1c & x);
          x = c1a ^ c1b;
          const t = x ^ c1c, c3 = (c1a & c1b) | (c1c & x);
          const twos = t ^ c2, c4 = t & c2;
          const fours = c3 ^ c4;

          out[mid + k] = twos & ~fours & (ones | m);
        }
      }
      this.next = cur;
      this.cells = out;
    }
  }

  free() {}
}

export async function loadWasm(url) {
  const { instance } = await WebAssembly.instantiateStreaming(fetch(url), {})
    .catch(async () => WebAssembly.instantiate(await (await fetch(url)).arrayBuffer(), {}));
  const wasm = instance.exports;

  return class WasmLife {
    constructor(cols, rows) {
      this.cols = cols;
      this.rows = rows;
      this.ptr = wasm.life_new(cols, rows);
    }

    // step で盤面が入れ替わり、メモリが増えるとビューも使えなくなるので毎回作る
    get cells() {
      return new Uint32Array(wasm.memory.buffer, wasm.life_cells(this.ptr), this.cols / 32 * this.rows);
    }

    step(n) {
      wasm.life_step(this.ptr, n);
    }

    free() {
      wasm.life_free(this.ptr);
    }
  };
}
