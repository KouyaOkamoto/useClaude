// ディスカッション: 2つのモデル（A と B）に、議題について交互に話させて眺める。
//
// - A と B のモデルは別々に選べる。同じモデルなら、1つだけ読み込んで共有する（メモリを節約）
// - 発言は交互に生成する（同時には動かさない）。各モデルには、自分の発言を assistant、相手の発言を user として渡す
// - 議題・名前・立場は system に入れる（文脈が長くなって古い発言を除いても、議題は残る）
// - 一時停止: いまの発言が終わったところで止まる。待っている間に「いますぐ止める」で、いまの発言を途中で止められる
// - 再開: 次の人の発言から続ける
// 表示は textContent だけ（モデルの出力も、HTML として解釈しない）。

import { MODELS, DTYPES, isModelId } from './models.js';
import { ModelRunner } from './runner.js';

const STORE_KEY = 'tinyswallow-discussion-settings';
// 文脈の上限（トークン）。チャットと同じく、ブラウザのメモリと速さのため控えめにする
const CONTEXT_LIMIT = 4096;
const DEFAULTS = {
  names: ['ミナト', 'ハルカ'],
  models: [MODELS[0].id, MODELS[0].id],
  stances: ['', ''],
  topic: '',
  max_new_tokens: 768,
  turns: 12,
  temperature: 0.8,
};

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const mb = (n) => (n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0) + ' MB';
const SIDES = ['a', 'b'];

const params = new URLSearchParams(location.search);
const force = {
  device: ['wasm', 'webgpu'].includes(params.get('device')) ? params.get('device') : null,
  dtype: DTYPES.includes(params.get('dtype')) ? params.get('dtype') : null,
};
// URL で A・B のモデルを指定できる（?a=owner/name&b=owner/name。テスト用）
const urlModels = [params.get('a'), params.get('b')].map((x) => (isModelId(x) ? x : null));

// ---------------------------------------------------------------- 設定（ブラウザに保存）

function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') ?? {}; } catch { s = {}; }
  const pair = (v, d, ok) => (Array.isArray(v) && v.length === 2 && v.every(ok) ? v : d);
  const num = (v, d, lo, hi) => (typeof v === 'number' && v >= lo && v <= hi ? v : d);
  return {
    names: pair(s.names, DEFAULTS.names, (x) => typeof x === 'string' && x.trim()),
    models: pair(s.models, DEFAULTS.models, isModelId),
    stances: pair(s.stances, DEFAULTS.stances, (x) => typeof x === 'string'),
    topic: typeof s.topic === 'string' ? s.topic : '',
    max_new_tokens: num(s.max_new_tokens, DEFAULTS.max_new_tokens, 64, 4096),
    turns: num(s.turns, DEFAULTS.turns, 2, 100),
    temperature: num(s.temperature, DEFAULTS.temperature, 0, 2),
  };
}
const settings = loadSettings();
urlModels.forEach((m, i) => { if (m) settings.models[i] = m; });
const save = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch { /* 保存できなくても動く */ } };

function modelLabel(id) {
  const m = MODELS.find((x) => x.id === id);
  return m ? m.name : id;
}

SIDES.forEach((side, i) => {
  const sel = $(`${side}-model`);
  const list = MODELS.some((m) => m.id === settings.models[i]) ? MODELS : [...MODELS, { id: settings.models[i], name: settings.models[i], note: 'URL で指定' }];
  for (const m of list) {
    const o = el('option', '', `${m.name}（${m.note}${m.mb ? `・約 ${m.mb.q4f16} MB〜` : ''}）`);
    o.value = m.id;
    sel.append(o);
  }
  sel.value = settings.models[i];
  $(`${side}-name`).value = settings.names[i];
  $(`${side}-stance`).value = settings.stances[i];
  sel.addEventListener('change', () => { settings.models[i] = sel.value; save(); showMemNote(); });
  $(`${side}-name`).addEventListener('input', () => { settings.names[i] = $(`${side}-name`).value.trim() || DEFAULTS.names[i]; save(); });
  $(`${side}-stance`).addEventListener('input', () => { settings.stances[i] = $(`${side}-stance`).value; save(); });
});
$('topic').value = settings.topic;
$('topic').addEventListener('input', () => { settings.topic = $('topic').value; save(); });
const sliders = [
  ['max', 'max-out', 'max_new_tokens', (v) => String(v)],
  ['turns', 'turns-out', 'turns', (v) => `${v} 回`],
  ['temp', 'temp-out', 'temperature', (v) => v.toFixed(2)],
];
for (const [input, out, key, fmt] of sliders) {
  $(input).value = String(settings[key]);
  $(out).textContent = fmt(settings[key]);
  $(input).addEventListener('input', () => {
    settings[key] = Number($(input).value);
    $(out).textContent = fmt(settings[key]);
    save();
  });
}

function showMemNote() {
  const same = settings.models[0] === settings.models[1];
  const size = (id) => MODELS.find((m) => m.id === id)?.mb?.q4f16;
  const total = same ? size(settings.models[0]) : (size(settings.models[0]) ?? 0) + (size(settings.models[1]) ?? 0);
  $('mem-note').textContent = same
    ? `A と B は同じモデルなので、1つだけ読み込んで共有します${total ? `（約 ${total} MB〜）` : ''}。`
    : `A と B は別のモデルなので、2つとも読み込みます${total ? `（合わせて約 ${total} MB〜。メモリを多く使います）` : ''}。初回はダウンロードに時間がかかります。`;
}
showMemNote();

// ---------------------------------------------------------------- 議論の状態

const state = {
  phase: 'setup', // setup → loading → running ⇄ paused → finished
  runners: new Map(), // モデル → ModelRunner（同じモデルは共有）
  turns: [], // { speaker: 0|1, text, el }
  pauseRequested: false,
  resume: null, // 一時停止中に、再開を待つ Promise の resolve
  current: null, // いま話しているモデル（いますぐ止めるため）
  snapshot: null, // 開始したときの名前・立場・議題（途中で欄を書き換えても、議論は変わらない）
};

function setStatus(text, cls = '') {
  $('status').textContent = text;
  $('status').className = 'status ' + cls;
}

function setControls() {
  const p = state.phase;
  const editable = p === 'setup' || p === 'finished';
  for (const id of ['a-name', 'b-name', 'a-model', 'b-model', 'a-stance', 'b-stance', 'topic']) $(id).disabled = !editable;
  $('start').hidden = !editable;
  $('start').textContent = p === 'finished' ? '同じ設定でもう一度' : '開始';
  $('pause').hidden = !(p === 'running' || p === 'paused');
  $('pause').textContent = p === 'paused' ? '再開' : state.pauseRequested ? '再開（止まるのを取り消す）' : '一時停止';
  $('stop-now').hidden = !(p === 'running' && state.pauseRequested);
  $('finish').hidden = !(p === 'running' || p === 'paused');
  $('restart').hidden = !(p === 'finished' || p === 'paused');
  $('copy').hidden = state.turns.length === 0;
}

// ---------------------------------------------------------------- 表示

function addTurnView(speaker) {
  $('empty').hidden = true;
  const div = el('div', `msg turn ${SIDES[speaker]}`);
  div.append(el('span', 'who', state.snapshot.names[speaker]), el('span', 'text', ''));
  $('transcript').append(div);
  scrollToEnd(true);
  return div;
}
function scrollToEnd(force = false) {
  const box = $('transcript');
  if (force || box.scrollHeight - box.scrollTop - box.clientHeight < 80) box.scrollTop = box.scrollHeight;
}
function transcriptText() {
  const s = state.snapshot;
  return [`議題: ${s.topic}`, ...state.turns.map((t) => `【${s.names[t.speaker]}】${t.text}`)].join('\n\n');
}

// ---------------------------------------------------------------- プロンプト

/** 話す人（speaker）から見た会話。自分の発言は assistant、相手の発言は user */
function messagesFor(speaker) {
  const s = state.snapshot;
  const me = s.names[speaker], other = s.names[1 - speaker];
  const system = [
    `あなたは「${me}」として、「${other}」と次の議題について日本語で議論しています。`,
    `議題: ${s.topic}`,
    s.stances[speaker].trim() ? `あなたの立場・性格: ${s.stances[speaker].trim()}` : '',
    '相手の発言を受けて、自分の意見を述べてください。同じことを繰り返さず、話を先に進めてください。',
    '1回の発言は3〜6文程度にし、名前や見出しを付けず、発言の本文だけを書いてください。',
  ].filter(Boolean).join('\n');
  const list = [];
  const push = (role, content) => {
    const last = list.at(-1);
    if (last?.role === role) last.content += '\n\n' + content;
    else list.push({ role, content });
  };
  if (speaker === 0) push('user', `「${other}」との議論を始めます。議題について、あなたの最初の意見を述べてください。`);
  for (const t of state.turns) push(t.speaker === speaker ? 'assistant' : 'user', t.text || '（発言なし）');
  return [{ role: 'system', content: system }, ...list];
}

// ---------------------------------------------------------------- 進行

async function loadRunners() {
  const ids = [...new Set(state.snapshot.models)];
  const loaded = new Map();
  for (const [i, id] of ids.entries()) {
    let runner = state.runners.get(id);
    if (runner?.current) { loaded.set(id, runner); continue; }
    const files = new Map();
    runner = new ModelRunner(id, {
      force,
      onStatus: (text) => setStatus(`${modelLabel(id)}（${i + 1}/${ids.length}）: ${text}…`),
      onLog: (text) => console.info(text),
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
        $('progress-text').textContent = `${modelLabel(id)}: ${t ? `${mb(a)} / ${mb(t)}（${((a / t) * 100).toFixed(1)}%）` : '準備しています…'}`;
      },
    });
    state.runners.set(id, runner);
    await runner.load();
    loaded.set(id, runner);
  }
  // 使わなくなったモデルは捨てる（メモリを手放す）
  for (const [id, r] of state.runners) if (!loaded.has(id)) { r.dispose(); state.runners.delete(id); }
  $('progress-box').hidden = true;
  $('backend').textContent = ids.map((id) => `${modelLabel(id)}: ${state.runners.get(id).label}`).join(' / ');
  $('backend').className = 'badge ' + (ids.every((id) => state.runners.get(id).current.device === 'webgpu') ? 'webgpu' : 'wasm');
}

async function start() {
  const topic = $('topic').value.trim();
  if (!topic) { setStatus('議題を書いてください。', 'err'); $('topic').focus(); return; }
  state.snapshot = {
    names: SIDES.map((s, i) => $(`${s}-name`).value.trim() || DEFAULTS.names[i]),
    models: [...settings.models],
    stances: SIDES.map((s) => $(`${s}-stance`).value),
    topic,
  };
  state.turns = [];
  state.pauseRequested = false;
  $('transcript').replaceChildren($('empty'));
  $('empty').hidden = false;
  $('topic-view').textContent = `議題: ${topic}`;
  $('topic-view').hidden = false;
  $('stats').textContent = '';
  state.phase = 'loading';
  setControls();
  $('start').hidden = true;
  try {
    await loadRunners();
  } catch (e) {
    state.phase = 'setup';
    $('progress-box').hidden = true;
    setStatus(`読み込めませんでした: ${e.message}`, 'err');
    setControls();
    return;
  }
  state.phase = 'running';
  setControls();
  await run();
}

/** 交互に発言させる（一時停止・終了で止まる） */
async function run() {
  const s = state.snapshot;
  while (state.turns.length < settings.turns) {
    if (state.phase !== 'running') return;
    if (state.pauseRequested) {
      state.phase = 'paused';
      state.pauseRequested = false;
      setStatus('一時停止中です。「再開」で、次の発言から続けます。');
      setControls();
      await new Promise((r) => (state.resume = r));
      if (state.phase !== 'running') return;
    }
    const speaker = state.turns.length % 2;
    const runner = state.runners.get(s.models[speaker]);
    const view = addTurnView(speaker);
    view.classList.add('streaming');
    const turn = { speaker, text: '', el: view };
    setStatus(`${s.names[speaker]}（${modelLabel(s.models[speaker])}）が考えています…（${state.turns.length + 1} / ${settings.turns}）`);
    state.current = runner;
    const t0 = performance.now();
    let done;
    try {
      done = await runner.generate(messagesFor(speaker), {
        max_new_tokens: settings.max_new_tokens,
        temperature: settings.temperature,
        top_p: 0.9,
        repetition_penalty: 1.1,
      }, Math.max(256, CONTEXT_LIMIT - settings.max_new_tokens), (text) => {
        turn.text += text;
        view.querySelector('.text').textContent = turn.text;
        if (state.phase === 'running') setStatus(`${s.names[speaker]} が話しています…（${state.turns.length + 1} / ${settings.turns}）`);
        scrollToEnd();
      });
    } catch (e) {
      view.classList.remove('streaming');
      if (state.phase !== 'running' && state.phase !== 'paused') return; // 終了・最初から
      setStatus(`生成中にエラーが起きました: ${e.message}`, 'err');
      state.phase = 'paused';
      setControls();
      await new Promise((r) => (state.resume = r));
      if (state.phase !== 'running') return;
      view.remove();
      continue;
    } finally {
      state.current = null;
    }
    view.classList.remove('streaming');
    turn.text = turn.text.trim();
    view.querySelector('.text').textContent = turn.text || '（発言なし）';
    const meta = [];
    if (done.interrupted) meta.push('途中で停止');
    if (done.tokens) meta.push(`${done.tokens} トークン`);
    if (done.tokensPerSec) meta.push(`${done.tokensPerSec.toFixed(1)} トークン/秒`);
    if (done.dropped) meta.push(`古い発言 ${done.dropped} 件を除いて生成`);
    view.append(el('span', 'meta', meta.join('・')));
    state.turns.push(turn);
    $('stats').textContent = `${state.turns.length} / ${settings.turns} 回`;
    setControls();
    if (state.phase === 'finished') return;
  }
  state.phase = 'finished';
  setStatus(`議論が終わりました（${state.turns.length} 回）。`, 'ok');
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

$('start').addEventListener('click', () => {
  if (state.phase === 'setup' || state.phase === 'finished') start();
});
$('pause').addEventListener('click', () => {
  if (state.phase === 'paused') return resume();
  if (state.phase !== 'running') return;
  // いまの発言が終わったところで止まる（押し直すと取り消し）
  state.pauseRequested = !state.pauseRequested;
  setStatus(state.pauseRequested ? 'いまの発言が終わったところで、一時停止します。' : '一時停止を取り消しました。');
  setControls();
});
$('stop-now').addEventListener('click', () => {
  // いまの発言を途中で止める（そこまでの発言は残す）。一時停止の予約はそのまま
  state.current?.interrupt();
});
$('finish').addEventListener('click', () => {
  const was = state.phase;
  state.phase = 'finished';
  state.pauseRequested = false;
  state.current?.interrupt();
  setStatus(`議論を終えました（${state.turns.length} 回）。`, 'ok');
  setControls();
  if (was === 'paused') { const r = state.resume; state.resume = null; r?.(); }
});
$('restart').addEventListener('click', () => {
  const was = state.phase;
  state.phase = 'setup';
  state.pauseRequested = false;
  state.current?.interrupt();
  if (was === 'paused') { const r = state.resume; state.resume = null; r?.(); }
  state.turns = [];
  $('transcript').replaceChildren($('empty'));
  $('empty').hidden = false;
  $('topic-view').hidden = true;
  $('stats').textContent = '';
  setStatus('');
  setControls();
});
$('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(transcriptText());
    $('copied').textContent = 'コピーしました';
  } catch {
    $('copied').textContent = 'コピーできませんでした';
  }
  setTimeout(() => ($('copied').textContent = ''), 3000);
});

setControls();
// 自動テスト用
window.__discussion = { state, settings, messagesFor };
