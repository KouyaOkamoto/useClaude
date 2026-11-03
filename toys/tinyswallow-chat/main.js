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

import { MODELS, DTYPES, isModelId, presetOf, planFor } from './models.js';

const DEFAULT_MODEL = MODELS[0].id;
const MODEL_KEY = 'tinyswallow-chat-model';
const DIAG_KEY = 'tinyswallow-chat-diag';
const DEFAULT_SYSTEM = 'あなたは誠実で優秀な日本人のアシスタントです。';
const DEFAULTS = { max_new_tokens: 512, temperature: 0.7, top_p: 0.8, repetition_penalty: 1.05 };
// 文脈の上限（トークン）。モデル自体はもっと長く扱えるが、ブラウザのメモリと速さのため控えめにする
const CONTEXT_LIMIT = 4096;
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
const UA = navigator.userAgent;
const MOBILE = /Android|iPhone|iPad|iPod|Mobile/i.test(UA) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(UA));
// 前回の診断の記録（今回の記録で上書きする前に読んでおく）
let prevDiag = null;
try { prevDiag = JSON.parse(localStorage.getItem(DIAG_KEY) ?? 'null'); } catch { prevDiag = null; }
const prevCrashed = !!prevDiag && ['loading', 'generating'].includes(prevDiag.phase);

/**
 * 使うモデルを決める: URL の ?model= → 前に選んだもの → 端末に合わせた既定（PC は TinySwallow、スマホは Qwen2.5 0.5B）。
 * 前回、そのモデルの読み込み・生成の途中でページが終わっていたら（メモリ不足の可能性）、ひとつ小さいモデルにする
 */
function chooseModel() {
  const q = params.get('model');
  if (isModelId(q)) return { id: q, why: 'URL の指定' };
  let saved = null;
  try { saved = localStorage.getItem(MODEL_KEY); } catch { saved = null; }
  let i = MODELS.findIndex((m) => m.id === saved);
  const why = i >= 0 ? '前に選んだもの' : MOBILE ? 'スマホ・タブレットの既定' : 'PC の既定';
  if (i < 0) i = MOBILE ? 1 : 0;
  if (prevCrashed && prevDiag.model === MODELS[i].id && i + 1 < MODELS.length) {
    return { id: MODELS[i + 1].id, why: `前回 ${MODELS[i].name} の途中で止まったため、ひとつ小さいモデル`, downFrom: MODELS[i] };
  }
  return { id: MODELS[i].id, why };
}
const CHOSEN = chooseModel();
const MODEL = CHOSEN.id;
const PRESET = presetOf(MODEL);
const FORCE_DEVICE = ['wasm', 'webgpu'].includes(params.get('device')) ? params.get('device') : null;
const FORCE_DTYPE = DTYPES.includes(params.get('dtype')) ? params.get('dtype') : null;

// 推論の worker。WebGPU で読み込めなかったときは捨てて、新しい worker で wasm で読み直す
let worker = null;
let attempt = 0; // plan の何番目の組み合わせで読み込んでいるか
function startWorker() {
  const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  w.addEventListener('message', onWorkerMessage);
  w.addEventListener('error', (e) => {
    logDiag('worker のエラー: ' + (e.message || '(内容なし)'));
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
  stage: '', // 読み込みの段階（診断情報用）
  lastMsgAt: Date.now(), // worker から最後に知らせが来た時刻
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

// モデルの選択。変えたら、選んだものを覚えて、ページを読み直す（worker・モデルを作り直す）
for (const m of PRESET ? MODELS : [...MODELS, { id: MODEL, name: MODEL, note: 'URL で指定' }]) {
  const o = el('option', '', `${m.name}（${m.note}${m.mb ? `・約 ${m.mb.q4f16} MB〜` : ''}）`);
  o.value = m.id;
  $('model-select').append(o);
}
$('model-select').value = MODEL;
$('model-select').addEventListener('change', () => {
  const id = $('model-select').value;
  if (['ready', 'generating', 'loading'].includes(state.phase) && !confirm('モデルを変えると、ページを読み直します（会話は消えます）。')) {
    $('model-select').value = MODEL;
    return;
  }
  try { localStorage.setItem(MODEL_KEY, id); } catch { /* 覚えられなくても、URL で渡す */ }
  // 診断の記録は「途中で終わった」と見なさないよう、いまの状態を読み込み前にしておく
  state.phase = 'idle';
  saveDiag();
  const q = new URLSearchParams(location.search);
  q.delete('model');
  if (!MODELS.some((m) => m.id === id)) q.set('model', id);
  location.href = location.pathname + (q.toString() ? '?' + q : '');
});

/** ダウンロードの大きさ（選んだ量子化の版） */
function showSize() {
  const dtype = plan?.[0]?.dtype;
  const n = PRESET?.mb?.[dtype];
  $('env-size').textContent = n ? `約 ${n >= 1000 ? (n / 1024).toFixed(1) + ' GB' : n + ' MB'}（${dtype}）` : '不明（読み込むと分かります）';
}

function setStatus(text, cls = '') {
  clearInterval(state.stageTimer);
  $('setup-status').textContent = text;
  $('setup-status').className = 'status ' + cls;
}

// ---------------------------------------------------------------- 診断情報
// スマホなど開発者ツールが使えない環境で、どこで止まったかを画面で確かめられるようにする。
// 記録はブラウザ（localStorage）にも残す。メモリ不足でページが落ちて再読み込みされても、次に開いたときに分かる

const diag = { lines: [], t0: Date.now() };
function saveDiag() {
  try { localStorage.setItem(DIAG_KEY, JSON.stringify({ at: new Date().toISOString(), phase: state.phase, stage: state.stage ?? '', model: MODEL, lines: diag.lines.slice(-80) })); } catch { /* 保存できなくても動く */ }
}
function logDiag(text) {
  diag.lines.push(`[${((Date.now() - diag.t0) / 1000).toFixed(1)}s] ${text}`);
  if (diag.lines.length > 300) diag.lines.splice(0, diag.lines.length - 300);
  $('diag-log').textContent = diag.lines.join('\n');
  saveDiag();
}

/** 読み込みの段階を出す。経過時間を1秒ごとに足し、長く応答が無ければ、そう知らせる */
function setStage(text) {
  setStatus(text + '…');
  state.stage = text;
  logDiag('段階: ' + text);
  const t0 = Date.now();
  state.stageTimer = setInterval(() => {
    const sec = Math.floor((Date.now() - t0) / 1000);
    const quiet = Math.floor((Date.now() - state.lastMsgAt) / 1000);
    let line = `${text}…（${sec} 秒）`;
    if (quiet >= 60) line += `。${quiet} 秒、進み具合の知らせがありません。端末のメモリが足りないと、ここで止まることがあります`;
    $('setup-status').textContent = line;
  }, 1000);
}

logDiag(`ページ: ${location.pathname}${location.search}`);
logDiag(`端末: ${UA}`);
logDiag(`メモリ（deviceMemory）: ${navigator.deviceMemory ?? '不明'} GB・CPU: ${navigator.hardwareConcurrency ?? '不明'}・画面: ${screen.width}x${screen.height}@${devicePixelRatio}・スマホ/タブレット: ${MOBILE ? 'はい' : 'いいえ'}`);
logDiag(`crossOriginIsolated: ${self.crossOriginIsolated ? 'はい' : 'いいえ'}・モデル: ${MODEL}（${CHOSEN.why}）`);
navigator.storage?.estimate?.().then((e) => logDiag(`保存領域: 使用 ${mb(e.usage ?? 0)} / 上限 ${mb(e.quota ?? 0)}`), () => {});

// 前回、読み込み・生成の途中で終わっていたら（ページが落ちた・再読み込みされた・閉じた）、知らせる
{
  const prev = prevDiag;
  if (prevCrashed) {
    const where = prev.phase === 'generating' ? '返答の生成' : `「${prev.stage || 'モデルの読み込み'}」`;
    const down = CHOSEN.downFrom ? `そのため今回は、ひとつ小さい ${PRESET.name} を選んでいます（上で変えられます）。` : '';
    $('mem-warn').textContent = `前回（${new Date(prev.at).toLocaleString()}）は、${where}の途中で終わっていました。ブラウザがメモリ不足でページを止めた（再読み込みした）可能性があります。${down}下の「診断情報」に前回の記録があります。`;
    $('mem-warn').hidden = false;
    $('diag-box').open = true;
    diag.lines.unshift('---- 前回の記録 ----', ...(prev.lines ?? []).map(String), '---- ここから今回 ----');
    $('diag-log').textContent = diag.lines.join('\n');
  }
}

$('diag-copy').addEventListener('click', async () => {
  const text = diag.lines.join('\n');
  try {
    await navigator.clipboard.writeText(text);
    $('diag-copied').textContent = 'コピーしました';
  } catch {
    // クリップボードが使えないときは、選択状態にする（長押しでコピーできる）
    const r = document.createRange();
    r.selectNodeContents($('diag-log'));
    getSelection().removeAllRanges();
    getSelection().addRange(r);
    $('diag-copied').textContent = '選択しました（コピーしてください）';
  }
});

/** 試す組み合わせの順番（models.js の planFor） */
const choose = (probe) => planFor(probe, PRESET, { device: FORCE_DEVICE, dtype: FORCE_DTYPE });

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
  state.lastMsgAt = Date.now();
  logDiag(`読み込み開始: ${plan[0].device}・${plan[0].dtype}`);
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
  logDiag(`生成開始（会話 ${state.history.length} 件・最大 ${settings.max_new_tokens} トークン）`);
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
  logDiag(`生成終了: ${msg.tokens ?? 0} トークン・${msg.tokensPerSec ? msg.tokensPerSec.toFixed(2) + ' トークン/秒' : '-'}・最初の語まで ${msg.firstTokenMs ? (msg.firstTokenMs / 1000).toFixed(1) + ' 秒' : '-'}${msg.interrupted ? '・停止' : ''}`);
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
  saveDiag();
}

// ---------------------------------------------------------------- worker からの知らせ

function onWorkerMessage(e) {
  const msg = e.data;
  state.lastMsgAt = Date.now();
  switch (msg.type) {
    case 'probe': {
      logDiag(`WebGPU: ${msg.webgpu ? 'あり' : 'なし'}・shader-f16: ${msg.fp16 ? 'あり' : 'なし'}${msg.adapter ? '・' + msg.adapter : ''}${msg.error ? '・エラー ' + msg.error : ''}`);
      plan = choose(msg);
      logDiag('試す順番: ' + plan.map((x) => `${x.device}・${x.dtype}`).join(' → '));
      // スマホ・メモリの少ない端末では、読み込む前に注意を出す（前回の失敗の知らせがあれば、そちらを優先）
      if ($('mem-warn').hidden && (MOBILE || (navigator.deviceMemory && navigator.deviceMemory <= 4))) {
        $('mem-warn').textContent = MODEL === MODELS[0].id
          ? `スマホ・タブレットやメモリの少ない端末では、${MODELS[0].name}（約 1.2〜1.7 GB）はメモリに収まらず、読み込みの途中で止まる（ページが再読み込みされる）ことがあります。止まるときは、上で小さいモデルを選んでください。`
          : 'スマホ・タブレットでは、メモリが足りないと読み込みの途中で止まる（ページが再読み込みされる）ことがあります。止まるときは、上でもっと小さいモデルを選んでください。';
        $('mem-warn').hidden = false;
      }
      showSize();
      // WebGPU でしか動かないモデルを選んでいるのに、WebGPU が無い
      if (PRESET?.webgpuOnly && plan[0].device !== 'webgpu') {
        $('mem-warn').textContent = `${PRESET.name} は WebGPU でしか動きません。このブラウザでは WebGPU が使えないので、上で別のモデルを選んでください。`;
        $('mem-warn').hidden = false;
        showBackend(plan[0].device, plan[0].dtype, '。このブラウザでは WebGPU が使えないため');
        state.phase = 'probing';
        logDiag(`${PRESET.name} は WebGPU が必要なので、読み込まない`);
        break;
      }
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
        if (msg.status === 'done') logDiag(`ダウンロード完了: ${msg.file}${f.total ? '（' + mb(f.total) + '）' : ''}`);
        state.files.set(msg.file, f);
        showProgress();
      }
      break;
    }
    case 'status':
      setStage(msg.text);
      break;
    case 'log':
      logDiag(msg.text);
      break;
    case 'ready':
      state.phase = 'ready';
      logDiag(`準備完了: ${msg.device}・${msg.dtype}（${(msg.ms / 1000).toFixed(1)} 秒）`);
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
      logDiag(`エラー（${msg.during}）: ${msg.message}`);
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
        logDiag(`読み込み直し: ${next.device}・${next.dtype}`);
        worker.postMessage({ type: 'load', model: MODEL, ...next });
      } else if (msg.during === 'load') {
        state.phase = 'idle';
        saveDiag();
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
