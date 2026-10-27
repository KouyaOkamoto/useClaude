// 地形を作るワーカー。浸食の計算は1秒ほどかかるので、画面とは別のスレッドで動かす。

const ready = (async () => {
  const url = new URL("terrain.wasm", import.meta.url);
  const { instance } = await WebAssembly.instantiateStreaming(fetch(url), {})
    .catch(async () => WebAssembly.instantiate(await (await fetch(url)).arrayBuffer(), {}));
  return instance.exports;
})();

onmessage = async ({ data }) => {
  let wasm;
  try {
    wasm = await ready;
  } catch (err) {
    postMessage({ type: "error", message: String(err) });
    return;
  }
  const { id, seed, n, world, terrain: t } = data;
  const t0 = performance.now();
  const ptr = wasm.terrain_generate(seed, n, world, t.amp, t.rough, t.ridge, t.warp, t.terrace, t.erosion);
  const ms = performance.now() - t0;
  const heights = new Float32Array(wasm.memory.buffer, wasm.terrain_ptr(ptr, 0), wasm.terrain_len(ptr, 0)).slice();
  const map = new Uint8Array(wasm.memory.buffer, wasm.terrain_ptr(ptr, 1), wasm.terrain_len(ptr, 1)).slice();
  wasm.terrain_free(ptr);
  postMessage({ type: "terrain", id, ms, heights, map }, [heights.buffer, map.buffer]);
};
