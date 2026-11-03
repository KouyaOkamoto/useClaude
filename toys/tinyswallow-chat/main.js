// 画面の担当（チャットの表示・入力・設定）。推論は worker.js（Web Worker）が行う。
//
// 実行環境の選び方:
//   WebGPU が使え、fp16（shader-f16）にも対応 → WebGPU・q4f16（4bit の重み・fp16 の計算）
//   WebGPU が使えるが fp16 に対応していない   → WebGPU・q4（4bit の重み・fp32 の計算）
//   WebGPU が無い                               → wasm（WebAssembly・CPU）・q4
// 読み込み（ウォームアップの生成を含む）に失敗したら、worker を作り直して次の組み合わせで読み直す:
//   WebGPU・q4f16 → WebGPU・q4 → wasm・q4
// wasm では q4f16 を使わない（TinySwallow の q4f16 は、CPU では KV キャッシュを使う2つめのトークンから失敗する）
// URL で変えられる: ?device=wasm|webgpu、?dtype=q4f16|q4|q8|fp16|fp32、?model=<Hugging Face のリポジトリ>
//
// 表示は textContent だけ（モデルの出力も、HTML として解釈しない）。

const DEFAULT_MODEL = 'onnx-community/TinySwallow-1.5B-Instruct-ONNX';
const DEFAULT_SYSTEM = 'あなたは誠実で優秀な日本人のアシスタントです。';
const DEFAULTS = { max_new_tokens: 512, temperature: 0.7, top_p: 0.8, repetition_penalty: 1.05 };
// 文脈の上限（トークン）。モデル自体はもっと長く扱えるが、ブラウザのメモリと速さのため控えめにする
const CONTEXT_LIMIT = 4096;
const DTYPES = ['q4f16', 'q4', 'q8', 'fp16', 'fp32'];
const STORE_KEY = 'tinyswallow-chat-settings';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const mb = (n) => (n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0) + ' MB';

const params = new URLSearchParams(location.search);
const MODEL = /^[\w.-]+\/[\w.-]+$/.test(params.get('model') ?? '') ? params.get('model') : DEFAULT_MODEL;
const FORCE_DEVICE = ['wasm', 'webgpu'].includes(params.get('device')) ? params.get('device') : null;
const FORCE_DTYPE = DTYPES.includes(params.get('dtype')) ? params.get('dtype') : null;

// 推論の worker。WebGPU で読み込めなかったときは捨てて、新しい worker で wasm で読み直す
let worker = null;
let attempt = 0; // plan の何番目の組み合わせで読み込んでいるか
function startWorker() {
  const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  w.addEventListener('message', onWorkerMessage);
  w.addEventListener('error', (e) => {
    setStatus('推論の準備に失敗しました（ライブラリを読み込めない可能性があります）: ' + (e.message || 'ネットワークを確認してください'), 'err');
  });
  return w;
}
const state = {
  phase: 'probing', // probing → idle（読み込み前）→ loading → ready ⇄ generating
  device: null,
  dtype: null,
  history: [], // { role: 'user' | 'assistant', content }
  bubble: null, // 生成中の返答の要素
  files: new Map(), // ファイル名 → { loaded, total }
};

// ---------------------------------------------------------------- 設定

function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') ?? {}; } catch { saved = {}; }
  return { system: typeof saved.system === 'string' ? saved.system : DEFAULT_SYSTEM, ...DEFAULTS, ...pickNumbers(saved) };
}
function pickNumbers(o) {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) if (typeof o?.[k] === 'number' && Number.isFinite(o[k])) out[k] = o[k];
  return out;
}
function saveSettings(s) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch { /* 保存できなくても動く */ }
}
let settings = loadSettings();

const sliders = [
  ['max', 'max-out', 'max_new_tokens', (v) => String(v)],
  ['temp', 'temp-out', 'temperature', (v) => v.toFixed(2)],
  ['topp', 'topp-out', 'top_p', (v) => v.toFixed(2)],
  ['rep', 'rep-out', 'repetition_penalty', (v) => v.toFixed(2)],
];
function showSettings() {
  $('system').value = settings.system;
  for (const [input, out, key, fmt] of sliders) {
    $(input).value = String(settings[key]);
    $(out).textContent = fmt(settings[key]);
  }
}
for (const [input, out, key, fmt] of sliders) {
  $(input).addEventListener('input', () => {
    settings[key] = Number($(input).value);
    $(out).textContent = fmt(settings[key]);
    saveSettings(settings);
  });
}
$('system').addEventListener('input', () => { settings.system = $('system').value; saveSettings(settings); });
$('defaults').addEventListener('click', () => { settings = { system: DEFAULT_SYSTEM, ...DEFAULTS }; saveSettings(settings); showSettings(); });
showSettings();

// ---------------------------------------------------------------- 実行環境・モデルの読み込み

$('model-id').textContent = MODEL;
$('model-link').href = `https://huggingface.co/${MODEL}`;

function setStatus(text, cls = '') {
  $('setup-status').textContent = text;
  $('setup-status').className = 'status ' + cls;
}

/** 試す組み合わせの順番（最初のもので失敗したら、次のものへ） */
function choose(probe) {
  let device = probe.webgpu ? 'webgpu' : 'wasm';
  if (FORCE_DEVICE) device = FORCE_DEVICE;
  const dtype = FORCE_DTYPE ?? (device === 'webgpu' && probe.fp16 ? 'q4f16' : 'q4');
  const list = [{ device, dtype }];
  if (dtype !== 'q4') list.push({ device, dtype: 'q4' });
  if (device === 'webgpu') list.push({ device: 'wasm', dtype: 'q4' });
  return list;
}

function showBackend(device, dtype, note = '') {
  $('backend').textContent = device === 'webgpu' ? `WebGPU・${dtype}` : `WebAssembly（CPU）・${dtype}`;
  $('backend').className = 'badge ' + device;
  $('env-device').textContent = (device === 'webgpu' ? 'WebGPU（GPU で計算）' : 'WebAssembly（CPU で計算。WebGPU より遅い）') + note;
  $('env-dtype').textContent = `${dtype}（${{ q4f16: '重み 4bit・計算 fp16', q4: '重み 4bit・計算 fp32', q8: '重み 8bit', fp16: 'fp16', fp32: 'fp32' }[dtype] ?? dtype}）`;
}

/** 保存済み（Cache API の transformers-cache）にこのモデルのファイルがあるか */
async function cachedBytes() {
  try {
    if (!('caches' in self)) return null;
    const cache = await caches.open('transformers-cache');
    const keys = await cache.keys();
    const mine = keys.filter((r) => r.url.includes(`/${MODEL}/`));
    return mine.length;
  } catch {
    return null;
  }
}
async function showCache() {
  const n = await cachedBytes();
  let usage = '';
  try {
    const est = await navigator.storage?.estimate?.();
    if (est?.usage) usage = `（このサイトの保存量 ${mb(est.usage)}）`;
  } catch { /* 取れなくてもよい */ }
  if (n === null) $('env-cache').textContent = 'ブラウザに保存できません（毎回ダウンロード）';
  else if (n > 0) $('env-cache').textContent = `保存済みのファイルあり（${n} 個）${usage}。2回目以降はダウンロードしない`;
  else $('env-cache').textContent = '初回（ダウンロードが必要）';
  $('clear-cache').hidden = !(n > 0) || state.phase === 'loading';
}
$('clear-cache').addEventListener('click', async () => {
  if (!confirm('ブラウザに保存したモデルのファイルを削除します。次に読み込むときは、もう一度ダウンロードします。')) return;
  try { await caches.delete('transformers-cache'); } catch (e) { setStatus('削除できませんでした: ' + e.message, 'err'); }
  showCache();
});

let plan = null;
$('load').addEventListener('click', () => {
  if (!plan || state.phase !== 'idle') return;
  state.phase = 'loading';
  $('load').disabled = true;
  $('clear-cache').hidden = true;
  $('progress-box').hidden = false;
  state.files.clear();
  attempt = 0;
  worker.postMessage({ type: 'load', model: MODEL, ...plan[0] });
});

function showProgress() {
  let loaded = 0, total = 0;
  const list = [];
  for (const [file, f] of state.files) {
    loaded += f.loaded;
    total += f.total;
    const li = el('li');
    li.append(el('span', '', file), el('span', '', f.total ? `${Math.floor((f.loaded / f.total) * 100)}%・${mb(f.total)}` : mb(f.loaded)));
    list.push(li);
  }
  $('progress').value = total ? loaded / total : 0;
  $('progress-text').textContent = total ? `${mb(loaded)} / ${mb(total)}（${((loaded / total) * 100).toFixed(1)}%）` : '準備しています…';
  $('progress-files').replaceChildren(...list);
}

// ---------------------------------------------------------------- チャット

function setChatEnabled(on) {
  $('input').disabled = !on;
  $('send').disabled = !on;
  document.querySelectorAll('.sample').forEach((b) => (b.disabled = !on));
}

function scrollToEnd(force = false) {
  const box = $('messages');
  const near = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  if (force || near) box.scrollTop = box.scrollHeight;
}

function addMessage(role, text) {
  $('empty').hidden = true;
  const div = el('div', `msg ${role}`);
  div.append(el('span', 'text', text));
  $('messages').append(div);
  scrollToEnd(true);
  return div;
}

function addNotice(text) {
  const div = el('div', 'msg notice', text);
  $('messages').append(div);
  scrollToEnd(true);
}

function send(text) {
  const content = text.trim();
  if (!content || state.phase !== 'ready') return;
  state.phase = 'generating';
  state.history.push({ role: 'user', content });
  addMessage('user', content);
  state.bubble = addMessage('assistant', '');
  state.bubble.classList.add('streaming');
  state.bubble.dataset.raw = '';
  $('input').value = '';
  setChatEnabled(false);
  $('send').hidden = true;
  $('stop').hidden = false;
  $('stop').disabled = false;
  // 最初の語が出るまで（入力を読む間）、経過時間を出す（WebAssembly では数十秒かかることがある）
  const t0 = performance.now();
  state.firstToken = false;
  clearInterval(state.waitTimer);
  const tick = () => {
    const sec = Math.floor((performance.now() - t0) / 1000);
    $('stats').textContent = state.firstToken ? `生成中… ${sec} 秒` : `入力を読んでいます… ${sec} 秒`;
  };
  tick();
  state.waitTimer = setInterval(tick, 1000);
  const messages = [...(settings.system.trim() ? [{ role: 'system', content: settings.system.trim() }] : []), ...state.history];
  worker.postMessage({
    type: 'generate',
    messages,
    params: pickNumbers(settings),
    maxContext: Math.max(256, CONTEXT_LIMIT - settings.max_new_tokens),
  });
}

$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  send($('input').value);
});
$('input').addEventListener('keydown', (e) => {
  // 日本語入力の変換を確定する Enter では送らない（isComposing）
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    send($('input').value);
  }
});
document.querySelectorAll('.sample').forEach((b) => b.addEventListener('click', () => send(b.textContent)));
$('stop').addEventListener('click', () => {
  $('stop').disabled = true;
  worker.postMessage({ type: 'interrupt' });
});
$('reset').addEventListener('click', () => {
  if (state.phase === 'generating') return;
  state.history = [];
  $('messages').replaceChildren($('empty'));
  $('empty').hidden = false;
  $('stats').textContent = '';
});

function finish(msg) {
  clearInterval(state.waitTimer);
  const b = state.bubble;
  state.bubble = null;
  if (b) {
    b.classList.remove('streaming');
    const text = b.dataset.raw ?? '';
    state.history.push({ role: 'assistant', content: text });
    const parts = [];
    if (msg.interrupted) parts.push('途中で停止');
    if (msg.tokens) parts.push(`${msg.tokens} トークン`);
    if (msg.tokensPerSec) parts.push(`${msg.tokensPerSec.toFixed(1)} トークン/秒`);
    if (msg.firstTokenMs) parts.push(`最初の語まで ${(msg.firstTokenMs / 1000).toFixed(2)} 秒`);
    b.append(el('span', 'meta', parts.join('・')));
    if (!text) b.querySelector('.text').textContent = '（返答なし）';
  }
  if (msg.dropped) addNotice(`文脈が長くなったので、古いやりとり ${msg.dropped} 件を除いて答えました。`);
  $('stats').textContent = `入力 ${msg.promptTokens ?? '?'} トークン・${state.device}・${state.dtype}`;
  state.phase = 'ready';
  $('stop').hidden = true;
  $('send').hidden = false;
  setChatEnabled(true);
  $('input').focus();
}

// ---------------------------------------------------------------- worker からの知らせ

function onWorkerMessage(e) {
  const msg = e.data;
  switch (msg.type) {
    case 'probe': {
      plan = choose(msg);
      showBackend(plan[0].device, plan[0].dtype, msg.webgpu ? '' : '。このブラウザでは WebGPU が使えないため');
      state.phase = 'idle';
      $('load').disabled = false;
      showCache();
      break;
    }
    case 'progress': {
      if (msg.file) {
        const f = state.files.get(msg.file) ?? { loaded: 0, total: 0 };
        if (msg.status === 'progress') Object.assign(f, { loaded: msg.loaded, total: msg.total });
        if (msg.status === 'done' && f.total) f.loaded = f.total;
        state.files.set(msg.file, f);
        showProgress();
      }
      break;
    }
    case 'status':
      setStatus(msg.text);
      break;
    case 'ready':
      state.phase = 'ready';
      state.device = msg.device;
      state.dtype = msg.dtype;
      showBackend(msg.device, msg.dtype, attempt ? `。${plan[0].device}・${plan[0].dtype} で動かなかったため` : '');
      setStatus(`準備ができました（${(msg.ms / 1000).toFixed(1)} 秒）。${attempt ? `${plan[0].device}・${plan[0].dtype} では動かなかったので、${msg.device}・${msg.dtype} で動いています。` : ''}`, attempt ? 'warn' : '');
      $('progress-box').hidden = true;
      $('setup').classList.add('loaded');
      $('load').hidden = true;
      // 保存（Cache API への書き込み）は読み込みの終わりと前後することがあるので、少しあとにも見直す
      showCache();
      setTimeout(showCache, 1500);
      setChatEnabled(true);
      $('input').focus();
      break;
    case 'token':
      state.firstToken = true;
      if (state.bubble) {
        state.bubble.dataset.raw += msg.text;
        state.bubble.querySelector('.text').textContent = state.bubble.dataset.raw;
        scrollToEnd();
      }
      break;
    case 'done':
      finish(msg);
      break;
    case 'error':
      if (msg.during === 'load' && attempt + 1 < plan.length) {
        // 読み込めなかった → worker を作り直して、次の組み合わせで読み直す（保存済みのファイルはそのまま使う）
        const prev = plan[attempt];
        const next = plan[++attempt];
        console.warn(`${prev.device}・${prev.dtype} で読み込めなかった:`, msg.message);
        worker.terminate();
        worker = startWorker();
        showBackend(next.device, next.dtype, `。${prev.device}・${prev.dtype} で動かなかったため`);
        setStatus(`${prev.device}・${prev.dtype} では動かなかったので、${next.device}・${next.dtype} で読み込み直しています（${msg.message.slice(0, 200)}）`, 'warn');
        state.files.clear();
        worker.postMessage({ type: 'load', model: MODEL, ...next });
      } else if (msg.during === 'load') {
        state.phase = 'idle';
        $('load').disabled = false;
        setStatus(`読み込めませんでした: ${msg.message}（URL に ?dtype=q4 や ?device=wasm を付けると、別の組み合わせを試せます）`, 'err');
        showCache();
      } else if (msg.during === 'generate') {
        addNotice('生成中にエラーが起きました: ' + msg.message);
        finish({ interrupted: true });
      } else {
        setStatus('エラー: ' + msg.message, 'err');
      }
      break;
  }
}

worker = startWorker();
worker.postMessage({ type: 'probe' });
