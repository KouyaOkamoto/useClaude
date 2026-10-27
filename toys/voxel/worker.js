// チャンクを作るワーカー。world.wasm で地形と頂点を作り、メインに渡す。
// 生成は重いので、画面が止まらないようにメインとは別のスレッドで動かす。

const ready = (async () => {
  const url = new URL("world.wasm", import.meta.url);
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

  if (data.type === "spawn") {
    const p = wasm.find_spawn(data.seed);
    // 上位16ビットが x、下位16ビットが z（どちらも符号付き）
    postMessage({ type: "spawn", x: p >> 16, z: (p << 16) >> 16 });
    return;
  }

  const { seed, cx, cz } = data;
  const t0 = performance.now();
  const chunk = wasm.chunk_generate(seed, cx, cz);
  const ms = performance.now() - t0;
  // Wasm のメモリから写し取ってから解放する（写した配列はメインへそのまま渡せる）
  const read = (kind, Type) =>
    new Type(wasm.memory.buffer, wasm.chunk_ptr(chunk, kind), wasm.chunk_len(chunk, kind)).slice();
  const out = {
    type: "chunk", cx, cz, ms,
    solid: { pos: read(0, Float32Array), col: read(1, Uint8Array), idx: read(2, Uint32Array) },
    water: { pos: read(3, Float32Array), col: read(4, Uint8Array), idx: read(5, Uint32Array) },
    blocks: read(6, Uint8Array),
    biomes: read(7, Uint8Array),
  };
  wasm.chunk_free(chunk);
  postMessage(out, [
    out.solid.pos.buffer, out.solid.col.buffer, out.solid.idx.buffer,
    out.water.pos.buffer, out.water.col.buffer, out.water.idx.buffer,
    out.blocks.buffer, out.biomes.buffer,
  ]);
};
