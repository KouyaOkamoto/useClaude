// 推論の担当（Web Worker）。モデルの読み込み・生成は重いので、画面のスレッドとは別で動かす（画面が固まらない）。
//
// 画面（main.js）とのやりとり:
//   画面 → worker: { type: 'probe' }                                   使える実行環境（WebGPU・fp16）を調べる
//                  { type: 'load', model, device, dtype }              モデルを読み込む（失敗したら error。画面が別の組み合わせで読み直す）
//                  { type: 'generate', messages, params, maxContext }  返答を生成する（トークンごとに 'token' を返す）
//                  { type: 'interrupt' }                               生成を止める
//   worker → 画面: probe・progress・status・ready・token・done・error（下の post(...) を参照）
import {
  AutoTokenizer,
  AutoModelForCausalLM,
  InterruptableStoppingCriteria,
  ones,
  env,
} from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2';

// モデルは Hugging Face から読む（このサイトの /models/ を探しに行かない）
env.allowLocalModels = false;

const post = (msg) => self.postMessage(msg);
const stopper = new InterruptableStoppingCriteria();
let tokenizer = null;
let model = null;
let current = null; // { device, dtype }

/** 使える実行環境を調べる。WebGPU のアダプタが取れなければ wasm */
async function probe() {
  const info = { webgpu: false, fp16: false, adapter: '' };
  try {
    if ('gpu' in navigator) {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        info.webgpu = true;
        info.fp16 = adapter.features.has('shader-f16');
        const a = adapter.info ?? {};
        info.adapter = [a.vendor, a.architecture, a.device, a.description].filter(Boolean).join(' ');
      }
    }
  } catch (e) {
    info.error = String(e?.message ?? e);
  }
  return info;
}

function progressCallback(x) {
  // 'initiate'・'download'・'progress'・'done'・'ready' など。ファイルごとの進み具合を画面に渡す
  if (x.status === 'progress' || x.status === 'initiate' || x.status === 'done') {
    post({ type: 'progress', status: x.status, file: x.file, loaded: x.loaded ?? 0, total: x.total ?? 0 });
  }
}

async function loadOn(modelId, device, dtype) {
  post({ type: 'status', text: `トークナイザを読み込んでいます…` });
  tokenizer ??= await AutoTokenizer.from_pretrained(modelId, { progress_callback: progressCallback });
  post({ type: 'status', text: `モデルを読み込んでいます（${device}・${dtype}）…` });
  const m = await AutoModelForCausalLM.from_pretrained(modelId, { device, dtype, progress_callback: progressCallback });
  // 初回の準備（WebGPU のシェーダのコンパイルなど）と、動作の確認を兼ねて、チャットと同じ使い方で少し生成する:
  // 会話の入力をまとめて読む → KV キャッシュで数トークン → そのキャッシュから続ける（generate() の区切りと同じ）。
  // 量子化の版によっては、KV キャッシュを使う2つめのトークンから失敗するものがある
  // （TinySwallow の q4f16 を CPU で動かすと失敗する。ONNX Runtime の Python 版でも同じ）。ここで失敗させて、別の版で読み直す
  post({ type: 'status', text: '初回の準備（ウォームアップ）をしています…' });
  const inputs = tokenizer.apply_chat_template([{ role: 'user', content: 'こんにちは。調子はどうですか？' }], { add_generation_prompt: true, return_dict: true });
  const a = await m.generate({ ...inputs, max_new_tokens: 2, do_sample: false, return_dict_in_generate: true });
  const b = await m.generate({ input_ids: a.sequences, attention_mask: ones(a.sequences.dims), past_key_values: a.past_key_values, max_new_tokens: 2, do_sample: false, return_dict_in_generate: true });
  try { await b.past_key_values?.dispose?.(); } catch { /* 片づけの失敗は無視 */ }
  return m;
}

async function load({ model: modelId, device, dtype }) {
  // 読み込み・ウォームアップに失敗したとき（アダプタが無い・メモリ不足・対応していない演算・量子化の版の不具合など）は、エラーを返す。
  // 画面がこの worker を捨てて、新しい worker で別の組み合わせ（q4、WebAssembly）で読み直す
  // （ONNX Runtime は、一度失敗した初期化を覚えていて、同じ worker では別の組み合わせでも失敗するため）
  const t0 = performance.now();
  model = await loadOn(modelId, device, dtype);
  current = { device, dtype };
  post({ type: 'ready', ...current, ms: performance.now() - t0 });
}

/** 文脈の長さに収まるよう、古いやりとりから捨てる（system は残す） */
function encode(messages, maxContext) {
  let msgs = messages.slice();
  let dropped = 0;
  for (;;) {
    const inputs = tokenizer.apply_chat_template(msgs, { add_generation_prompt: true, return_dict: true });
    const len = inputs.input_ids.dims.at(-1);
    const rest = msgs.filter((m) => m.role !== 'system');
    if (len <= maxContext || rest.length <= 1) return { inputs, len, dropped };
    // いちばん古い system 以外のメッセージを捨てる
    const i = msgs.findIndex((m) => m.role !== 'system');
    msgs.splice(i, 1);
    dropped++;
  }
}

// 生成は、少しずつ（CHUNK トークンずつ）区切って行い、区切りごとに worker のイベントループに戻る。
// model.generate は、WebAssembly では最後まで一度もイベントループに戻らないことがあり、そのままでは
// 「停止」（interrupt のメッセージ）を受け取れないため。続きは、前の区切りの KV キャッシュ（past_key_values）から生成する。
const CHUNK = 8;
const nextTask = () => new Promise((r) => setTimeout(r, 0));

/**
 * 生成したトークンを、文字に直して少しずつ画面に送る。
 * UTF-8 の途中で切れた文字（デコードすると U+FFFD になる）は、続きのトークンが来るまで送らない
 * （日本語は 1文字が複数のトークンにまたがることがある）
 */
class ChunkStreamer {
  constructor(onText, onTokens) {
    this.onText = onText;
    this.onTokens = onTokens;
    this.pending = [];
    this.skipPrompt = true;
  }
  put(value) {
    // generate を呼ぶたびに、最初に入力全体（プロンプト）が来るので読み飛ばす
    if (this.skipPrompt) { this.skipPrompt = false; return; }
    const ids = value[0];
    this.onTokens(ids.length);
    this.pending.push(...ids);
    this.flush(false);
  }
  end() {}
  flush(final) {
    if (!this.pending.length) return;
    const text = tokenizer.decode(this.pending, { skip_special_tokens: true });
    if (!final && text.endsWith('\uFFFD') && this.pending.length < 16) return;
    if (text) this.onText(text);
    this.pending = [];
  }
}

async function generate({ messages, params, maxContext }) {
  stopper.reset();
  const { inputs, len, dropped } = encode(messages, maxContext);
  const t0 = performance.now();
  let first = 0;
  let tokens = 0;
  const streamer = new ChunkStreamer(
    (text) => post({ type: 'token', text }),
    (n) => { if (!first) first = performance.now(); tokens += n; },
  );
  let ids = inputs.input_ids;
  let past = null;
  try {
    while (tokens < params.max_new_tokens && !stopper.interrupted) {
      const want = Math.min(CHUNK, params.max_new_tokens - tokens);
      const before = ids.dims.at(-1);
      streamer.skipPrompt = true;
      const out = await model.generate({
        input_ids: ids,
        attention_mask: ones(ids.dims),
        ...(past ? { past_key_values: past } : {}),
        max_new_tokens: want,
        do_sample: params.temperature > 0,
        temperature: params.temperature,
        top_p: params.top_p,
        repetition_penalty: params.repetition_penalty,
        streamer,
        stopping_criteria: stopper,
        return_dict_in_generate: true,
      });
      ids = out.sequences;
      past = out.past_key_values;
      // 求めた数より少なければ、終わりの印（EOS）か停止で終わった
      if (ids.dims.at(-1) - before < want) break;
      // 区切りごとにイベントループに戻る（ここで「停止」を受け取れる）
      await nextTask();
    }
  } finally {
    streamer.flush(true);
    try { await past?.dispose?.(); } catch { /* 片づけの失敗は無視 */ }
  }
  const end = performance.now();
  post({
    type: 'done',
    interrupted: stopper.interrupted,
    promptTokens: len,
    dropped,
    tokens,
    firstTokenMs: first ? first - t0 : null,
    // 最初のトークンが出てからの速さ（入力の処理の時間を含めない）
    tokensPerSec: tokens > 1 && first ? ((tokens - 1) * 1000) / (end - first) : null,
  });
}

self.addEventListener('message', async (e) => {
  const msg = e.data ?? {};
  try {
    if (msg.type === 'probe') post({ type: 'probe', ...(await probe()) });
    else if (msg.type === 'load') await load(msg);
    else if (msg.type === 'generate') await generate(msg);
    else if (msg.type === 'interrupt') stopper.interrupt();
  } catch (err) {
    post({ type: 'error', during: msg.type, message: String(err?.message ?? err) });
  }
});
