const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (ms) => (ms / 1000).toFixed(1) + 's';

// CheerpJ が投げる例外オブジェクトは、そのまま文字列と連結すると
// "Cannot convert object to primitive value" になり、catch の中で再びエラーになる。
// message → stack → String() → JSON の順に試して、安全に文字列にする
function errText(e) {
  const tries = [
    () => e?.message,
    () => e?.stack,
    () => String(e),
    () => JSON.stringify(e),
    () => Object.prototype.toString.call(e),
  ];
  for (const f of tries) {
    try {
      const s = f();
      if (typeof s === 'string' && s && s !== '{}') return s;
    } catch { /* 次の方法を試す */ }
  }
  return '(内容を表示できない例外)';
}

// ---------------------------------------------------------------------------
// fetch ラッパ（相対パスなので GitHub Pages のサブパスでも動く）
// ---------------------------------------------------------------------------

async function api(method, path, body) {
  const started = performance.now();
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await fetch(path, init);
  const text = await res.text();
  const ms = performance.now() - started;

  let data = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* JSONでなければ文字列のまま */ }

  addLog(method, path, res.status, ms, res.headers.get('x-served-by'));
  return { res, data, text, ms };
}

// ---------------------------------------------------------------------------
// Service Worker 登録
// ---------------------------------------------------------------------------

function setBadge(id, label, text, kind) {
  const el = $(id);
  el.textContent = label + ': ' + text;
  el.className = 'badge ' + kind;
}

async function setupServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    setBadge('sw', 'Service Worker', '非対応のブラウザ', 'ng');
    return false;
  }
  try {
    await navigator.serviceWorker.register('./sw.js');
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      // 初回は clients.claim() で制御が移るのを少し待つ
      await Promise.race([
        new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true })),
        sleep(1500),
      ]);
    }
    if (navigator.serviceWorker.controller) {
      setBadge('sw', 'Service Worker', '有効', 'ok');
      return true;
    }
    setBadge('sw', 'Service Worker', '未制御 (一度リロードしてください)', 'ng');
    return false;
  } catch (e) {
    console.error(e);
    setBadge('sw', 'Service Worker', '登録失敗: ' + errText(e), 'ng');
    return false;
  }
}

/** Service Worker へ知らせる（返事はいらない） */
async function tellWorker(type) {
  try {
    // pagehide の中でも届くよう、制御中の Service Worker があればその場で送る
    const controller = navigator.serviceWorker.controller;
    if (controller) controller.postMessage({ type });
    else (await navigator.serviceWorker.ready).active?.postMessage({ type });
  } catch (e) {
    console.error(e);
  }
}

/** Service Worker に聞く（MessageChannel で返事をもらう） */
async function askWorker(type) {
  const active = (await navigator.serviceWorker.ready).active;
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (e) => resolve(e.data);
    active.postMessage({ type }, [channel.port2]);
    setTimeout(() => resolve(null), 2000);
  });
}

// ---------------------------------------------------------------------------
// バックエンド: CheerpJ 上の Spring Boot
// ---------------------------------------------------------------------------

// CheerpJ の /app/ は Web サーバーのルートを指す。
// GitHub Pages のサブパス(/<repo>/toys/…)でも読めるよう、このページの URL パスから組み立てる
const jarPath = new URLSearchParams(location.search).get('jar')
  || '/app' + new URL('probe.jar', location.href).pathname;

// idle / booting / ready / failed
let state = 'idle';
let Bridge = null;
// ランタイムや jar の段階で失敗すると、同じページの CheerpJ は使えなくなる
// （ライブラリはページごとに1回しか読めず、"Only one library thread supported" になる）。
// そのときの再試行は、ページの読み込み直しで行う
let needsReload = false;

function setState(next) {
  state = next;
  const labels = { idle: ['停止中', ''], booting: ['起動中…', ''], ready: ['実行中', 'ok'], failed: ['起動失敗', 'ng'] };
  setBadge('backend', 'Spring', ...labels[next]);
  $('boot').disabled = next === 'booting' || next === 'ready';
  $('boot').textContent = next !== 'failed' ? '起動する'
    : needsReload ? 'ページを読み込み直して再試行' : '再試行する';
}

function setStep(name, cls, text = '') {
  const li = document.querySelector(`#steps [data-step="${name}"]`);
  li.className = cls;
  li.querySelector('.time').textContent = text;
}

/** 時間を計りながら1段階を実行する */
async function step(name, fn) {
  setStep(name, 'run', '実行中…');
  const t = performance.now();
  try {
    const result = await fn();
    setStep(name, 'ok', fmt(performance.now() - t));
    return result;
  } catch (e) {
    setStep(name, 'err', fmt(performance.now() - t));
    throw e;
  }
}

async function boot() {
  if (state === 'booting' || state === 'ready') return;
  if (needsReload) {
    location.reload();
    return;
  }
  setState('booting');
  $('error').hidden = true;
  tellWorker('backend-booting');
  try {
    // ランタイムと jar は、成功していれば再試行のときは飛ばす（Spring の初期化だけやり直す）
    if (!Bridge) {
      needsReload = true;
      await step('runtime', () => cheerpjInit({ version: 11, status: 'none' }));
      Bridge = await step('jar', async () => (await cheerpjRunLibrary(jarPath)).demo.Bridge);
      needsReload = false;
    }
    await step('spring', async () => {
      const r = JSON.parse(String(await Bridge.start()));
      if (!r.ok) throw new Error('Spring の起動に失敗しました\n' + r.error);
    });
    setState('ready');
    await tellWorker('backend-ready');
    await showRole();
    await refresh();
  } catch (e) {
    console.error(e);
    tellWorker('backend-failed');
    $('error').hidden = false;
    $('error').textContent = errText(e) + '\n\n' + (needsReload
      ? `jar（${jarPath}）を読み込めませんでした。パスが正しいか、`
        + 'サーバーが HTTP の Range リクエストに対応しているか確認してください'
        + '（CheerpJ に必要。Python の http.server は非対応）。詳しくはブラウザのコンソールを見てください。'
      : 'Spring の初期化に失敗しました。上のスタックトレースが原因です。');
    setState('failed');
  }
}

/** このタブが API の宛先になっているかを表示する */
async function showRole() {
  const info = await askWorker('backend-info');
  if (!info) return;
  $('role').textContent = info.backendId === info.you
    ? 'このタブの Spring が API に答えています'
    : '別のタブの Spring が API に答えています（このタブの Spring は予備）';
}

// Java の呼び出しは1件ずつ順番に行う
let queue = Promise.resolve();
function serial(fn) {
  const p = queue.then(fn);
  queue = p.catch(() => {});
  return p;
}

/** Service Worker から転送されてきたリクエストを Spring に渡す */
async function handleRequest({ method, path, body }) {
  if (state !== 'ready') return { error: 'not-ready' };
  try {
    return JSON.parse(String(await serial(() => Bridge.dispatch(method, path, body ?? ''))));
  } catch (e) {
    // Java 側では例外を 500 にして返すので、ここに来るのは CheerpJ レベルの失敗
    return {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ error: 'bridge_error', message: errText(e) }),
    };
  }
}

navigator.serviceWorker?.addEventListener('message', async (event) => {
  const port = event.ports[0];
  if (!port) return;
  const { type } = event.data ?? {};
  if (type === 'backend-status') port.postMessage({ state });
  if (type === 'api-request') port.postMessage(await handleRequest(event.data));
});
// メッセージの受け取りを始める（読み込み完了を待たずに転送を受けられるように）
navigator.serviceWorker?.startMessages();

addEventListener('pagehide', () => tellWorker('backend-stopped'));

// ---------------------------------------------------------------------------
// ログ
// ---------------------------------------------------------------------------

function addLog(method, path, status, ms, servedBy) {
  const li = document.createElement('li');
  const t = new Date().toLocaleTimeString('ja-JP', { hour12: false });
  li.textContent = t + '  ' + method + ' /' + path.replace(/^\//, '') + ' → ' + status
    + ' (' + ms.toFixed(1) + 'ms' + (servedBy ? ', ' + servedBy : '') + ')';
  if (status >= 500) li.className = 'err';
  const log = $('log');
  log.prepend(li);
  while (log.children.length > 12) log.lastChild.remove();
}

// ---------------------------------------------------------------------------
// Todoアプリ（APIの利用側）
// ---------------------------------------------------------------------------

async function refresh() {
  const { data } = await api('GET', 'api/todos');
  if (!Array.isArray(data)) return; // バックエンドが動いていない場合など
  $('list').replaceChildren(...data.map(renderTodo));
  $('empty').hidden = data.length > 0;
}

function renderTodo(todo) {
  const li = document.createElement('li');
  li.className = todo.done ? 'done' : '';

  const check = document.createElement('input');
  check.type = 'checkbox';
  check.checked = todo.done;
  check.style.flex = '0 0 auto';
  check.addEventListener('change', async () => {
    await api('PATCH', 'api/todos/' + todo.id, { done: check.checked });
    await refresh();
  });

  const title = document.createElement('span');
  title.textContent = todo.title; // ユーザー入力なので textContent で挿入

  const del = document.createElement('button');
  del.className = 'ghost';
  del.textContent = '削除';
  del.addEventListener('click', async () => {
    await api('DELETE', 'api/todos/' + todo.id);
    await refresh();
  });

  li.append(check, title, del);
  return li;
}

$('add').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('title');
  const title = input.value.trim();
  if (!title) return;
  await api('POST', 'api/todos', { title });
  input.value = '';
  await refresh();
});

// ---------------------------------------------------------------------------
// APIコンソール
// ---------------------------------------------------------------------------

const PRESETS = [
  { label: '一覧', method: 'GET', path: 'api/todos' },
  { label: '未完了のみ', method: 'GET', path: 'api/todos?done=false' },
  { label: '検索', method: 'GET', path: 'api/todos?q=api' },
  { label: '作成', method: 'POST', path: 'api/todos', body: '{"title":"Springが受け取ったTodo"}' },
  { label: '1件取得', method: 'GET', path: 'api/todos/1' },
  { label: '更新(PATCH)', method: 'PATCH', path: 'api/todos/1', body: '{"done":true}' },
  { label: '削除', method: 'DELETE', path: 'api/todos/1' },
  { label: '不正なボディ', method: 'POST', path: 'api/todos', body: '{"title":""}' },
  { label: '存在しないID', method: 'GET', path: 'api/todos/9999' },
  { label: 'health', method: 'GET', path: 'api/health' },
  { label: 'サンプル投入', method: 'POST', path: 'api/_reset' },
];

for (const p of PRESETS) {
  const b = document.createElement('button');
  b.className = 'ghost';
  b.textContent = p.label;
  b.addEventListener('click', () => {
    $('method').value = p.method;
    $('path').value = p.path;
    $('reqbody').value = p.body ?? '';
    sendConsole();
  });
  $('presets').appendChild(b);
}

async function sendConsole() {
  const method = $('method').value;
  const path = $('path').value.trim();
  const raw = $('reqbody').value.trim();
  const body = raw && method !== 'GET' && method !== 'DELETE' ? raw : undefined;

  const status = $('status');
  status.textContent = '…';
  status.className = 'code';
  $('time').textContent = state === 'booting' ? 'Spring の起動を待っています' : '';
  try {
    const { res, data, ms } = await api(method, path, body);
    status.textContent = res.status + ' ' + (res.statusText || '');
    status.className = 'code ' + (res.ok ? 'ok' : 'err');
    $('time').textContent = ms.toFixed(1) + ' ms';
    $('headers').textContent = [...res.headers.entries()].map(([k, v]) => k + ': ' + v).join('\n');
    $('body').textContent = typeof data === 'string' ? data : JSON.stringify(data, null, 2) ?? '';
  } catch (e) {
    status.textContent = 'ERROR';
    status.className = 'code err';
    $('body').textContent = errText(e);
  }
  if (state === 'ready') await refresh(); // コンソールで変更した内容をTodo側にも反映
}

$('send').addEventListener('click', sendConsole);
$('boot').addEventListener('click', boot);

// ---------------------------------------------------------------------------

(async () => {
  setState('idle');
  if (!(await setupServiceWorker())) return;
  if (typeof cheerpjInit !== 'function') {
    setState('failed');
    $('error').hidden = false;
    $('error').textContent = 'CheerpJ のローダー（cjrtnc.leaningtech.com）を読み込めませんでした。ネットワークを確認してください。';
    return;
  }
  await boot();
})();
