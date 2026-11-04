// AI の遊び場: 言語モデル（Qwen3 4B）に、空の Web ページを自由に作り変えさせて眺める。
//
// 1 ステップ = モデルが「何をしたいか」と JavaScript を1つ書く → サンドボックス（右の iframe）で実行 → 結果（成功・エラー・
// console の出力・ページの要約）をモデルに返す。エラーなら「直して」と返す。これを、止めるまで繰り返す（回数の上限は無い）。
// 何をするかは指示しない。
//
// - 推論は ../tinyswallow-chat/runner.js（Web Worker の Transformers.js）。Qwen3 の思考（<think>…</think>）を左に思考ログとして出す
// - 実行は ./sandbox.js（このページには触れない iframe）
// - 会話は、直近の数ステップだけをモデルに渡す（ずっと続けても文脈が伸びない）。思考の部分は履歴に入れない（Qwen3 の推奨）
// 表示は textContent だけ（モデルの出力も、HTML として解釈しない）。

import { ModelRunner } from '../tinyswallow-chat/runner.js';
import { DTYPES, isModelId } from '../tinyswallow-chat/models.js';
import { Sandbox } from './sandbox.js';

const DEFAULT_MODEL = 'onnx-community/Qwen3-4B-ONNX';
// Qwen3 4B の ONNX は q4f16 しか無い（fp16 の計算が要る）ので、WebGPU（shader-f16）でしか動かない
const PRESET = { id: DEFAULT_MODEL, name: 'Qwen3 4B', mb: { q4f16: 2702 }, webgpuOnly: true };
const STORE_KEY = 'ai-playground-settings';
const HISTORY_STEPS = 4; // モデルに渡す直近のステップの数
const CONTEXT_LIMIT = 8192;
const DEFAULTS = { thinking: true, max_new_tokens: 2048, wait: 1 };

const SYSTEM = `あなたは、ブラウザの中にある小さな空の Web ページで、自由に遊ぶ AI です。誰からも指示はありません。
思うままにページを作り変えて、いろいろなことを試してください（見た目、動き、絵、音のない演出、小さなゲーム、計算の実験など、何でもかまいません）。

毎回、次の形で答えます:
1. いま何をしたいか、なぜか（1〜3文）
2. 実行する JavaScript を1つ、\`\`\`js と \`\`\` で囲んで書く

ルール:
- コードはこのページ（document）の中で実行されます。DOM、CSS、Canvas、SVG、requestAnimationFrame、setInterval などが使えます
- ネットワーク（fetch、外部の画像・フォント・スクリプト）、localStorage、alert、別のページへの移動は使えません
- 1回のコードは短くします（60行くらいまで）。前の回で作ったものを生かして、少しずつ育ててかまいません
- 次の回でも使いたい値や関数は window.名前 に入れておきます（const や let は次の回に残りません）
- 実行の結果（成功・エラー・console の出力・今のページのようす）が返ってきます。エラーが出たら、原因を考えて直します
- 同じことを繰り返さず、新しいことを試します`;

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const mb = (n) => (n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0) + ' MB';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const params = new URLSearchParams(location.search);
const MODEL = isModelId(params.get('model')) ? params.get('model') : DEFAULT_MODEL;
const force = {
  device: ['wasm', 'webgpu'].includes(params.get('device')) ? params.get('device') : null,
  dtype: DTYPES.includes(params.get('dtype')) ? params.get('dtype') : MODEL === DEFAULT_MODEL ? 'q4f16' : null,
};

// ---------------------------------------------------------------- 設定

function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') ?? {}; } catch { s = {}; }
  return {
    thinking: typeof s.thinking === 'boolean' ? s.thinking : DEFAULTS.thinking,
    max_new_tokens: typeof s.max_new_tokens === 'number' && s.max_new_tokens >= 256 && s.max_new_tokens <= 8192 ? s.max_new_tokens : DEFAULTS.max_new_tokens,
    wait: typeof s.wait === 'number' && s.wait >= 0 && s.wait <= 60 ? s.wait : DEFAULTS.wait,
  };
}
const settings = loadSettings();
const save = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch { /* 保存できなくても動く */ } };
$('thinking').checked = settings.thinking;
$('thinking').addEventListener('change', () => { settings.thinking = $('thinking').checked; save(); });
for (const [id, key, fmt] of [['max', 'max_new_tokens', (v) => `${v}`], ['wait', 'wait', (v) => `${v} 秒`]]) {
  $(id).value = String(settings[key]);
  $(`${id}-out`).textContent = fmt(settings[key]);
  $(id).addEventListener('input', () => { settings[key] = Number($(id).value); $(`${id}-out`).textContent = fmt(settings[key]); save(); });
}
$('model-id').textContent = MODEL;
$('model-link').href = `https://huggingface.co/${MODEL}`;

// ---------------------------------------------------------------- 状態

const sandbox = new Sandbox($('preview'));
const state = {
  phase: 'idle', // idle → loading → running ⇄ paused → stopped
  runner: null,
  generator: null, // 自動テスト用: モデルの代わりに答えを返す関数
  steps: [], // { n, think, say, code, result, feedback, el }
  pauseRequested: false,
  resume: null,
  navigated: false, // 中のページが別のページへ移動しようとした（初期化した）
  errorStreak: 0,
};
sandbox.onNavigate = () => {
  state.navigated = true;
  sandbox.reset();
};

function setStatus(text, cls = '') {
  $('status').textContent = text;
  $('status').className = 'status ' + cls;
}

function setControls() {
  const p = state.phase;
  $('start').hidden = !(p === 'idle' || p === 'stopped');
  $('start').textContent = p === 'stopped' ? '続きから始める' : '開始';
  $('pause').hidden = !(p === 'running' || p === 'paused');
  $('pause').textContent = p === 'paused' ? '再開' : state.pauseRequested ? '再開（止まるのを取り消す）' : '一時停止';
  $('stop-now').hidden = !(p === 'running' && state.pauseRequested);
  $('stop').hidden = !(p === 'running' || p === 'paused');
  $('copy').hidden = state.steps.length === 0;
}

// ---------------------------------------------------------------- モデルの答えの読み取り

/** 思考（<think>…</think>）・説明・コード（```js … ```）に分ける */
export function parseResponse(text) {
  let think = '', rest = text;
  const open = text.indexOf('<think>');
  if (open >= 0) {
    const close = text.indexOf('</think>', open);
    think = text.slice(open + 7, close >= 0 ? close : undefined).trim();
    rest = close >= 0 ? text.slice(0, open) + text.slice(close + 8) : text.slice(0, open);
  }
  const blocks = [...rest.matchAll(/```[ \t]*(?:js|javascript|JavaScript|JS)?[ \t]*\n([\s\S]*?)```/g)];
  const code = blocks.length ? blocks.at(-1)[1].trim() : '';
  const say = rest.replace(/```[\s\S]*?(```|$)/g, '').replace(/\n{3,}/g, '\n\n').trim();
  return { think, say, code, closedThink: open < 0 || text.includes('</think>') };
}

// ---------------------------------------------------------------- 結果をモデルに返す文

function summarize(snap) {
  if (!snap) return '（ページのようすを取れませんでした）';
  const tags = Object.entries(snap.tags).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} ${v}`).join('、');
  return [
    `要素 ${snap.elements} 個${tags ? `（${tags}）` : ''}${snap.title ? `、タイトル「${snap.title}」` : ''}`,
    snap.text ? `見えている文字: ${snap.text}` : '見えている文字: なし',
    `body の HTML（頭）: ${snap.html || '（空）'}`,
  ].join('\n');
}

export function feedbackFor(step, { errorStreak = 0, navigated = false } = {}) {
  const lines = [];
  if (navigated) lines.push('ページが別のページへ移動しようとしたので、空のページに初期化しました（移動はできません）。');
  if (!step.code) {
    lines.push('コードが見つかりませんでした。必ず、実行する JavaScript を1つ ```js と ``` で囲んで書いてください。');
  } else if (step.result.timedOut) {
    lines.push('実行の結果が返ってきませんでした（無限ループや重すぎる処理、またはページの書き換えで実行の仕組みが壊れた可能性があります）。ページを空に初期化しました。');
  } else {
    const r = step.result;
    const errs = [r.error, ...r.asyncErrors].filter(Boolean);
    if (errs.length) lines.push(`エラーが出ました:\n${errs.map((e) => `- ${e}`).join('\n')}\n原因を考えて、直してください。`);
    else lines.push('実行しました（エラーなし）。');
    if (r.logs.length) lines.push(`console の出力:\n${r.logs.join('\n')}`);
    lines.push(`今のページ:\n${summarize(r.snapshot)}`);
  }
  if (errorStreak >= 3) lines.push('失敗が続いています。同じやり方にこだわらず、別のやり方か、別のことを試してください。');
  lines.push('次は何をしますか？');
  return lines.join('\n\n');
}

/** モデルに渡す会話（system ＋ 直近のステップ ＋ いまの知らせ） */
function messagesFor(feedback) {
  const recent = state.steps.slice(-HISTORY_STEPS);
  const msgs = [{ role: 'system', content: SYSTEM }];
  msgs.push({ role: 'user', content: recent.length ? recent[0].prompt : feedback });
  recent.forEach((s, i) => {
    msgs.push({ role: 'assistant', content: `${s.say}${s.code ? `\n\n\`\`\`js\n${s.code}\n\`\`\`` : ''}`.trim() || '（何も書かなかった）' });
    msgs.push({ role: 'user', content: i + 1 < recent.length ? recent[i + 1].prompt : feedback });
  });
  return msgs;
}

// ---------------------------------------------------------------- 表示

function addStepView(n) {
  $('empty').hidden = true;
  const art = el('article', 'step running');
  const head = el('header', 'step-head');
  head.append(el('b', '', `ステップ ${n}`), el('span', 'step-state', '考えています…'));
  const think = el('details', 'think');
  think.open = true;
  think.append(el('summary', '', '思考'), el('div', 'think-text', ''));
  think.hidden = true;
  const say = el('p', 'say', '');
  const code = el('details', 'code');
  code.append(el('summary', '', 'コード'), el('pre', '', ''));
  code.hidden = true;
  const result = el('div', 'result');
  result.hidden = true;
  art.append(head, think, say, code, result);
  $('log').append(art);
  // 古いステップは、画面から外す（ずっと続けても重くならないように）
  while ($('log').querySelectorAll('.step').length > 60) $('log').querySelector('.step').remove();
  scrollLog(true);
  return art;
}
function renderStepView(view, parsed) {
  const think = view.querySelector('.think');
  think.hidden = !parsed.think;
  think.querySelector('.think-text').textContent = parsed.think;
  view.querySelector('.say').textContent = parsed.say;
  const code = view.querySelector('.code');
  code.hidden = !parsed.code;
  code.querySelector('pre').textContent = parsed.code;
  code.querySelector('summary').textContent = `コード（${parsed.code.split('\n').length} 行）`;
  view.querySelector('.step-state').textContent = parsed.closedThink ? '書いています…' : '考えています…';
}
function scrollLog(force = false) {
  const box = $('log');
  if (force || box.scrollHeight - box.scrollTop - box.clientHeight < 120) box.scrollTop = box.scrollHeight;
}
function logText() {
  return state.steps.map((s) => [
    `## ステップ ${s.n}`,
    s.think ? `[思考]\n${s.think}` : '',
    s.say ? `[説明]\n${s.say}` : '',
    s.code ? `[コード]\n${s.code}` : '[コード] なし',
    `[結果]\n${s.resultText}`,
  ].filter(Boolean).join('\n\n')).join('\n\n');
}

// ---------------------------------------------------------------- 進行

async function loadModel() {
  if (state.generator || state.runner?.current) return;
  const files = new Map();
  const runner = new ModelRunner(MODEL, {
    force,
    preset: MODEL === DEFAULT_MODEL ? PRESET : null,
    onStatus: (t) => setStatus(`${t}…`),
    onLog: (t) => console.info(t),
    onProgress: (m) => {
      if (!m.file) return;
      const f = files.get(m.file) ?? { loaded: 0, total: 0 };
      if (m.status === 'progress') Object.assign(f, { loaded: m.loaded, total: m.total });
      if (m.status === 'done' && f.total) f.loaded = f.total;
      files.set(m.file, f);
      let a = 0, t = 0;
      for (const x of files.values()) { a += x.loaded; t += x.total; }
      $('progress-box').hidden = false;
      $('progress').value = t ? a / t : 0;
      $('progress-text').textContent = t ? `${mb(a)} / ${mb(t)}（${((a / t) * 100).toFixed(1)}%）` : '準備しています…';
    },
  });
  state.runner = runner;
  try {
    const r = await runner.load();
    $('backend').textContent = `${MODEL === DEFAULT_MODEL ? PRESET.name : MODEL}: ${runner.label}`;
    $('backend').className = 'badge ' + r.device;
  } finally {
    $('progress-box').hidden = true;
  }
}

/** モデルに1回答えさせる（思考と本文を少しずつ表示する） */
async function ask(messages, onText) {
  if (state.generator) return state.generator(messages, onText);
  let text = '';
  const done = await state.runner.generate(messages, {
    max_new_tokens: settings.max_new_tokens,
    temperature: settings.thinking ? 0.6 : 0.7,
    top_p: settings.thinking ? 0.95 : 0.8,
    repetition_penalty: 1.05,
  }, Math.max(1024, CONTEXT_LIMIT - settings.max_new_tokens), (t) => { text += t; onText(text); }, {
    templateOptions: { enable_thinking: settings.thinking },
  });
  state.lastDone = done;
  return text;
}

async function start() {
  state.phase = 'loading';
  setControls();
  $('start').hidden = true;
  try {
    await loadModel();
  } catch (e) {
    state.phase = state.steps.length ? 'stopped' : 'idle';
    setStatus(`読み込めませんでした: ${e.message}（このページは WebGPU と fp16（shader-f16）に対応したブラウザが必要です）`, 'err');
    setControls();
    return;
  }
  state.phase = 'running';
  setControls();
  await loop();
}

async function loop() {
  while (state.phase === 'running') {
    if (state.pauseRequested) {
      state.phase = 'paused';
      state.pauseRequested = false;
      setStatus('一時停止中です。「再開」で続けます。');
      setControls();
      await new Promise((r) => (state.resume = r));
      if (state.phase !== 'running') return;
    }
    await step();
    if (state.phase !== 'running') break;
    if (settings.wait > 0) await sleep(settings.wait * 1000);
  }
}

async function step() {
  const n = (state.steps.at(-1)?.n ?? 0) + 1;
  const prev = state.steps.at(-1);
  // いまの知らせ（前のステップの結果。最初は「空のページ」）
  const prompt = prev ? prev.feedback : 'ページは空です（<body></body> だけ）。最初に何をしますか？';
  const view = addStepView(n);
  setStatus(`ステップ ${n}: 考えています…`);
  let text = '';
  try {
    text = await ask(messagesFor(prompt), (t) => {
      renderStepView(view, parseResponse(t));
      scrollLog();
    });
  } catch (e) {
    view.classList.remove('running');
    view.querySelector('.step-state').textContent = 'エラー';
    if (state.phase !== 'running' && state.phase !== 'paused') return;
    setStatus(`生成中にエラーが起きました: ${e.message}`, 'err');
    state.phase = 'paused';
    setControls();
    await new Promise((r) => (state.resume = r));
    view.remove();
    return;
  }
  const parsed = parseResponse(text);
  renderStepView(view, parsed);
  if (state.phase === 'stopped') {
    // 「止める」で生成を止めた: このステップは実行しない
    view.classList.remove('running');
    view.querySelector('.step-state').textContent = '止めた（実行しない）';
    return;
  }
  const s = { n, prompt, think: parsed.think, say: parsed.say, code: parsed.code, result: null, el: view };
  // 実行
  if (parsed.code) {
    view.querySelector('.step-state').textContent = '実行しています…';
    s.result = await sandbox.run(parsed.code);
  } else {
    s.result = { error: null, asyncErrors: [], logs: [], snapshot: null, noCode: true };
  }
  const errs = [s.result.error, ...(s.result.asyncErrors ?? [])].filter(Boolean);
  const failed = !parsed.code || s.result.timedOut || errs.length > 0;
  state.errorStreak = failed ? state.errorStreak + 1 : 0;
  s.feedback = feedbackFor(s, { errorStreak: state.errorStreak, navigated: state.navigated });
  state.navigated = false;
  s.resultText = !parsed.code ? 'コードなし' : s.result.timedOut ? '応答なし（ページを初期化した）' : errs.length ? `エラー: ${errs.join(' / ')}` : '成功';
  // 結果の表示
  const res = view.querySelector('.result');
  res.hidden = false;
  res.className = 'result ' + (failed ? 'err' : 'ok');
  res.textContent = s.resultText + (s.result.logs?.length ? `\nconsole: ${s.result.logs.slice(-5).join(' / ')}` : '');
  view.classList.remove('running');
  const meta = [];
  if (state.lastDone?.tokens) meta.push(`${state.lastDone.tokens} トークン`);
  if (state.lastDone?.tokensPerSec) meta.push(`${state.lastDone.tokensPerSec.toFixed(1)} トークン/秒`);
  view.querySelector('.step-state').textContent = (failed ? '失敗' : '成功') + (meta.length ? `・${meta.join('・')}` : '');
  // 古いステップの思考は畳む
  for (const d of $('log').querySelectorAll('.step:not(:last-child) .think[open]')) d.open = false;
  state.steps.push(s);
  if (state.steps.length > 200) state.steps.splice(0, state.steps.length - 200);
  $('stats').textContent = `${n} ステップ・失敗が続いた回数 ${state.errorStreak}`;
  setStatus(`ステップ ${n}: ${s.resultText.split('\n')[0]}`, failed ? 'warn' : '');
  setControls();
}

function resume() {
  state.phase = 'running';
  setStatus('再開します…');
  setControls();
  const r = state.resume;
  state.resume = null;
  r?.();
}

$('start').addEventListener('click', () => { if (state.phase === 'idle' || state.phase === 'stopped') start(); });
$('pause').addEventListener('click', () => {
  if (state.phase === 'paused') return resume();
  if (state.phase !== 'running') return;
  state.pauseRequested = !state.pauseRequested;
  setStatus(state.pauseRequested ? 'いまのステップが終わったところで、一時停止します。' : '一時停止を取り消しました。');
  setControls();
});
$('stop-now').addEventListener('click', () => { state.runner?.interrupt(); });
$('stop').addEventListener('click', () => {
  const was = state.phase;
  state.phase = 'stopped';
  state.pauseRequested = false;
  state.runner?.interrupt();
  setStatus(`止めました（${state.steps.length} ステップ）。「続きから始める」で続けられます。`);
  setControls();
  if (was === 'paused') { const r = state.resume; state.resume = null; r?.(); }
});
$('reset-page').addEventListener('click', async () => {
  await sandbox.reset();
  // 次のステップで、ページを初期化したことをモデルに伝える
  const last = state.steps.at(-1);
  if (last) last.feedback = 'ページを空に初期化しました（あなたが作ったものは消えました。window に入れた値も消えています）。\n\n次は何をしますか？';
  setStatus('ページを初期化しました。');
});
$('clear-log').addEventListener('click', () => {
  if (state.phase === 'running' || state.phase === 'loading') return;
  state.steps = [];
  state.errorStreak = 0;
  $('log').replaceChildren($('empty'));
  $('empty').hidden = false;
  $('stats').textContent = '';
  setControls();
});
$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(logText()); $('copied').textContent = 'コピーしました'; } catch { $('copied').textContent = 'コピーできませんでした'; }
  setTimeout(() => ($('copied').textContent = ''), 3000);
});

setControls();
setStatus('「開始」でモデルを読み込んで、遊び始めます（初回は約 2.7 GB のダウンロード）。');

// 自動テスト用
window.__playground = {
  state, settings, sandbox, parseResponse, feedbackFor, messagesFor,
  setGenerator: (fn) => { state.generator = fn; },
};
