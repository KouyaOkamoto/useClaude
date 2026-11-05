// AI の遊び場: 言語モデル（Qwen3 4B）に、キャンバス 1 枚で自由に遊ばせて眺める。
//
// 1 ステップ = モデルが「何をしたいか」と JavaScript（1 つのプログラム）を書く → サンドボックス（右の iframe）で実行 →
// 結果（成功・エラー・console の出力・絵のようす・重さ）をモデルに返す。エラーなら「直して」と返す。これを、止めるまで繰り返す。
// 何をするかは指示しない。プログラムは毎回上書き（前のものは止まり、キャンバスは消える）。残るのは memo だけ。
//
// - 推論は ../tinyswallow-chat/runner.js（Web Worker の Transformers.js）。Qwen3 の思考（<think>…</think>）を左に思考ログとして出す
// - 実行は ./sandbox.js（このページには触れない iframe）
// - 会話は、直近の数ステップだけをモデルに渡す（ずっと続けても文脈が伸びない）。思考の部分は履歴に入れない（Qwen3 の推奨）。
//   それより前のステップは「したこと」の1行ずつにまとめて渡す（覚えていないせいで、同じことを繰り返さないように）
// - 前のステップの知らせは短くして渡す（絵の縮小図などは、いまの知らせだけ）。入力を短くして、1 ステップを速くする
// - 重さ（フレーム数・draw にかかった時間・処理で埋まっている時間）を毎回伝え、重いときは軽くするよう促す。
//   重すぎる（固まりかけている）ときは、ページを初期化して伝える（観察できなくならないように）
// - 毎回同じことから始めたり、同じコードを繰り返したりしないよう、最初と繰り返しのときに「思いつきのたね」をいくつか見せる（使うかは自由）
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

const SYSTEM = `あなたは、ブラウザの中にある 640×480 のキャンバス 1 枚で、自由に遊ぶ AI です。誰からも指示はありません。
思うままに描いたり動かしたりして、いろいろなことを試してください（絵、模様、アニメーション、シミュレーション、小さなゲーム、計算の実験など、何でもかまいません）。

毎回、次の形で答えます:
1. いま何をしたいか、なぜか（1〜3文）
2. 実行する JavaScript を1つ、\`\`\`js と \`\`\` で囲んで書く

しくみ:
- 1 回のコードが 1 つのプログラムです。実行するたびに、前のプログラムは止まり、キャンバスは黒で消えます。前のものを育てるときは、前のコードを直して全体を書き直します
- 次のプログラムに残せるのは memo（オブジェクト）だけです（例: memo.best = 10）
- DOM（document・HTML の要素）は使えません。ネットワーク・localStorage・alert も使えません
- 1 回のコードは 60 行くらいまでにします

使える関数（座標は左上が 0, 0。W = 640、H = 480）:
- setup(() => {…}): 最初に 1 回 / draw((t, dt) => {…}): 毎フレーム（t は始まってからの秒、dt は前のフレームからの秒）
- background(色) / fill(色) / noFill() / stroke(色) / strokeWeight(太さ) / noStroke()
  色は 'red'・'#ff8800'・hsl(色相, 彩度, 明るさ)・rgb(r, g, b, 透明度)・fill(255, 0, 0) など
- circle(x, y, 半径) / ellipse(x, y, rx, ry) / rect(x, y, w, h) / line(x1, y1, x2, y2) / poly([[x, y], …]) / text(文字, x, y, 大きさ, 'left' か 'center')
- push() / pop() / translate(x, y) / rotate(角度) / scale(倍率)。ほかのことは ctx（Canvas 2D のコンテキスト）で
- random(a, b) / random(配列) / randInt(a, b) / noise(x, y, z)（なめらかな乱数 0〜1）/ lerp / map(v, a, b, c, d) / clamp / dist / PI / TAU
- mouse.x・mouse.y・mouse.down / keys.last・keys.isDown('ArrowLeft') / onClick((x, y) => {…}) / onKey((key) => {…})
- say('文字', …): キャンバスの左上に文字を出す（題名・点数・説明など）
- setTimeout・setInterval（同時に 20 個まで。絵の繰り返しは draw で）/ console.log（出力が返ってきます）

結果について:
- 実行の結果（成功・エラー・console の出力・絵のようす・重さ）が返ってきます。絵のようすは、キャンバスを 32×12 の文字に縮めた図（暗い ' ' 〜 明るい '@'）と、多い色と、動いているかです
- エラーが出たら、原因を考えて直します
- 同じことを繰り返さず、新しいことを試します。draw の 1 フレームは軽く（数 ms）保ちます`;

// 思いつきのたね（最初と、同じことを繰り返したときに、いくつか選んで見せる。使うかどうかはモデルの自由）
const SEEDS = [
  '時計', '迷路', 'ライフゲーム', '文字が踊る見出し', '色見本帳', '素数の模様', '小さなクイズ', 'タイピング練習', '万華鏡', 'フラクタルの木',
  '砂時計', '星座', '花火', '落ち物パズル', '噴水の粒', '折れ線グラフ', 'クリックで変わる景色', '詩の自動生成', '数当てゲーム', '波の模様',
  'ドット絵', '円周率の計算', '色相環', '並べ替え（ソート）の見える化', 'L システムの植物', 'ランダムウォーク', '歯車', '振り子', '雪の結晶', 'オーロラ',
  '鳥の群れ（ボイド）', '水面の波紋', '弾むボール', 'ローマ数字の変換', 'しりとり', 'じゃんけん', '物語の分かれ道', 'マウスを追いかける生き物', '重力のある砂', '炎',
  'ステンドグラス', '文字のモザイク', '数独', '天体の軌道', 'お絵かき帳', 'ピアノの鍵盤（音は出さない）', '暗号（シーザー暗号）', '迷子の蟻', '色の名前当て', '万歩計のようなカウンター',
];
const LOAD_SOFT = { drawMs: 20, busy: 0.35, fps: 30 }; // これを超えたら軽くするよう促す
const LOAD_HARD = { busy: 0.85 }; // 実行のあとこれを超えていたら、ページを初期化する
// 前のコードとの似ている度合いがこれ以上なら「ほとんど同じ」と伝える（プログラムは書き直して育てるので、高めにする）
const REPEAT_SIMILARITY = 0.95;
const HEALTH_LIMIT = { busy: 0.75, seconds: 5 }; // 実行していないときも、これが続いたらページを初期化する

export function pickSeeds(n = 3, rand = Math.random) {
  const pool = [...SEEDS];
  const out = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  return out;
}
const seedLine = (seeds) => `（思いつきのたね: ${seeds.join('・')}。使っても使わなくてもかまいません）`;
export const firstPrompt = (seeds = pickSeeds()) => `キャンバスは真っ黒です（まだ何も描いていません）。最初に何をしますか？\n${seedLine(seeds)}`;

/** 2つのコードの似ている度合い（空白を除いた2文字ずつの組の重なり。0〜1） */
export function similarity(a, b) {
  const grams = (t) => { const x = String(t).replace(/\s+/g, ''); const g = new Set(); for (let i = 0; i < x.length - 1; i++) g.add(x.slice(i, i + 2)); return g; };
  const A = grams(a), B = grams(b);
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const g of A) if (B.has(g)) both++;
  return both / (A.size + B.size - both);
}

/** ステップを1行にまとめる（説明の最初の文） */
export function brief(s) {
  const first = (s.say || '').split(/(?<=[。．！？!?])|\n/)[0].trim();
  const text = first || (s.code ? 'コードを実行' : '（何も書かなかった）');
  return (text.length > 50 ? text.slice(0, 50) + '…' : text) + (s.failed ? '（失敗）' : '');
}

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
  autoReset: null, // 重すぎてページを初期化した理由（次の知らせで伝える）
  heavySeconds: 0, // 重すぎる状態が続いている秒数
  inStep: false, // ステップ（生成・実行）の途中か
  errorStreak: 0,
};
sandbox.onNavigate = () => {
  state.navigated = true;
  sandbox.reset();
};
// 1 秒ごとの重さ: 表示し、重すぎる状態が続いたら（実行していないときも）ページを初期化する
sandbox.onHealth = (load) => {
  if (!load) return;
  $('load').textContent = [load.visible && load.fps > 0 ? `${load.fps} fps` : '', load.running ? `draw ${load.drawMs.toFixed(1)} ms` : '止まった絵', `負荷 ${Math.round(load.busy * 100)}%`].filter(Boolean).join('・');
  $('load').className = 'muted small' + (load.busy >= LOAD_SOFT.busy ? ' heavy' : '');
  state.heavySeconds = load.visible && load.busy >= HEALTH_LIMIT.busy ? state.heavySeconds + 1 : 0;
  if (state.heavySeconds >= HEALTH_LIMIT.seconds) {
    state.heavySeconds = 0;
    state.autoReset = `処理で埋まっている時間が ${HEALTH_LIMIT.seconds} 秒続けて ${Math.round(HEALTH_LIMIT.busy * 100)}% を超え、ページが固まりかけていた`;
    sandbox.reset();
    // ステップの途中でなければ、次のステップへの知らせを書き換える（途中なら、そのステップの知らせで伝える）
    const last = state.steps.at(-1);
    if (last && !state.inStep) {
      last.feedback = last.feedbackShort = `${autoResetLine(state.autoReset)}\n\n${seedLine(pickSeeds())}\n\n次は何をしますか？`;
      state.autoReset = null;
    }
    setStatus('ページが重すぎるので、初期化しました。', 'warn');
  }
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

/** 絵のようす（縮小図・多い色・動き・プログラムのようす） */
export function summarize(snap) {
  if (!snap) return '（絵のようすを取れませんでした）';
  const lines = [`絵（32×12 に縮めた図。暗い ' ' 〜 明るい '@'）:\n${snap.thumb.map((r) => `|${r}|`).join('\n')}`];
  if (snap.colors.length) lines.push(`多い色: ${snap.colors.map((c) => `${c.hex} ${c.pct}%`).join('、')}`);
  const blank = snap.thumb.every((r) => !r.trim()) && (snap.colors[0]?.pct ?? 0) >= 99;
  if (blank) lines.push('キャンバスは真っ黒のままです（何も見えていません）。');
  lines.push(`動き: ${snap.moving > 0 ? `0.5 秒で ${snap.moving}% が変わった（動いている）` : '変わらない（止まっている）'}`);
  const prog = [snap.hasSetup ? 'setup あり' : '', snap.drawStopped ? 'draw はエラーで止まった' : snap.hasDraw ? `draw あり（${snap.frames} フレーム）` : 'draw なし（止まった絵）'];
  if (snap.clicks) prog.push('クリックを受け取る');
  if (snap.keys) prog.push('キーを受け取る');
  lines.push(`プログラム: ${prog.filter(Boolean).join('、')}`);
  if (snap.say) lines.push(`say の文字: ${snap.say}`);
  return lines.join('\n');
}

/** 重さの1行 */
export function loadText(load) {
  if (!load) return '';
  const w = [];
  if (load.visible && load.fps > 0) w.push(`1 秒あたり ${load.fps} フレーム`);
  if (load.running) w.push(`draw 1 回 平均 ${load.drawMs.toFixed(1)} ms（最大 ${load.drawMsMax.toFixed(1)} ms）`);
  w.push(`処理で埋まっている時間 ${Math.round(load.busy * 100)}%`);
  if (load.timers) w.push(`タイマー ${load.timers} 個`);
  return `重さ: ${w.join('、')}`;
}

/** 重い理由（軽くするよう促す）。軽ければ空 */
export function heavyReasons(snap, load) {
  const r = [];
  if (load?.running && load.drawMs >= LOAD_SOFT.drawMs) r.push(`draw 1 回に平均 ${load.drawMs.toFixed(1)} ms かかっています`);
  if (load?.busy >= LOAD_SOFT.busy) r.push(`処理で埋まっている時間が ${Math.round(load.busy * 100)}% です`);
  else if (load?.visible && load.running && load.fps > 0 && load.fps < LOAD_SOFT.fps) r.push(`1 秒あたり ${load.fps} フレームしか出ていません`);
  return r;
}

/** 実行のあと、ページを初期化するほど重いか（理由。重くなければ null） */
export function tooHeavy(snap, load) {
  if (load?.busy >= LOAD_HARD.busy) return `処理で埋まっている時間が ${Math.round(load.busy * 100)}% になり、ページが固まりかけていた`;
  return null;
}

const autoResetLine = (why) => `ページが重すぎたので（${why}）、プログラムを止めてページを初期化しました（memo も消えました）。次は軽いものにしてください。`;

/**
 * 結果をモデルに返す文。short: 前のステップとして履歴に入れるときの短い形（絵のようすと重さを省く）
 */
export function feedbackFor(step, { errorStreak = 0, navigated = false, autoReset = null, repeatOf = null, seeds = null, short = false } = {}) {
  const lines = [];
  if (navigated) lines.push('ページが別のページへ移動しようとしたので、空のページに初期化しました（移動はできません）。');
  if (!step.code) {
    lines.push('コードが見つかりませんでした。必ず、実行する JavaScript を1つ ```js と ``` で囲んで書いてください。');
  } else if (step.result.timedOut) {
    lines.push('実行の結果が返ってきませんでした（無限ループや重すぎる処理の可能性があります）。ページを初期化しました（memo も消えました）。');
  } else {
    const r = step.result;
    const errs = [r.error, ...r.asyncErrors].filter(Boolean);
    if (errs.length) lines.push(`エラーが出ました:\n${errs.map((e) => `- ${e}`).join('\n')}\n原因を考えて、直してください。`);
    else lines.push('実行しました（エラーなし）。');
    if (r.logs.length) lines.push(`console の出力:\n${r.logs.join('\n')}`);
    if (!autoReset && !short) {
      lines.push(`${summarize(r.snapshot)}${r.load ? `\n${loadText(r.load)}` : ''}`);
      const heavy = heavyReasons(r.snapshot, r.load);
      if (heavy.length) {
        lines.push(`重くなっています（${heavy.join('、')}）。このままだと固まります。1 フレームで描く数を減らすか、計算を軽くしてください。`);
      }
    }
  }
  if (autoReset) lines.push(autoResetLine(autoReset));
  if (repeatOf) lines.push(`このコードは、ステップ ${repeatOf} のコードとほとんど同じです。違う種類のことも試してみてください。`);
  if (errorStreak >= 3) lines.push('失敗が続いています。同じやり方にこだわらず、別のやり方か、別のことを試してください。');
  if (seeds?.length && !short) lines.push(seedLine(seeds));
  lines.push('次は何をしますか？');
  return lines.join('\n\n');
}

/** 直近のステップより前に、したこと（古い順・1行ずつ）。無ければ空 */
export function olderHistory(all, recentCount = HISTORY_STEPS, max = 12) {
  const older = all.slice(0, Math.max(0, all.length - recentCount)).slice(-max);
  if (!older.length) return '';
  return `（参考: もっと前のステップでしたこと）\n${older.map((s) => `- ステップ ${s.n}: ${brief(s)}`).join('\n')}`;
}

/** モデルに渡す会話（system ＋ 直近のステップ ＋ いまの知らせ。いまの知らせには、もっと前にしたことを添える） */
function messagesFor(feedback) {
  const recent = state.steps.slice(-HISTORY_STEPS);
  const older = olderHistory(state.steps);
  if (older) feedback = `${older}\n\n${feedback}`;
  const msgs = [{ role: 'system', content: SYSTEM }];
  // 前のステップの知らせは短い形（絵のようすなどは、いまの知らせだけ）
  const past = (s) => s.promptShort ?? s.prompt;
  msgs.push({ role: 'user', content: recent.length ? past(recent[0]) : feedback });
  recent.forEach((s, i) => {
    msgs.push({ role: 'assistant', content: `${s.say}${s.code ? `\n\n\`\`\`js\n${s.code}\n\`\`\`` : ''}`.trim() || '（何も書かなかった）' });
    msgs.push({ role: 'user', content: i + 1 < recent.length ? past(recent[i + 1]) : feedback });
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
  state.inStep = true;
  try { await stepInner(); } finally { state.inStep = false; }
}

async function stepInner() {
  const n = (state.steps.at(-1)?.n ?? 0) + 1;
  const prev = state.steps.at(-1);
  // いまの知らせ（前のステップの結果。最初は「空のページ」）
  const prompt = prev ? prev.feedback : firstPrompt();
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
  const s = { n, prompt, promptShort: prev?.feedbackShort ?? prompt, think: parsed.think, say: parsed.say, code: parsed.code, result: null, el: view };
  // 実行
  if (parsed.code) {
    view.querySelector('.step-state').textContent = '実行しています…';
    s.result = await sandbox.run(parsed.code);
  } else {
    s.result = { error: null, asyncErrors: [], logs: [], snapshot: null, noCode: true };
  }
  const errs = [s.result.error, ...(s.result.asyncErrors ?? [])].filter(Boolean);
  const failed = !parsed.code || s.result.timedOut || errs.length > 0;
  s.failed = failed;
  state.errorStreak = failed ? state.errorStreak + 1 : 0;
  // 重すぎる: ページを初期化する
  const heavy = !s.result.timedOut && tooHeavy(s.result.snapshot, s.result.load);
  if (heavy) {
    state.autoReset = heavy;
    await sandbox.reset();
  }
  // 前のステップ（失敗の直し以外）とほとんど同じコードか
  let repeatOf = null;
  if (parsed.code && !prev?.failed) {
    for (const o of state.steps.slice(-8)) if (o.code && !o.failed && similarity(o.code, parsed.code) >= REPEAT_SIMILARITY) repeatOf = o.n;
  }
  const autoReset = state.autoReset;
  const fbOpts = { errorStreak: state.errorStreak, navigated: state.navigated, autoReset, repeatOf, seeds: repeatOf || autoReset ? pickSeeds() : null };
  s.feedback = feedbackFor(s, fbOpts);
  s.feedbackShort = feedbackFor(s, { ...fbOpts, short: true });
  state.navigated = false;
  state.autoReset = null;
  s.resultText = (!parsed.code ? 'コードなし' : s.result.timedOut ? '応答なし（ページを初期化した）' : errs.length ? `エラー: ${errs.join(' / ')}` : '成功')
    + (autoReset ? `（重すぎるので初期化: ${autoReset}）` : '');
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
  if (last) last.feedback = last.feedbackShort = 'ページを初期化しました（プログラムは止まり、キャンバスは真っ黒に戻り、memo も消えました）。\n\n次は何をしますか？';
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
  state, settings, sandbox, parseResponse, feedbackFor, messagesFor, summarize, heavyReasons, tooHeavy, similarity, olderHistory, firstPrompt,
  setGenerator: (fn) => { state.generator = fn; },
};
