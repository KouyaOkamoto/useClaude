// モデルの一覧と、読み込みで試す組み合わせの順番（チャット main.js とディスカッション discussion.js で共通）。

// 選べるモデル（大きい順）。PC は TinySwallow、スマホ・タブレットは Qwen2.5 0.5B を既定にする
// （TinySwallow 1.5B は約 1.2 GB あり、iPhone などではメモリに収まらず、読み込みの途中でページが止められる）。
// mb: 量子化の版ごとのダウンロードの大きさ（MB。モデルのリポジトリの値）
// webgpuOnly: WebGPU でしか動かない（LFM2 の ONNX は、どの量子化の版も、WebAssembly の ONNX Runtime に無い演算 GatherBlockQuantized を使う）
export const MODELS = [
  { id: 'onnx-community/TinySwallow-1.5B-Instruct-ONNX', name: 'TinySwallow 1.5B', note: '日本語に特化・PC 向け', mb: { q4f16: 1165, q4: 1705 } },
  { id: 'onnx-community/Qwen2.5-0.5B-Instruct', name: 'Qwen2.5 0.5B', note: '多言語・スマホ向け', mb: { q4f16: 461, q4: 750 } },
  { id: 'onnx-community/LFM2-350M-ONNX', name: 'LFM2 350M', note: '軽い・答えの質は低め・WebGPU が必要', mb: { q4f16: 243, q4: 280 }, webgpuOnly: true },
  // スマホで動くかを確かめるための、いちばん小さいモデル（英語向け。日本語の答えはほとんど期待できない）
  { id: 'onnx-community/SmolLM2-135M-Instruct-ONNX', name: 'SmolLM2 135M', note: 'いちばん軽い・英語向け（スマホで動くかの確認用）', mb: { q4f16: 112, q4: 172 } },
];

export const DTYPES = ['q4f16', 'q4', 'q8', 'fp16', 'fp32'];

/** Hugging Face のリポジトリ名の形（owner/name）か */
export const isModelId = (s) => /^[\w.-]+\/[\w.-]+$/.test(s ?? '');

export const presetOf = (id) => MODELS.find((m) => m.id === id) ?? null;

/**
 * 読み込みで試す組み合わせの順番（最初のもので失敗したら、次のものへ）:
 *   WebGPU（fp16 対応）・q4f16 → WebGPU・q4 → WebAssembly・q4
 * WebAssembly では q4f16 を使わない（TinySwallow の q4f16 は、CPU では KV キャッシュを使う2つめのトークンから失敗する）。
 * WebGPU でしか動かないモデルは、WebAssembly を試さない
 * @param {{ webgpu: boolean, fp16: boolean }} probe  worker の probe の結果
 * @param {{ webgpuOnly?: boolean } | null} preset
 * @param {{ device?: string|null, dtype?: string|null }} force  URL などでの指定
 */
export function planFor(probe, preset, force = {}) {
  let device = probe.webgpu ? 'webgpu' : 'wasm';
  if (force.device) device = force.device;
  const dtype = force.dtype ?? (device === 'webgpu' && probe.fp16 ? 'q4f16' : 'q4');
  const list = [{ device, dtype }];
  if (dtype !== 'q4') list.push({ device, dtype: 'q4' });
  if (device === 'webgpu' && !preset?.webgpuOnly) list.push({ device: 'wasm', dtype: 'q4' });
  return list;
}
