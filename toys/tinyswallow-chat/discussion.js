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
  // 1回の発言の長さの目安（文字数）。これを超えて文が終わったら、そこで区切る（小さなモデルは「3〜6文で」を守らず、
  // 長い箇条書きになりがち。長い発言は相手にまねされ、議論が計画づくりに流れる）
  chars: 300,
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
    chars: num(s.chars, DEFAULTS.chars, 50, 3000),
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
  ['chars', 'chars-out', 'chars', (v) => `${v} 文字`],
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
  agenda: [], // 裏の司会の論点
  agendaPos: 0, // 今の論点の位置
  repeatWarning: false, // 直前の発言が繰り返しだったか（次の発言で注意する）
  modLog: [], // 裏の司会の記録（自動テスト用。画面には出さない）
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

/**
 * 議題から、対立する2つの考えを取り出す（立場を自動で割り当てるため）。取り出せなければ null。
 *   「ご飯は三食がいいか二食がいいか」→ ['三食', '二食']
 *   「朝型と夜型、どちらがよいか」→ ['朝型', '夜型']
 *   「猫派 vs 犬派」→ ['猫派', '犬派']
 */
export function splitTopic(topic) {
  const t = topic.trim().replace(/[？?。.！!]+$/, '');
  // 「ご飯は三食」のような主題（〜は）を外す。「朝ごはん」のような語の中の「は」では切らない
  // （「は」の前がひらがなでなく、前後とも2文字以上のときだけ）
  const tidy = (x) => {
    let v = x.trim().replace(/(の方|のほう)$/, '');
    const i = v.lastIndexOf('は');
    if (i >= 2 && v.length - i - 1 >= 2 && !/[\u3041-\u309f]/.test(v[i - 1])) v = v.slice(i + 1);
    return v.replace(/^[、,\s]+/, '').trim();
  };
  const pick = (x, y) => {
    const a = tidy(x), b = tidy(y);
    return a && b && a !== b && a.length <= 30 && b.length <= 30 ? [a, b] : null;
  };
  let m = /^(.+?)(?:の方|のほう)?(?:が|は)?(?:いい|良い|よい|優れている|向いている|べき)か(?:、|,)?\s*(.+?)(?:の方|のほう)?(?:が|は)?(?:いい|良い|よい|優れている|向いている|べき)か$/.exec(t);
  if (m) return pick(m[1], m[2]);
  m = /^(.+?)(?:と|か)(.+?)(?:、|,)?\s*(?:どちら|どっち)/.exec(t);
  if (m) return pick(m[1], m[2]);
  m = /^(.+?)\s*(?:vs\.?|ＶＳ|対)\s*(.+)$/i.exec(t);
  if (m) return pick(m[1], m[2]);
  // 「AI に人権は必要か否か」「〜かどうか」→ 「AI に人権は必要」・「AI に人権は必要とは言えない」
  m = /^(.+?)(?:か否か|かどうか)$/.exec(t);
  if (m && m[1].trim().length <= 40) return [m[1].trim(), `${m[1].trim()}とは言えない`];
  return null;
}

/** 司会の念押しで使う立場（書いたもの、または議題から取り出した考え） */
function stanceForReminder(speaker) {
  const own = state.snapshot.stances[speaker].trim();
  if (own) return `「${own.length > 40 ? own.slice(0, 40) + '…' : own}」の立場`;
  const pair = splitTopic(state.snapshot.topic);
  return pair ? `「${pair[speaker]}」派` : speaker === 0 ? '先に挙がっている考えの側' : 'その反対の側';
}

/** 画面に出す短い立場（自分で書いたもの、または自動で割り当てたもの） */
function stanceShort(speaker) {
  const own = state.snapshot.stances[speaker].trim();
  if (own) return own.length > 30 ? own.slice(0, 30) + '…' : own;
  const pair = splitTopic(state.snapshot.topic);
  return pair ? `${pair[speaker]}（自動）` : speaker === 0 ? '先に挙がった考え（自動）' : '反対の考え（自動）';
}

/** 立場。空なら、議題から取り出した2つの考えを A と B に割り当てる（同意し合って議論が進まないのを防ぐ） */
function stanceOf(speaker) {
  const s = state.snapshot;
  const own = s.stances[speaker].trim();
  if (own) return own;
  const pair = splitTopic(s.topic);
  const other = s.names[1 - speaker];
  if (pair) return `「${pair[speaker]}」を支持する（「${pair[1 - speaker]}」には反対。どちらとも言えない、とはしない）`;
  return speaker === 0
    ? '議題で先に挙がっている考えを支持する（どちらとも言えない、とはしない）'
    : `${other}と反対の考え（議題で後に挙がっている考え）を支持する（どちらとも言えない、とはしない）`;
}

// ---------------------------------------------------------------- 裏の司会（画面には出さない）
//
// - 始める前に、議題を5つほどの論点に分ける（モデルに頼む。うまく取り出せなければ、決まった論点の並びを使う）
// - 1往復（A と B）ごとに次の論点へ進む。発言のたびに「今の論点」を伝える（脱線・同じ話の堂々巡りを防ぐ）
// - 直前の発言が、それまでの発言とほとんど同じなら（千日手）、次の論点へ早めに進め、「繰り返さない」と伝える

const FALLBACK_AGENDA = ['判断の前提となる考え方', '利点や得られるもの', '問題点やリスク', '具体的な場面や例', '相手の主張の弱いところ', 'これから先どうなるか'];

/** モデルの出力から論点を取り出す（番号・記号を外し、短いものだけ。3つ未満なら null） */
function parseAgenda(text) {
  const items = [];
  for (const raw of String(text).split('\n')) {
    const l = raw.replace(/^\s*(?:[-*・•]|\d+[.)．、]|[（(]?\d+[）)])\s*/, '').replace(/\*\*/g, '').replace(/[。．.]$/, '').trim();
    if (l.length >= 2 && l.length <= 30 && !/論点|議題|以下|次の/.test(l) && !items.includes(l)) items.push(l);
    if (items.length >= 6) break;
  }
  return items.length >= 3 ? items : null;
}

/** 議題を論点に分ける（A のモデルに頼む。画面には出さない） */
async function makeAgenda() {
  const s = state.snapshot;
  const runner = state.runners.get(s.models[0]);
  let text = '';
  try {
    await runner.generate([
      { role: 'system', content: 'あなたは討論の司会者です。' },
      { role: 'user', content: `議題「${s.topic}」について、2人の討論で順に扱う論点を5つ、それぞれ15文字以内の短い言葉で、1行に1つずつ挙げてください。説明や前置きは書かないでください。` },
    ], { max_new_tokens: 96, temperature: 0.3, top_p: 0.9, repetition_penalty: 1.1 }, 1024, (t) => { text += t; });
  } catch (e) {
    console.info('論点を作れなかった:', e.message);
  }
  const parsed = parseAgenda(text);
  console.info('裏の司会の論点:', parsed ?? `（取り出せないので決まった並び）${text}`);
  return parsed ?? FALLBACK_AGENDA;
}

/** 2つの文章の似ている度合い（文字の2つ組の Jaccard 係数。0〜1） */
function similarity(a, b) {
  const grams = (x) => { const t = x.replace(/[\s、。・「」]/g, ''); const g = new Set(); for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2)); return g; };
  const A = grams(a), B = grams(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const x of A) if (B.has(x)) n++;
  return n / (A.size + B.size - n);
}
const REPEAT_THRESHOLD = 0.45;

const currentPoint = () => state.agenda[state.agendaPos % state.agenda.length];

/** 裏の司会の言葉（話す人に、今の論点と話し方を伝える） */
function moderatorLine(speaker) {
  const s = state.snapshot;
  const me = s.names[speaker], other = s.names[1 - speaker];
  const first = state.turns.length === 0;
  const parts = [
    `司会: ${me}さんは${stanceForReminder(speaker)}、${other}さんは${stanceForReminder(1 - speaker)}です。今の論点は「${currentPoint()}」です。`,
    state.repeatWarning ? '直前の発言は、それまでの主張の繰り返しでした。同じ内容は二度と言わないでください。' : '',
    first
      ? `${me}さん、この論点について、自分の立場をはっきり言ってから、理由を述べてください。`
      : `${me}さん、この論点について、自分の立場から、今の${other}さんの発言に反論してください（${other}さんの側の考えを勧めないでください）。`,
    '新しい理由か具体例を1つ出し、前に言ったことは繰り返さないでください。',
    `議題「${s.topic}」から離れず、一人称は「私」で、箇条書きや見出しを使わずに、話し言葉で3〜5文でお願いします。`,
  ];
  return parts.filter(Boolean).join('');
}

/** 発言のあと、裏の司会が次の進め方を決める（論点を進める・繰り返しを注意する） */
function afterTurn(turn) {
  const before = state.turns.slice(0, -1);
  const sim = before.length ? Math.max(...before.map((t) => similarity(turn.text, t.text))) : 0;
  turn.similarity = sim;
  state.repeatWarning = sim >= REPEAT_THRESHOLD;
  // 1往復（B が話し終えた）ごとに、または繰り返しになったら、次の論点へ
  if (turn.speaker === 1 || state.repeatWarning) state.agendaPos++;
  state.modLog.push({ turn: state.turns.length, similarity: Number(sim.toFixed(2)), repeat: state.repeatWarning, nextPoint: currentPoint() });
}

/**
 * 話す人（speaker）から見た会話。自分の発言は assistant、相手の発言は user（相手の名前を付ける）。
 * 最初の人には、司会の言葉（議論の始まり）を user として渡す。
 * 小さなモデルは「ユーザーを手伝う AI アシスタント」としてふるまいがちなので、討論の台本を演じることと、ルールを system ではっきり書く
 */
function messagesFor(speaker) {
  const s = state.snapshot;
  const me = s.names[speaker], other = s.names[1 - speaker];
  const system = [
    `これは2人の討論です。あなたは討論者「${me}」を演じ、相手の「${other}」と議論します。`,
    `議題: ${s.topic}`,
    `${me}の立場: ${stanceOf(speaker)}`,
    'ルール:',
    `- ${me}として、相手の${other}に向けて話す。司会・聞き手・読者・ユーザーには話しかけない`,
    '- 最初の発言では、まず自分の立場をはっきり言ってから、理由を述べる',
    '- 自分の立場を最後まで守る。相手の意見の弱いところを具体的に指摘して反論し、安易に同意したりほめたりしない',
    '- 毎回、新しい論点か具体例を1つ以上出す。前に言ったことを繰り返さない。議論をまとめて終わらせない',
    '- 一人称は「私」。自分を名前で呼ばない',
    '- 話し言葉で3〜6文。見出し・箇条書き・太字は使わない。自分の名前や「（以上）」は書かない',
    '- AI であることや、アシスタントとしての申し出（「質問があればどうぞ」など）は書かない',
  ].join('\n');
  const list = [];
  const push = (role, content) => {
    const last = list.at(-1);
    if (last?.role === role) last.content += '\n\n' + content;
    else list.push({ role, content });
  };
  if (speaker === 0) push('user', `司会: これから「${s.topic}」について討論を始めます。`);
  for (const t of state.turns) {
    if (t.speaker === speaker) push('assistant', t.text || '（発言なし）');
    else push('user', `${other}: ${t.text || '（発言なし）'}`);
  }
  // 裏の司会（画面には出さない）: 毎回、相手の発言のすぐあとに、立場・今の論点・話し方を伝える。
  // system は会話が長くなると遠くなり、小さなモデルは直前の流れ（相手の箇条書き・別の話題・同じ主張の繰り返し）に引きずられるため
  if (list.at(-1)?.role === 'user') list.at(-1).content += '\n\n' + moderatorLine(speaker);
  return [{ role: 'system', content: system }, ...list];
}

/**
 * 発言のあと始末: 先頭の自分の名前を外し、次の発言（「user」「assistant」の行・相手の名前で始まる行）まで書いていたら、そこで切る。
 * 「（以上）」の行も外す
 */
function cleanTurn(text, speaker) {
  const s = state.snapshot;
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const me = esc(s.names[speaker]), other = esc(s.names[1 - speaker]);
  let t = text.replace(new RegExp(`^\\s*(【${me}】|${me}(?:さん)?\\s*[:：])\\s*`), '');
  // 頭の「相手の名前：」（台本のような書き方）も外す
  t = t.replace(new RegExp(`^\\s*${other}(?:さん)?\\s*[:：]\\s*`), '');
  // 一人称は「私」にそろえる: 自分を名前で呼んだところと、「僕・俺・わたくし・あたし・わたし」
  t = t.replace(new RegExp(`(?:私)?${me}(?:さん)?(?:自身)?(?=は|が|の|も|に|を|と|として|、)`, 'g'), '私');
  t = t.replace(/(?:僕|俺|わたくし|あたし|わたし)(?=は|が|の|も|に|を|と|、|。|自身)/g, '私');
  const lines = t.split('\n');
  const cut = lines.findIndex((l, i) => i > 0 && (/^\s*(user|assistant|system)\s*$/i.test(l) || new RegExp(`^\\s*(【${other}】|${other}\\s*[:：]|司会\\s*[:：])`).test(l)));
  if (cut > 0) lines.length = cut;
  t = lines
    .filter((l) => !/^\s*[（(]以上[）)]\s*$/.test(l))
    // 見出し（## …）の行は外し、太字（**…**）は印だけ外す（発言なので、話し言葉の本文だけを残す）
    .filter((l) => !/^\s*#{1,6}\s/.test(l))
    .map((l) => l.replace(/\*\*(.+?)\*\*/g, '$1'))
    // 箇条書きの印は「・」に（引用の > も外す）
    .map((l) => l.replace(/^\s*(?:[*\-•]|\d+[.)．])\s+/, '・').replace(/^\s*>\s?/, ''))
    // 発言の頭だけが「・」なら（箇条書きではない）、印を外す
    .map((l, i, all) => (i === 0 && l.startsWith('・') && all.filter((x) => x.startsWith('・')).length === 1 ? l.slice(1) : l))
    .join('\n')
    // 「私は AI として…」のような文は外す（討論者を演じているので）
    .replace(/[^。！？!?\n]*(?:私は(?:あくまで)?AI|AIとして|AIなので|AIアシスタント|言語モデルとして)[^。！？!?\n]*[。！？!?]?/g, '')
    .trim();
  // 最後の段落が、アシスタントとしての申し出（「何かあればお知らせください」など）だけなら外す
  const paras = t.split(/\n\s*\n/);
  if (paras.length > 1 && /(お知らせください|お聞かせください|聞いてください|ご連絡ください|お気軽に|質問があれば|お手伝いできる|ご参考までに)[！!。.]?\s*$/.test(paras.at(-1)) && paras.at(-1).length <= 80) {
    paras.pop();
  }
  // それまでの発言（自分・相手）と同じ段落は外す（「次回の議論では…」のような決まり文句を、毎回まねて繰り返すのを防ぐ）
  const norm = (x) => x.replace(/[\s・、。，．,.！!？?「」『』（）()]/g, '');
  const seen = new Set(state.turns.flatMap((x) => x.text.split(/\n\s*\n|\n/).map(norm)).filter((x) => x.length >= 12));
  const kept = [];
  for (const para of paras) {
    const lines = para.split('\n').filter((l) => {
      const n = norm(l);
      if (n.length >= 12 && seen.has(n)) return false;
      if (n.length >= 12) seen.add(n);
      return true;
    });
    if (lines.join('').trim()) kept.push(lines.join('\n'));
  }
  // 全部が前と同じだったときは、外さずに残す（空の発言にしない）
  return (kept.length ? kept : paras).join('\n\n').trim();
}

/** 長さの目安で区切ったとき、最後の文の終わり（。！？）までにする（途中の文を残さない） */
function trimToSentence(text, min) {
  const m = [...text.matchAll(/[。！？!?]/g)].map((x) => x.index).filter((i) => i >= min);
  return m.length ? text.slice(0, m.at(-1) + 1) : text;
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
  $('topic-view').textContent = `議題: ${topic}　／　立場: ${state.snapshot.names[0]}「${stanceShort(0)}」・${state.snapshot.names[1]}「${stanceShort(1)}」`;
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
  // 裏の司会: 議題を論点に分ける（画面には出さない）
  state.agenda = FALLBACK_AGENDA;
  state.agendaPos = 0;
  state.repeatWarning = false;
  state.modLog = [];
  setStatus('準備しています…');
  state.agenda = await makeAgenda();
  if (state.phase !== 'loading') return; // 準備の間に「最初から」など
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
    let capped = false; // 長さの目安で区切ったか
    try {
      done = await runner.generate(messagesFor(speaker), {
        max_new_tokens: settings.max_new_tokens,
        temperature: settings.temperature,
        top_p: 0.9,
        repetition_penalty: 1.1,
      }, Math.max(256, CONTEXT_LIMIT - settings.max_new_tokens), (text) => {
        turn.text += text;
        view.querySelector('.text').textContent = turn.text;
        // 長さの目安を超えて文が終わったら（または目安の1.5倍を超えたら）、そこで区切る
        if (!capped && turn.text.length >= settings.chars && (/[。！？!?]\s*$/.test(turn.text) || turn.text.length >= settings.chars * 1.5)) {
          capped = true;
          runner.interrupt();
        }
        if (state.phase === 'running') {
          setStatus(`${s.names[speaker]} が話しています…（${state.turns.length + 1} / ${settings.turns}）${state.pauseRequested ? '。いまの発言が終わったところで、一時停止します' : ''}`);
        }
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
    if (capped) turn.text = trimToSentence(turn.text, Math.floor(settings.chars * 0.5));
    turn.text = cleanTurn(turn.text, speaker);
    view.querySelector('.text').textContent = turn.text || '（発言なし）';
    const meta = [];
    if (capped) meta.push('長さの目安で区切り');
    else if (done.interrupted) meta.push('途中で停止');
    if (done.tokens) meta.push(`${done.tokens} トークン`);
    if (done.tokensPerSec) meta.push(`${done.tokensPerSec.toFixed(1)} トークン/秒`);
    if (done.dropped) meta.push(`古い発言 ${done.dropped} 件を除いて生成`);
    view.append(el('span', 'meta', meta.join('・')));
    state.turns.push(turn);
    afterTurn(turn);
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
window.__discussion = { state, settings, messagesFor, cleanTurn, splitTopic, trimToSentence, parseAgenda, similarity, moderatorLine };
